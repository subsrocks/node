import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import type { HardwareKind, VideoCodec } from '../job.ts';
import type { NodeMachine } from '../protocol.ts';
import { type FoundHardware, findHardware } from './hardware.ts';
import type { GpuUse } from './options.ts';
import type { Tools } from './tools.ts';

/**
 * What this machine can do, found out once at start: its ffmpeg (which must draw subtitles with
 * libass), the encoders it has for each codec, the video hardware it encodes on (`hardware.ts`,
 * each encoder tried), the threads and memory it may use, and the font system libass picks fonts
 * with (a line is drawn to see).
 */

/** Each codec's CPU encoder. */
const CPU_ENCODERS: Readonly<Record<VideoCodec, string>> = {
  h264: 'libx264',
  hevc: 'libx265',
  av1: 'libsvtav1',
  prores: 'prores_ks',
};

/** A command's output (its errors' too, with `stderr`), or null when it couldn't run or failed. */
export function capture(
  command: string,
  args: readonly string[],
  options: { cwd?: string; stderr?: boolean; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        ...(options.env ? { env: options.env } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch {
      resolve(null);
      return;
    }
    const out: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    if (options.stderr) child.stderr?.on('data', (chunk: Buffer) => out.push(chunk));
    else child.stderr?.resume();
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? Buffer.concat(out).toString('utf8') : null));
  });
}

/** `ffmpeg version 7.1.1-1 Copyright …` → `7.1.1-1`. */
export function ffmpegVersion(text: string): string | null {
  return /^ffmpeg version (\S+)/m.exec(text)?.[1] ?? null;
}

/** The names `ffmpeg -encoders` (or `-filters`) lists: each line's second word. */
export function listedNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const name = /^\s*[A-Z.|]{2,}\s+(\S+)/.exec(line)?.[1];
    if (name) names.add(name);
  }
  return names;
}

/** The font system libass says it picks fonts with: `fontconfig`, or macOS's `coretext`. */
export function fontProviderOf(text: string): string | null {
  return /Using font provider (\w+)/.exec(text)?.[1] ?? null;
}

/** A line to draw, in a font that isn't there. */
const LINE = `[Script Info]
ScriptType: v4.00+
PlayResX: 64
PlayResY: 64

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Tahoma,16,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,4,4,4,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Hi
`;

/** The font system this ffmpeg's libass picks fonts with, from drawing a line as a render does. */
async function fontProvider(tools: Tools): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), 'subs-node-ass-'));
  try {
    await mkdir(join(dir, 'fonts'));
    await writeFile(join(dir, 'line.ass'), LINE);
    // A fontconfig of its own, as a render has: one built without a default one says so otherwise.
    const conf = join(dir, 'fonts.conf');
    await writeFile(
      conf,
      `<?xml version="1.0"?>\n<fontconfig><dir>${join(dir, 'fonts')}</dir><cachedir>${join(dir, 'cache')}</cachedir></fontconfig>\n`,
    );
    const output = await capture(
      tools.ffmpeg,
      [
        '-hide_banner',
        '-v',
        'info',
        '-f',
        'lavfi',
        '-i',
        'color=black:size=64x64:rate=1',
        '-frames:v',
        '1',
        '-vf',
        'ass=filename=line.ass:fontsdir=fonts',
        '-f',
        'null',
        '-',
      ],
      { cwd: dir, stderr: true, env: { ...process.env, FONTCONFIG_FILE: conf } },
    );
    return output === null ? null : fontProviderOf(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A font system, as people know it. */
const FONT_SYSTEMS: Readonly<Record<string, string>> = {
  coretext: "macOS's font system",
  directwrite: "Windows's font system",
};

export type Described = {
  machine: NodeMachine;
  /** Its video hardware, as a render runs on it; null: none, or `--gpu off`. */
  hardware: FoundHardware | null;
  /** What stops it rendering: no ffmpeg, no libass, no H.264 encoder. */
  problems: string[];
  /** What it can do without, said once. */
  notes: string[];
};

/** A number from a file of the kernel's, or null. */
async function kernelNumber(path: string): Promise<number | null> {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return null;
  const value = Number(text.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The threads it may use: what it may run on (`availableParallelism`), and in a container, no more
 * than its CPU limit (cgroup's `cpu.max`, `docker run --cpus`), which encoders don't see: they size
 * their threads by the host's processors, and a limited container runs them several times slower.
 */
export async function threadBudget(): Promise<number> {
  const threads = Math.max(1, availableParallelism());
  if (process.platform !== 'linux') return threads;
  const max = await readFile('/sys/fs/cgroup/cpu.max', 'utf8').catch(() => null);
  const [quota, period] = max?.trim().split(/\s+/) ?? [];
  let limit: number | null = null;
  if (quota && quota !== 'max' && period) limit = Number(quota) / Number(period);
  else {
    const v1 = await kernelNumber('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
    const v1Period = await kernelNumber('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
    if (v1 !== null && v1Period !== null) limit = v1 / v1Period;
  }
  return limit !== null && Number.isFinite(limit) && limit > 0
    ? Math.max(1, Math.min(threads, Math.ceil(limit)))
    : threads;
}

/** The memory it may use: the machine's, or a container's limit (`docker run --memory`). */
export async function memoryBudget(): Promise<number> {
  const total = totalmem();
  if (process.platform !== 'linux') return total;
  const limit =
    (await kernelNumber('/sys/fs/cgroup/memory.max')) ??
    (await kernelNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
  return limit !== null && limit < total ? limit : total;
}

/**
 * The processor's name: as the system says it, or on ARM Linux, which names none (Apple's chips
 * in Docker Desktop's machine among them), by its maker's code.
 */
async function cpuModel(): Promise<string> {
  const model = (cpus()[0]?.model ?? '').replace(/\s+/g, ' ').trim();
  if (model && model !== 'unknown') return model.slice(0, 120);
  const info = await readFile('/proc/cpuinfo', 'utf8').catch(() => '');
  const maker = /^CPU implementer\s*:\s*0x([0-9a-f]+)/im.exec(info)?.[1];
  const makers: Record<string, string> = { '41': 'Arm', '61': 'Apple silicon', '51': 'Qualcomm' };
  return (maker && makers[maker.toLowerCase()]) || 'unknown';
}

/** This machine: its CPU, memory, video hardware, ffmpeg and the codecs it encodes. */
export async function describeMachine(options: {
  tools: Tools;
  gpu: GpuUse;
  /** Where it works, for its free space, and to make a clip in. */
  workDir: string;
  platform?: NodeJS.Platform;
}): Promise<Described> {
  const { tools } = options;
  const platform = options.platform ?? process.platform;
  const problems: string[] = [];
  const notes: string[] = [];
  // The program brings its ffmpeg on a Mac: one missing is put back by installing again.
  const getIt =
    platform === 'darwin'
      ? ' (run the install line again, which brings it, or run the Docker image)'
      : '';
  const [versionText, encoderText, filterText, probeText] = await Promise.all([
    capture(tools.ffmpeg, ['-hide_banner', '-version']),
    capture(tools.ffmpeg, ['-hide_banner', '-encoders']),
    capture(tools.ffmpeg, ['-hide_banner', '-filters']),
    capture(tools.ffprobe, ['-hide_banner', '-version']),
  ]);
  const version = versionText === null ? null : ffmpegVersion(versionText);
  if (versionText === null) {
    problems.push(`ffmpeg didn't run (${tools.ffmpeg}): install it${getIt}`);
  }
  if (versionText !== null && probeText === null) {
    problems.push(`ffprobe didn't run (${tools.ffprobe}): install it${getIt}`);
  }
  const encoders = encoderText === null ? new Set<string>() : listedNames(encoderText);
  const filters = filterText === null ? new Set<string>() : listedNames(filterText);
  if (versionText !== null && !filters.has('ass')) {
    problems.push(`this ffmpeg can't draw subtitles: it needs libass (the \`ass\` filter)${getIt}`);
  } else if (versionText !== null) {
    // subs.rocks's renders give libass their fonts alone, through fontconfig; where it asks the
    // system's fonts too, a font the template doesn't bring, or a character its fonts lack, draws
    // in one of this machine's.
    const provider = await fontProvider(tools);
    if (provider !== null && provider !== 'fontconfig') {
      notes.push(
        `libass here picks fonts with ${FONT_SYSTEMS[provider] ?? `the system's (${provider})`}, not a render's fonts alone: a font a template doesn't bring, or a character its fonts lack, can draw unlike subs.rocks's renders`,
      );
    }
  }
  const cpu = (Object.keys(CPU_ENCODERS) as VideoCodec[]).filter((codec) =>
    encoders.has(CPU_ENCODERS[codec]),
  );
  if (versionText !== null && !cpu.includes('h264')) {
    problems.push('this ffmpeg has no H.264 encoder (libx264)');
  }
  const missing = (Object.keys(CPU_ENCODERS) as VideoCodec[]).filter(
    (codec) => codec !== 'h264' && !cpu.includes(codec),
  );
  if (versionText !== null && missing.length > 0) {
    notes.push(`no encoder for ${missing.join(', ')}: renders in it go to another machine`);
  }

  const model = await cpuModel();
  const scratch = await mkdtemp(join(tmpdir(), 'subs-node-trial-'));
  const search = await findHardware({
    tools,
    capture,
    gpu: options.gpu,
    encoders,
    platform,
    cpuModel: model,
    scratch,
  }).finally(() => rm(scratch, { recursive: true, force: true }));
  notes.push(...search.notes);
  const found = versionText === null ? null : search.found;
  const gpu = found ? (Object.keys(found.features) as VideoCodec[]) : [];
  const gpus: NodeMachine['gpus'] =
    found?.hardware.kind === 'nvenc'
      ? search.nvidia
      : found?.hardware.kind === 'vaapi'
        ? [{ name: found.name, memoryBytes: null }]
        : [];

  let diskBytes: number | null = null;
  try {
    const stats = await statfs(options.workDir);
    diskBytes = stats.bavail * stats.bsize;
  } catch {
    // Not there yet, or the system doesn't say.
  }
  return {
    machine: {
      os: process.platform,
      arch: process.arch,
      container: process.env['SUBS_CONTAINER'] === '1',
      cpu: { model, threads: await threadBudget() },
      memoryBytes: await memoryBudget(),
      gpus,
      encoders: { cpu, gpu },
      hardware: found
        ? { kind: found.hardware.kind, name: found.name, features: found.features }
        : null,
      ffmpeg: (version ?? 'unknown').slice(0, 80),
      diskBytes,
    },
    hardware: found,
    problems,
    notes,
  };
}

/** The machine in a line: `Ryzen 9 7950X · 32 threads · 64 GB · RTX 4090`. */
export function machineLine(machine: NodeMachine): string {
  const gb = Math.round(machine.memoryBytes / 1024 ** 3);
  const gpu = machine.gpus[0]?.name;
  return [machine.cpu.model, `${machine.cpu.threads} threads`, `${gb} GB`, gpu]
    .filter(Boolean)
    .join(' · ');
}

const CODEC_NAMES: Readonly<Record<VideoCodec, string>> = {
  h264: 'H.264',
  hevc: 'H.265',
  av1: 'AV1',
  prores: 'ProRes',
};

/** Where a kind of hardware encodes, as people know it. */
const ON: Readonly<Record<HardwareKind, string>> = {
  nvenc: 'GPU',
  vaapi: 'GPU',
  videotoolbox: 'media engine',
};

/**
 * The codecs it encodes, the hardware's marked: `H.264 (GPU) · H.265 (GPU) · AV1 · ProRes`, or on
 * a Mac, `H.265 (media engine)`.
 */
export function encodersLine(machine: NodeMachine): string {
  const on = ON[machine.hardware?.kind ?? 'nvenc'];
  const codecs = (Object.keys(CODEC_NAMES) as VideoCodec[]).filter(
    (codec) => machine.encoders.cpu.includes(codec) || machine.encoders.gpu.includes(codec),
  );
  return codecs
    .map((codec) =>
      machine.encoders.gpu.includes(codec) ? `${CODEC_NAMES[codec]} (${on})` : CODEC_NAMES[codec],
    )
    .join(' · ');
}
