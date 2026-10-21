import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ProgressReport, RenderJob, RenderResult } from '../job.ts';
import { config } from './config.ts';
import {
  audioArgs,
  container,
  decodeArgs,
  FPS_RATIOS,
  fpsFilter,
  pixelFormat,
  settingsOf,
  videoArgs,
} from './encode.ts';
import { JobError } from './errors.ts';
import { NETWORK_INPUT, run, seconds } from './ffmpeg.ts';
import { objectUrl, originalInput, putFile, putJson } from './io.ts';

/**
 * What libass draws with where a style's font isn't there or has no glyph: the face subs.rocks's
 * editor falls back to too, one of the built-in fonts, so a render draws what the preview drew.
 */
export const FALLBACK_FAMILY = 'WenQuanYi Micro Hei';
/** How often a render's progress is written; the project page asks every 2 s. */
const PROGRESS_EVERY_MS = 5_000;
/** An estimate of the time left needs this much of the encode behind it. */
const ESTIMATE_AFTER = { fraction: 0.02, ms: 5_000 };
/** Bounds on what a render reports, whatever the file asks for. */
const MAX_FACES = 50;
const MAX_MISSING = 100;

/**
 * What libass says about fonts as it draws (ffmpeg's `info` level), parsed as the lines stream:
 * each face it picks (`fontselect: (Family, 700, 0) -> path, index, PostScriptName`) and each
 * character no font has (`failed to find any fallback with glyph 0x13000`), which comes out as a
 * box. The render's own record of what it drew with, which the preview can't vouch for.
 */
export class FontReport {
  // Family names can be any script, and a chunk can end mid-character.
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private readonly faces = new Set<string>();
  private readonly missing = new Set<string>();

  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  finish(): { faces: string[]; missingGlyphs: string[] } {
    this.buffer += this.decoder.end();
    if (this.buffer) this.line(this.buffer);
    this.buffer = '';
    return { faces: [...this.faces], missingGlyphs: [...this.missing] };
  }

  private line(line: string): void {
    const picked = /fontselect: \(.*\) -> (.*), \d+, (.+)$/.exec(line);
    if (picked && this.faces.size < MAX_FACES) {
      const [, path = '', postscript = ''] = picked;
      // A face without a PostScript name is known by its file.
      this.faces.add(postscript === '(none)' ? (path.split('/').at(-1) ?? path) : postscript);
    }
    const lost = /failed to find any fallback with glyph 0x([0-9a-f]+)/i.exec(line);
    if (lost?.[1] && this.missing.size < MAX_MISSING) {
      const code = Number.parseInt(lost[1], 16);
      if (code <= 0x10ffff) this.missing.add(String.fromCodePoint(code));
    }
  }
}

async function download(key: string, path: string): Promise<void> {
  const response = await fetch(objectUrl(key));
  if (!response.ok) {
    throw new JobError('processing_failed', `reading ${key} failed: HTTP ${response.status}`, true);
  }
  await writeFile(path, new Uint8Array(await response.arrayBuffer()));
}

/**
 * ffmpeg's `-progress` output (blocks of `key=value` lines, two a second) as the share of the
 * output written, handed to `write` every few seconds with an estimate of the time left.
 * Best-effort: a write that fails is skipped, never the encode, and one at a time.
 */
export class EncodeProgress {
  private readonly durationMs: number;
  private readonly write: (progress: ProgressReport) => Promise<void>;
  private readonly clock: () => number;
  private readonly started: number;
  private buffer = '';
  private lastWrite = Number.NEGATIVE_INFINITY;
  private writing: Promise<void> | null = null;

  constructor(
    durationMs: number,
    write: (progress: ProgressReport) => Promise<void>,
    clock: () => number = Date.now,
  ) {
    this.durationMs = durationMs;
    this.write = write;
    this.clock = clock;
    this.started = clock();
  }

  push(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      // `N/A` until the first frame is out.
      const done = /^out_time_us=(\d+)$/.exec(line.trim())?.[1];
      if (done) this.update(Math.min(1, Number(done) / 1000 / this.durationMs));
    }
  }

  /** Waits for a write in flight, so none lands after the job is done. */
  async settle(): Promise<void> {
    await this.writing;
  }

  private update(fraction: number): void {
    const now = this.clock();
    if (this.writing || now - this.lastWrite < PROGRESS_EVERY_MS) return;
    this.lastWrite = now;
    const elapsed = now - this.started;
    const remainingMs =
      fraction >= ESTIMATE_AFTER.fraction && elapsed >= ESTIMATE_AFTER.ms
        ? Math.round((elapsed * (1 - fraction)) / fraction)
        : null;
    this.writing = this.write({ fraction, remainingMs })
      .catch(() => undefined)
      .finally(() => {
        this.writing = null;
      });
  }
}

/**
 * A fontconfig of this render's fonts only: libass finds the template's fonts and falls back to
 * the preview's fallback, never to whatever the machine has installed, so a render draws exactly
 * what the preview drew.
 */
function fontsConf(fontsDir: string, cacheDir: string): string {
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontsDir}</dir>
  <cachedir>${cacheDir}</cachedir>
  <alias><family>sans-serif</family><prefer><family>${FALLBACK_FAMILY}</family></prefer></alias>
  <alias><family>serif</family><prefer><family>${FALLBACK_FAMILY}</family></prefer></alias>
</fontconfig>
`;
}

/** libass on the frames: the job's `subtitles.ass`, with the fonts `renderFonts` put in place. */
export const SUBTITLES_FILTER = 'ass=filename=subtitles.ass:fontsdir=fonts';

/** The frames of a render cut into pieces that one encode makes. */
export type PieceFrames = { startFrame: number; endFrame: number };

/**
 * The video filters: frames onto the canonical timeline, at the render's frame rate when it sets
 * one, on its grid when it has one (frame `n` at `n / fps`, so `trim` counts them exactly),
 * scaled to fit the frame (subtitles are drawn at the output's size, so they stay sharp), the
 * subtitles, then letterboxed, in the encoder's pixel format. A `piece` keeps its frames only and
 * starts at zero; its subtitles are drawn on the render's timeline, as the whole would draw them.
 */
export function renderFilter(job: RenderJob, piece?: PieceFrames): string {
  const settings = settingsOf(job);
  const shift = `setpts=PTS-${seconds(job.startPtsMs)}/TB`;
  const grid = job.grid;
  const rate = grid ? `fps=${FPS_RATIOS[grid.fps]}` : fpsFilter(settings);
  const frames = grid
    ? `trim=start_pts=${piece?.startFrame ?? 0}:end_pts=${piece?.endFrame ?? grid.frames}`
    : null;
  const cut = cutFilters(job.cuts ?? [], 'video');
  const timed = [shift, ...cut, ...(rate ? [rate] : []), ...(frames ? [frames] : [])];
  const restart = piece ? ['setpts=PTS-STARTPTS'] : [];
  const format = `format=${pixelFormat(settings, job.encoder)}`;
  const size = settings.size;
  if (size === null) return [...timed, SUBTITLES_FILTER, ...restart, format].join(',');
  const { width: w, height: h } = size;
  return [
    ...timed,
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    SUBTITLES_FILTER,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    ...restart,
    format,
  ].join(',');
}

/**
 * Cut-outs as filters, on the canonical timeline: the frames (or sound)
 * inside one dropped, and what follows each moved up by the time taken out before it, so frame
 * timing is kept whatever the frame rate. None without cut-outs.
 */
export function cutFilters(
  cuts: readonly { startMs: number; endMs: number }[],
  kind: 'video' | 'audio',
): string[] {
  if (cuts.length === 0) return [];
  const s = (ms: number) => seconds(ms);
  const inside = cuts.map((cut) => `gte(t,${s(cut.startMs)})*lt(t,${s(cut.endMs)})`).join('+');
  const removed = cuts
    .map((cut) => `clip(T-${s(cut.startMs)},0,${s(cut.endMs - cut.startMs)})`)
    .join('+');
  return kind === 'video'
    ? [`select='not(${inside})'`, `setpts='PTS-(${removed})/TB'`]
    : [`aselect='not(${inside})'`, `asetpts='PTS-(${removed})/TB'`];
}

/** The sound's filters: onto the canonical timeline, its cut-outs taken out, gaps at joins filled. */
export function renderAudioFilter(job: Pick<RenderJob, 'startPtsMs' | 'cuts'>): string {
  const cuts = job.cuts ?? [];
  return [
    `asetpts=PTS-${seconds(job.startPtsMs)}/TB`,
    ...cutFilters(cuts, 'audio'),
    // A join leaves a sliver of sound missing or doubled: resampling against time fills it.
    cuts.length > 0 ? 'aresample=async=1:first_pts=0' : 'aresample=async=0',
  ].join(',');
}

export async function probeOutput(
  path: string,
): Promise<{ width: number; height: number; durationMs: number }> {
  const output = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height:format=duration',
    '-of',
    'json',
    path,
  ]);
  const parsed = JSON.parse(output) as {
    streams?: { width?: number; height?: number }[];
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];
  return {
    width: stream?.width ?? 0,
    height: stream?.height ?? 0,
    durationMs: Math.round(Number(parsed.format?.duration ?? 0) * 1000),
  };
}

/**
 * A render's fonts in `workDir`: the `fonts` folder `SUBTITLES_FILTER` names, holding the built-in
 * fonts and whatever `add` puts there (the template's library fonts), and a fontconfig of that
 * folder alone. Returns the environment ffmpeg runs with. The parity suite draws with it too.
 */
export async function renderFonts(
  workDir: string,
  add: (fontsDir: string) => Promise<unknown> = async () => undefined,
): Promise<NodeJS.ProcessEnv> {
  const fonts = join(workDir, 'fonts');
  await mkdir(fonts, { recursive: true });
  await mkdir(join(workDir, 'fontcache'), { recursive: true });
  for (const name of await readdir(config.fontsDir).catch(() => [])) {
    await copyFile(join(config.fontsDir, name), join(fonts, name));
  }
  await add(fonts);
  const conf = join(workDir, 'fonts.conf');
  await writeFile(conf, fontsConf(fonts, join(workDir, 'fontcache')));
  return { ...process.env, FONTCONFIG_FILE: conf };
}

/**
 * A render's files in `workDir`: its fonts (`renderFonts`, the template's library fonts too) and
 * the subtitles it burns in. Returns the environment ffmpeg draws with.
 */
export async function prepareRender(
  job: Pick<RenderJob, 'fonts' | 'subtitles'>,
  workDir: string,
): Promise<NodeJS.ProcessEnv> {
  const env = await renderFonts(workDir, (fonts) =>
    Promise.all(job.fonts.map((font, i) => download(font.key, join(fonts, `library-${i}`)))),
  );
  await download(job.subtitles.key, join(workDir, 'subtitles.ass'));
  return env;
}

/** Room a render keeps beside a copy of its original: more than its file is (about 9 GB at most). */
const RENDER_SPARE_BYTES = 10 * 1000 ** 3;

/** What a caller hears of a render as it goes: its progress, as often as storage does. */
export type RenderHooks = { onProgress?: (progress: ProgressReport) => void };

/** Burns the subtitles into the original with the template's fonts. */
export async function render(
  job: RenderJob,
  workDir: string,
  hooks: RenderHooks = {},
): Promise<RenderResult> {
  const env = await prepareRender(job, workDir);
  // Its picture and sound read together: from a copy where there's room. A piece reads
  // only the picture, and the render's sound only the sound, which streams well whatever the file.
  const input = await originalInput(job.input.key, workDir, () => RENDER_SPARE_BYTES);

  const settings = settingsOf(job);
  const file = container(settings);
  const out = join(workDir, `render.${file.extension}`);
  const report = new FontReport();
  const { progress: progressFile } = job;
  const { onProgress } = hooks;
  const progress =
    progressFile || onProgress
      ? new EncodeProgress(job.durationMs, async (value) => {
          onProgress?.(value);
          if (progressFile) await putJson(progressFile.key, value);
        })
      : null;
  await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-y',
      // libass reports its font choices at `info`.
      '-loglevel',
      'info',
      '-progress',
      'pipe:1',
      ...NETWORK_INPUT,
      ...decodeArgs(settings, job.encoder),
      '-i',
      input,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      renderFilter(job),
      '-af',
      renderAudioFilter(job),
      ...videoArgs(settings, 0, job.encoder),
      ...audioArgs(settings),
      '-t',
      seconds(job.durationMs),
      '-avoid_negative_ts',
      'make_zero',
      '-movflags',
      '+faststart',
      out,
    ],
    {
      cwd: workDir,
      env,
      onStderr: (chunk) => report.push(chunk),
      onStdout: (chunk) => progress?.push(chunk),
    },
  );
  await progress?.settle();
  const probed = await probeOutput(out);
  return {
    output: await putFile(out, job.output.key, file.mime),
    ...probed,
    ...report.finish(),
  };
}
