import type { EncoderSpeed, FrameRate, ProresProfile, RenderJob, RenderSettings } from '../job.ts';
import {
  type Hardware,
  hardwareEncoder,
  hardwareInputArgs,
  hardwarePixelFormat,
  hardwareUpload,
  hardwareVideoArgs,
  NVENC,
} from './hardware.ts';

/**
 * A render's encode as ffmpeg arguments: the codec and its rate control, the frame rate, the pixel
 * format and the sound, from the job's settings. Only types from `../job.ts`: scripts load this
 * with nothing installed (`scripts/encoders.ts`), so the few tables it needs are its own, kept
 * equal to the contract's by a test.
 */

/** `FRAME_RATES`: each rate as the exact ratio the `fps` filter is given. */
export const FPS_RATIOS: Readonly<Record<FrameRate, string>> = {
  '23.976': '24000/1001',
  '24': '24',
  '25': '25',
  '29.97': '30000/1001',
  '30': '30',
  '48': '48',
  '50': '50',
  '59.94': '60000/1001',
  '60': '60',
};

/** SVT-AV1's presets (0 slowest, 13 fastest) for the speeds x264 and x265 name. */
const SVT_PRESETS: Readonly<Record<EncoderSpeed, number>> = {
  ultrafast: 12,
  superfast: 11,
  veryfast: 10,
  faster: 9,
  fast: 8,
  medium: 6,
  slow: 5,
  slower: 4,
  veryslow: 2,
};

/**
 * Where a job is encoded: on `hardware` (NVENC, subs.rocks's GPU machines', unless the machine
 * says which it has) when the job asks for it and that hardware makes its codec; else null, the
 * CPU's encoders.
 */
export function encoderOf(
  job: Pick<RenderJob, 'encoder' | 'settings' | 'crf' | 'speed' | 'audioKbps' | 'width' | 'height'>,
  hardware: Hardware = NVENC,
): Hardware | null {
  if (job.encoder !== 'gpu') return null;
  return hardwareEncoder(hardware.kind, settingsOf(job).codec) ? hardware : null;
}

/** prores_ks's profile numbers. */
const PRORES: Readonly<Record<ProresProfile, number>> = {
  proxy: 0,
  lt: 1,
  standard: 2,
  hq: 3,
  '4444': 4,
};

/**
 * The settings a job encodes by: its own, or, from a server older than settings, the fields it
 * always carries, which were H.264 at a constant quality.
 */
export function settingsOf(
  job: Pick<RenderJob, 'settings' | 'crf' | 'speed' | 'audioKbps' | 'width' | 'height'>,
): RenderSettings {
  if (job.settings) return job.settings;
  return {
    codec: 'h264',
    size:
      job.width !== null && job.height !== null ? { width: job.width, height: job.height } : null,
    fps: null,
    rate: { mode: 'crf', crf: job.crf, maxKbps: null },
    speed: job.speed,
    tenBit: false,
    proresProfile: 'hq',
    keyframeSeconds: null,
    audio: { kbps: job.audioKbps, sampleRate: null },
  };
}

/**
 * The frames' pixel format: 4:2:0 at 8 or 10 bits; ProRes 4:2:2, or 4:4:4 for 4444; on hardware,
 * as it takes them (`hardwarePixelFormat`).
 */
export function pixelFormat(settings: RenderSettings, on: Hardware | null = null): string {
  if (on) return hardwarePixelFormat(on.kind, settings);
  if (settings.codec === 'prores') {
    return settings.proresProfile === '4444' ? 'yuv444p10le' : 'yuv422p10le';
  }
  const tenBit = settings.tenBit && settings.codec !== 'h264';
  return tenBit ? 'yuv420p10le' : 'yuv420p';
}

/** The filters that end a render's: its pixel format, then on to the hardware where it goes. */
export function formatFilters(settings: RenderSettings, on: Hardware | null = null): string[] {
  return [`format=${pixelFormat(settings, on)}`, ...(on ? hardwareUpload(on.kind) : [])];
}

/**
 * What reads the original: on hardware, its device and decoder (frames come back for the
 * subtitles; ffmpeg decodes on the CPU what the hardware can't); and, when given, how many threads
 * decoding on the CPU and the filters take, which otherwise size themselves by the host's
 * processors, however many a container or a render's share of the machine may use.
 */
export function decodeArgs(on: Hardware | null = null, threads: number | null = null): string[] {
  const limit =
    threads === null ? [] : ['-filter_threads', String(threads), '-threads', String(threads)];
  return [...limit, ...(on ? hardwareInputArgs(on) : [])];
}

/** The frame rate filter, when the render changes it. */
export function fpsFilter(settings: RenderSettings): string | null {
  return settings.fps === null ? null : `fps=${FPS_RATIOS[settings.fps]}`;
}

const kbps = (n: number) => `${n}k`;

/** Rate control as ffmpeg's generic options, which each encoder's wrapper maps to its own. */
function rateArgs(settings: RenderSettings): string[] {
  const { rate } = settings;
  if (rate.mode === 'crf') {
    const cap = rate.maxKbps;
    return [
      '-crf',
      String(rate.crf),
      ...(cap === null ? [] : ['-maxrate', kbps(cap), '-bufsize', kbps(cap * 2)]),
    ];
  }
  // SVT-AV1 takes a ceiling only at a constant quality: its rate modes aim at the bitrate alone.
  if (settings.codec === 'av1') return ['-b:v', kbps(rate.kbps)];
  if (rate.mode === 'cbr') {
    const k = kbps(rate.kbps);
    return [
      '-b:v',
      k,
      ...(settings.codec === 'h264' ? ['-minrate', k] : []),
      '-maxrate',
      k,
      '-bufsize',
      k,
    ];
  }
  return [
    '-b:v',
    kbps(rate.kbps),
    '-maxrate',
    kbps(rate.maxKbps),
    '-bufsize',
    kbps(rate.maxKbps * 2),
  ];
}

/**
 * Forced keyframes every `keyframeSeconds` of the render. A piece starting `offset` seconds in
 * forces them where the whole render would: from the first such point at or after its
 * start, counting time from the render's.
 */
function keyframeArgs(seconds: number | null, offset: number): string[] {
  if (seconds === null) return [];
  if (offset <= 0) return ['-force_key_frames', `expr:gte(t,n_forced*${seconds})`];
  // A point a hair under the start, from float division, is the start's own.
  const first = Math.ceil(offset / seconds - 1e-9);
  return ['-force_key_frames', `expr:gte(t+${offset},(n_forced+${first})*${seconds})`];
}

/**
 * The video encoder and its settings; `offset`, a piece's start in the render, in seconds. On
 * hardware, its encoder (`hardwareVideoArgs`); on the CPU, `threads` at most when given (a machine
 * encoding several pieces at once shares its threads among them), else as many as it has.
 */
export function videoArgs(
  settings: RenderSettings,
  offset = 0,
  on: Hardware | null = null,
  threads: number | null = null,
): string[] {
  const keyframes = keyframeArgs(settings.keyframeSeconds, offset);
  if (on) return hardwareVideoArgs(on.kind, settings, keyframes);
  const { codec, rate, speed } = settings;
  const limit = threads === null ? [] : ['-threads', String(threads)];
  // x264 runs half as many threads again as it's given processors, its frame threads waiting on
  // each other otherwise: as it would itself.
  const x264 = threads === null ? [] : ['-threads', String(Math.ceil(threads * 1.5))];
  if (codec === 'prores') {
    return [
      '-c:v',
      'prores_ks',
      '-profile:v',
      String(PRORES[settings.proresProfile]),
      '-vendor',
      'apl0',
      ...limit,
    ];
  }
  if (codec === 'h264') {
    return [
      '-c:v',
      'libx264',
      '-preset',
      speed,
      ...rateArgs(settings),
      ...(rate.mode === 'cbr' ? ['-x264-params', 'nal-hrd=cbr'] : []),
      '-profile:v',
      'high',
      ...x264,
      ...keyframes,
    ];
  }
  if (codec === 'hevc') {
    // x265 runs a pool of threads of its own: `pools` sizes it.
    const x265 = [
      'log-level=error',
      ...(rate.mode === 'cbr' ? ['strict-cbr=1'] : []),
      ...(threads === null ? [] : [`pools=${threads}`]),
    ];
    return [
      '-c:v',
      'libx265',
      '-preset',
      speed,
      ...rateArgs(settings),
      '-x265-params',
      x265.join(':'),
      // Apple's players want HEVC in MP4 tagged `hvc1`.
      '-tag:v',
      'hvc1',
      ...keyframes,
    ];
  }
  // SVT-AV1: rc 1 is VBR; CBR needs its low-delay structure; `lp`, the threads it runs.
  const svt = [
    ...(rate.mode === 'vbr' ? ['rc=1'] : rate.mode === 'cbr' ? ['rc=2', 'pred-struct=1'] : []),
    ...(threads === null ? [] : [`lp=${threads}`]),
  ];
  return [
    '-c:v',
    'libsvtav1',
    '-preset',
    String(SVT_PRESETS[speed]),
    ...rateArgs(settings),
    ...(svt.length > 0 ? ['-svtav1-params', svt.join(':')] : []),
    ...keyframes,
  ];
}

/** The sound: AAC at its bitrate, or for ProRes, 24-bit PCM as editors expect. */
export function audioArgs(settings: RenderSettings): string[] {
  const rate = settings.audio.sampleRate === null ? [] : ['-ar', String(settings.audio.sampleRate)];
  if (settings.codec === 'prores') return ['-c:a', 'pcm_s24le', ...rate];
  return ['-c:a', 'aac', '-b:a', kbps(settings.audio.kbps), ...rate];
}

/** The file a render is written as, and what it's served as. */
export function container(settings: RenderSettings): { extension: string; mime: string } {
  return settings.codec === 'prores'
    ? { extension: 'mov', mime: 'video/quicktime' }
    : { extension: 'mp4', mime: 'video/mp4' };
}
