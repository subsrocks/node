import { mkdir, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type FrameGrid,
  frameRatio,
  type RenderJob,
  type RenderResult,
  type VideoCodec,
} from '../job.ts';
import { planPieces } from '../plan.ts';
import { container, encoderOf, settingsOf } from './encode.ts';
import { run } from './ffmpeg.ts';
import type { Hardware } from './hardware.ts';
import { objectUrl, originalInput } from './io.ts';
import { log } from './log.ts';
import {
  audioFile,
  countFrames,
  encodeAudio,
  encodePiece,
  JoinMismatch,
  joinPieces,
} from './pieces.ts';
import {
  bytesStage,
  EncodeProgress,
  FontReport,
  prepareRender,
  progressWriter,
  type RenderHooks,
  render,
  saveFile,
} from './render.ts';

/**
 * A render made in pieces on one machine, several encoding at once, then joined: as subs.rocks
 * spreads a render's pieces across its machines (`pieces.ts`), with the pieces on this machine's
 * disk. One encoder keeps only a few threads busy whatever the machine has, and one ffmpeg reads,
 * draws the subtitles and converts frames a frame at a time, so a machine with more threads than
 * that, or a hardware encoder with time to spare, makes a render sooner this way (ADR 0078). The joined file is checked frame for frame as subs.rocks's is; one that doesn't join is
 * made whole instead.
 */

/** What a machine has for a render: its threads (what it may use) and its memory. */
export type MachineBudget = { threads: number; memoryBytes: number };

/** How a render is made on a machine: how many encodes at once, of how many pieces, on how many threads each. */
export type ParallelPlan = { slots: number; pieces: number; threads: number };

/**
 * Threads to give each CPU encode. Measured on 16 and 32 threads (x264, x265 and SVT-AV1 at 1080p
 * and 4K, from a high-bitrate original): one encoder on all of them made a third to two thirds of
 * what four on a quarter each made; on 16 threads, four made 1.6 to 3.6 times one's frames.
 */
const THREADS_PER_ENCODE = 4;
/** Hardware encodes at once: on an NVIDIA L4, two made 1.7 to 1.85 times one's; a third, little more. */
const HARDWARE_SLOTS = 2;
const MAX_SLOTS = 8;
/** Renders shorter than this are made whole; no piece is shorter than half of it. */
const PARALLEL_FROM_MS = 60_000;
const MIN_PIECE_MS = 30_000;
/** Memory one encode of a frame of this many pixels takes, about, by encoder (bytes a pixel). */
const BYTES_PER_PIXEL: Readonly<Record<VideoCodec | 'hardware', number>> = {
  h264: 120,
  hevc: 240,
  av1: 360,
  prores: 60,
  hardware: 60,
};
/** The share of a machine's memory its encodes may take. */
const MEMORY_SHARE = 0.7;

/**
 * How a render of `pixels` a frame (its output's) is made on `machine`: on hardware (`on`), two
 * encodes at once; on the CPU, one for every `THREADS_PER_ENCODE` threads; as many as its memory
 * holds, each taking two pieces in turn so one slow piece doesn't hold the rest up. Whole when the
 * render has no frame grid (pieces join only on one) or is short.
 */
export function parallelPlan(
  job: Pick<RenderJob, 'grid' | 'durationMs'> & Parameters<typeof settingsOf>[0],
  machine: MachineBudget,
  on: Hardware | null,
  pixels: number,
): ParallelPlan {
  const threads = Math.max(1, machine.threads);
  const whole = { slots: 1, pieces: 1, threads };
  if (!job.grid || job.durationMs < PARALLEL_FROM_MS) return whole;
  const codec = settingsOf(job).codec;
  const wanted = on
    ? threads >= 4
      ? HARDWARE_SLOTS
      : 1
    : Math.min(MAX_SLOTS, Math.floor(threads / THREADS_PER_ENCODE));
  const perEncode = Math.max(1, pixels) * BYTES_PER_PIXEL[on ? 'hardware' : codec];
  const fits = Math.floor((machine.memoryBytes * MEMORY_SHARE) / perEncode);
  const slots = Math.max(1, Math.min(wanted, fits));
  if (slots < 2) return whole;
  const pieces = Math.max(slots, Math.min(slots * 2, Math.floor(job.durationMs / MIN_PIECE_MS)));
  return { slots, pieces, threads: Math.max(1, Math.floor(threads / slots)) };
}

/** Bits a pixel of a frame takes at a constant quality, about (ProRes by its profile). */
const BITS_PER_PIXEL = { crf: 0.15, proxy: 0.7, lt: 1.6, standard: 2.4, hq: 3.5, '4444': 5.3 };

/** About how big a render will be: its bitrate's worth, or its pixels' at a constant quality. */
export function renderBytes(
  settings: ReturnType<typeof settingsOf>,
  durationMs: number,
  pixels: number,
  grid: FrameGrid,
): number {
  const seconds = durationMs / 1000;
  const audio = (settings.audio.kbps * 1000 * seconds) / 8;
  const { rate } = settings;
  if (settings.codec !== 'prores' && rate.mode !== 'crf') {
    const kbps = rate.mode === 'vbr' ? rate.maxKbps : rate.kbps;
    return (kbps * 1000 * seconds) / 8 + audio;
  }
  const { num, den } = frameRatio(grid.fps);
  const bits =
    settings.codec === 'prores' ? BITS_PER_PIXEL[settings.proresProfile] : BITS_PER_PIXEL.crf;
  const capped =
    settings.codec !== 'prores' && rate.mode === 'crf' && rate.maxKbps !== null
      ? (rate.maxKbps * 1000 * seconds) / 8
      : Number.POSITIVE_INFINITY;
  return Math.min(capped, (pixels * bits * (num / den) * seconds) / 8) + audio;
}

/** The original's frame size, which a render keeps when its settings don't set one. */
async function frameOf(input: string): Promise<{ width: number; height: number } | null> {
  try {
    const output = await run('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      input,
    ]);
    const [width = 0, height = 0] = output.trim().split(',').map(Number);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

/** `count` tasks, `slots` at a time, in order; the first to fail stops the rest. */
async function inTurn(
  count: number,
  slots: number,
  task: (index: number, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const stop = new AbortController();
  let next = 0;
  const worker = async () => {
    while (next < count && !stop.signal.aborted) {
      const index = next++;
      await task(index, stop.signal);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(slots, count) }, worker));
  } catch (error) {
    stop.abort();
    throw error;
  }
}

/**
 * How a machine makes a render: its hardware, if any, and what it has; `plan`, a plan of its own
 * instead of `parallelPlan`'s, however short the render (the tests make small ones in pieces).
 */
export type ParallelOptions = { hardware?: Hardware; machine: MachineBudget; plan?: ParallelPlan };

/**
 * Burns the subtitles into the original as `render` does, in pieces at once where the machine
 * gains by it (`parallelPlan`), else whole.
 */
export async function renderInParallel(
  job: RenderJob,
  workDir: string,
  hooks: RenderHooks,
  options: ParallelOptions,
): Promise<RenderResult> {
  const on = encoderOf(job, options.hardware);
  const settings = settingsOf(job);
  const machine = options.machine;
  const wholly = () =>
    render(job, workDir, hooks, {
      ...(options.hardware ? { hardware: options.hardware } : {}),
      threads: machine.threads,
    });
  const { grid } = job;
  if (!grid || (!options.plan && job.durationMs < PARALLEL_FROM_MS)) return wholly();
  // Planned before the original is copied: a render made whole copies it itself.
  const frame = options.plan ? null : (settings.size ?? (await frameOf(objectUrl(job.input.key))));
  const plan =
    options.plan ??
    parallelPlan(job, machine, on, frame ? frame.width * frame.height : 3840 * 2160);
  const pieces = planPieces(grid, plan.pieces, job.cuts ?? [], settings.keyframeSeconds);
  const { bavail, bsize } = await statfs(workDir);
  // Room for the pieces and the joined file, each as big as the render will be, before a copy of
  // the original; with less, it's made whole, which needs neither.
  const pixels = frame ? frame.width * frame.height : 3840 * 2160;
  const room = 2 * renderBytes(settings, job.durationMs, pixels, grid) + 1e9;
  if (plan.slots < 2 || pieces.length < 2 || bavail * bsize < room) return wholly();

  const write = progressWriter(job.progress, hooks.onProgress);
  const preparing = bytesStage('preparing', write);
  const env = await prepareRender(job, workDir);
  // A copy of the original where there's room for it too, which every piece reads.
  const input = await originalInput(job.input.key, workDir, () => room, preparing.io);
  await preparing.settle();
  log('info', 'render in pieces', {
    slots: plan.slots,
    pieces: pieces.length,
    threads: plan.threads,
  });
  hooks.onPieces?.({ pieces: pieces.length, slots: plan.slots });

  const file = container(settings);
  const dir = join(workDir, 'pieces');
  await mkdir(dir, { recursive: true });
  const progress = write ? new EncodeProgress(job.durationMs, write) : null;
  const reports = pieces.map(() => new FontReport());
  const paths = pieces.map((piece) => join(dir, `piece-${piece.index}.${file.extension}`));
  const audio = join(dir, audioFile(settings));
  try {
    const [, hasSound] = await Promise.all([
      inTurn(pieces.length, plan.slots, async (i, signal) => {
        const piece = pieces[i];
        const report = reports[i];
        if (!piece || !report) return;
        const stream = progress?.stream();
        await encodePiece(
          { ...job, grid, piece },
          input,
          paths[i] ?? '',
          { on, threads: plan.threads },
          {
            cwd: workDir,
            env,
            signal,
            onStderr: (chunk) => report.push(chunk),
            onStdout: (chunk) => stream?.(chunk),
          },
        );
      }),
      encodeAudio({ ...job, settings }, input, audio),
    ]);
    await progress?.settle();
    const out = join(workDir, `render.${file.extension}`);
    // Each piece holds its frames; the last may hold fewer, when the video ends before the grid.
    const frames = await Promise.all(paths.map(countFrames));
    pieces.forEach((piece, i) => {
      const planned = piece.endFrame - piece.startFrame;
      const held = frames[i] ?? 0;
      if (held > planned || (i < pieces.length - 1 && held !== planned) || held === 0) {
        throw new JoinMismatch(`piece ${i + 1} holds ${held} frames, not ${planned}`);
      }
    });
    const probed = await joinPieces(
      { grid, settings },
      paths.map((path, i) => ({ path, frames: frames[i] ?? 0 })),
      hasSound ? audio : null,
      out,
      workDir,
    );
    await rm(dir, { recursive: true, force: true });
    const faces = new Set<string>();
    const missing = new Set<string>();
    for (const report of reports) {
      const found = report.finish();
      for (const face of found.faces) faces.add(face);
      for (const glyph of found.missingGlyphs) missing.add(glyph);
    }
    return {
      output: await saveFile(out, job.output.key, file.mime, write),
      ...probed,
      faces: [...faces].slice(0, 50),
      missingGlyphs: [...missing].slice(0, 100),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    // Pieces that don't join make it whole, as subs.rocks does; anything else is the render's.
    if (!(error instanceof JoinMismatch)) throw error;
    log('info', 'pieces did not join: making it whole', { detail: error.message });
    return wholly();
  }
}
