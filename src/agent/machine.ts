import { spawn } from 'node:child_process';
import { mkdtemp, rm, statfs } from 'node:fs/promises';
import { availableParallelism, cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import type { VideoCodec } from '../job.ts';
import type { NodeMachine } from '../protocol.ts';
import type { GpuUse } from './options.ts';

/**
 * What this machine can do, found out once at start: its ffmpeg (which must draw subtitles with
 * libass), the encoders it has for each codec, and NVIDIA GPUs it can encode on. Every GPU encoder
 * is tried on a few frames, and CUDA decoding too, since a GPU render decodes there: a driver
 * that's missing or too old shows up here, not halfway through someone's render.
 */

/** Each codec's CPU encoder, and its GPU's (NVENC); ProRes has no GPU encoder. */
const CPU_ENCODERS: Readonly<Record<VideoCodec, string>> = {
  h264: 'libx264',
  hevc: 'libx265',
  av1: 'libsvtav1',
  prores: 'prores_ks',
};
const GPU_ENCODERS: Readonly<Partial<Record<VideoCodec, string>>> = {
  h264: 'h264_nvenc',
  hevc: 'hevc_nvenc',
  av1: 'av1_nvenc',
};

export type Tools = { ffmpeg: string; ffprobe: string };

/** A command's output, or null when it couldn't run or failed. */
export function capture(
  command: string,
  args: readonly string[],
  timeoutMs = 30_000,
): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      resolve(null);
      return;
    }
    const out: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.resume();
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

/** `nvidia-smi`'s CSV of names and memory (MiB) → each GPU. */
export function nvidiaGpus(text: string): NodeMachine['gpus'] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 16)
    .map((line) => {
      const comma = line.lastIndexOf(',');
      const name = (comma === -1 ? line : line.slice(0, comma)).trim().slice(0, 120);
      const mib = Number(comma === -1 ? Number.NaN : line.slice(comma + 1).trim());
      return { name, memoryBytes: Number.isFinite(mib) ? Math.round(mib * 1024 * 1024) : null };
    });
}

/** Whether ffmpeg encodes a few frames with `encoder` (and, for the GPU, decodes on it). */
async function encodes(tools: Tools, encoder: string, extra: string[] = []): Promise<boolean> {
  const output = await capture(tools.ffmpeg, [
    '-hide_banner',
    '-v',
    'error',
    ...extra,
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=30',
    '-frames:v',
    '5',
    '-c:v',
    encoder,
    '-f',
    'null',
    '-',
  ]);
  return output !== null;
}

/** Whether ffmpeg decodes on the GPU (`-hwaccel cuda`), which a GPU render asks for. */
async function decodesOnGpu(tools: Tools): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'subs-node-cuda-'));
  try {
    const clip = join(dir, 'clip.mp4');
    const made = await capture(tools.ffmpeg, [
      '-hide_banner',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=30',
      '-frames:v',
      '10',
      '-c:v',
      'libx264',
      '-y',
      clip,
    ]);
    if (made === null) return false;
    const decoded = await capture(tools.ffmpeg, [
      '-hide_banner',
      '-v',
      'error',
      '-hwaccel',
      'cuda',
      '-i',
      clip,
      '-f',
      'null',
      '-',
    ]);
    return decoded !== null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type Described = {
  machine: NodeMachine;
  /** What stops it rendering: no ffmpeg, no libass, no H.264 encoder. */
  problems: string[];
  /** What it can do without, said once. */
  notes: string[];
};

/** This machine: its CPU, memory, GPUs, ffmpeg and the codecs it encodes. */
export async function describeMachine(options: {
  tools: Tools;
  gpu: GpuUse;
  /** Where it works, for its free space. */
  workDir: string;
}): Promise<Described> {
  const { tools } = options;
  const problems: string[] = [];
  const notes: string[] = [];
  const [versionText, encoderText, filterText, probeText] = await Promise.all([
    capture(tools.ffmpeg, ['-hide_banner', '-version']),
    capture(tools.ffmpeg, ['-hide_banner', '-encoders']),
    capture(tools.ffmpeg, ['-hide_banner', '-filters']),
    capture(tools.ffprobe, ['-hide_banner', '-version']),
  ]);
  const version = versionText === null ? null : ffmpegVersion(versionText);
  if (versionText === null) problems.push(`ffmpeg didn't run (${tools.ffmpeg}): install it`);
  if (probeText === null) problems.push(`ffprobe didn't run (${tools.ffprobe}): install it`);
  const encoders = encoderText === null ? new Set<string>() : listedNames(encoderText);
  const filters = filterText === null ? new Set<string>() : listedNames(filterText);
  if (versionText !== null && !filters.has('ass')) {
    problems.push("this ffmpeg can't draw subtitles: it needs libass (the `ass` filter)");
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

  let gpus: NodeMachine['gpus'] = [];
  const gpu: VideoCodec[] = [];
  const nvencListed = Object.values(GPU_ENCODERS).some((name) => encoders.has(name));
  if (options.gpu === 'off') {
    if (nvencListed) notes.push('not encoding on a GPU (--gpu off)');
  } else if (nvencListed) {
    const smi = await capture('nvidia-smi', [
      '--query-gpu=name,memory.total',
      '--format=csv,noheader,nounits',
    ]);
    gpus = smi === null ? [] : nvidiaGpus(smi);
    if (gpus.length > 0) {
      if (await decodesOnGpu(tools)) {
        for (const [codec, encoder] of Object.entries(GPU_ENCODERS) as [VideoCodec, string][]) {
          if (encoders.has(encoder) && (await encodes(tools, encoder))) gpu.push(codec);
        }
        if (gpu.length === 0) notes.push("the GPU's encoders didn't work: encoding on the CPU");
      } else {
        notes.push("ffmpeg can't decode on the GPU (CUDA): encoding on the CPU");
      }
    }
  }

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
      cpu: {
        model: (cpus()[0]?.model ?? 'unknown').replace(/\s+/g, ' ').trim().slice(0, 120),
        threads: Math.max(1, availableParallelism()),
      },
      memoryBytes: totalmem(),
      gpus: gpu.length > 0 ? gpus : [],
      encoders: { cpu, gpu },
      ffmpeg: (version ?? 'unknown').slice(0, 80),
      diskBytes,
    },
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

/** The codecs it encodes, the GPU's marked: `H.264 (GPU) · H.265 (GPU) · AV1 · ProRes`. */
export function encodersLine(machine: NodeMachine): string {
  return machine.encoders.cpu
    .map((codec) =>
      machine.encoders.gpu.includes(codec) ? `${CODEC_NAMES[codec]} (GPU)` : CODEC_NAMES[codec],
    )
    .join(' · ');
}
