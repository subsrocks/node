import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { formatFilters } from '../engine/encode.ts';
import {
  HARDWARE_CAN,
  type Hardware,
  hardwareEncoder,
  hardwareInputArgs,
  hardwareVideoArgs,
} from '../engine/hardware.ts';
import type { HardwareFeature, HardwareKind, RenderSettings, VideoCodec } from '../job.ts';
import type { NodeMachine } from '../protocol.ts';
import type { GpuUse } from './options.ts';
import type { Tools } from './tools.ts';

/**
 * The video hardware this machine encodes on, found out once at start: an NVIDIA GPU (NVENC,
 * when `nvidia-smi` sees one), Apple's VideoToolbox on a Mac (its chip's media engines, or Quick
 * Sync on an Intel Mac), or Intel's and AMD's graphics on Linux (VA-API, each render device in
 * `/dev/dri`). Every codec it has an encoder for is tried on a few frames, in each way a render
 * can ask of it (`HARDWARE_CAN`), with the very arguments a render uses, and decoding there too:
 * a driver that's missing, too old or without a mode shows up here, not halfway through someone's
 * render, and subs.rocks sends it only renders it was seen to make.
 */

/** What was found: the hardware a render runs on, what it's called, and what each codec can do. */
export type FoundHardware = {
  hardware: Hardware;
  name: string;
  features: Partial<Record<VideoCodec, HardwareFeature[]>>;
};

type Capture = (
  command: string,
  args: readonly string[],
  options?: { stderr?: boolean; timeoutMs?: number },
) => Promise<string | null>;

/** Settings that ask a codec for one feature each, as a render would: 640×360, keyframes every 2 s. */
export function trialSettings(
  codec: VideoCodec,
  feature: HardwareFeature | 'base',
): RenderSettings {
  const settings: RenderSettings = {
    codec,
    size: null,
    fps: null,
    rate: { mode: 'vbr', kbps: 4000, maxKbps: 6000 },
    speed: 'medium',
    tenBit: false,
    proresProfile: 'hq',
    keyframeSeconds: 2,
    audio: { kbps: 128, sampleRate: null },
  };
  if (feature === 'crf') return { ...settings, rate: { mode: 'crf', crf: 23, maxKbps: null } };
  if (feature === 'capped') return { ...settings, rate: { mode: 'crf', crf: 23, maxKbps: 6000 } };
  if (feature === 'cbr') return { ...settings, rate: { mode: 'cbr', kbps: 4000 } };
  if (feature === 'tenBit') return { ...settings, tenBit: true };
  if (feature === 'prores4444') return { ...settings, proresProfile: '4444' };
  return settings;
}

/** The arguments of a trial encode: ten frames made as a render makes them, thrown away. */
export function trialArgs(on: Hardware, settings: RenderSettings): string[] {
  return [
    '-hide_banner',
    '-v',
    'error',
    ...hardwareInputArgs({ ...on, decode: false }),
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=30',
    '-frames:v',
    '10',
    '-vf',
    formatFilters(settings, on).join(','),
    ...hardwareVideoArgs(on.kind, settings, ['-force_key_frames', 'expr:gte(t,n_forced*2)']),
    '-f',
    'null',
    '-',
  ];
}

/** What `on` encodes, codec by codec: each the features it was seen to do; codecs with none left out. */
async function trial(
  tools: Tools,
  capture: Capture,
  on: Hardware,
  encoders: ReadonlySet<string>,
): Promise<FoundHardware['features']> {
  const features: FoundHardware['features'] = {};
  const codecs: VideoCodec[] = ['h264', 'hevc', 'av1', 'prores'];
  for (const codec of codecs) {
    const encoder = hardwareEncoder(on.kind, codec);
    if (!encoder || !encoders.has(encoder)) continue;
    const works = async (feature: HardwareFeature | 'base') =>
      (await capture(tools.ffmpeg, trialArgs(on, trialSettings(codec, feature)), {
        timeoutMs: 30_000,
      })) !== null;
    const found: HardwareFeature[] = [];
    if (codec === 'prores') {
      // ProRes has no rate to ask for: its profile (422 HQ) is the base.
      if (!(await works('base'))) continue;
      if (HARDWARE_CAN[on.kind].includes('prores4444') && (await works('prores4444'))) {
        found.push('prores4444');
      }
      features[codec] = found;
      continue;
    }
    for (const feature of HARDWARE_CAN[on.kind]) {
      if (feature === 'prores4444' || feature === 'tenBit') continue;
      if (await works(feature)) found.push(feature);
    }
    if (found.length === 0) continue;
    if (codec !== 'h264' && HARDWARE_CAN[on.kind].includes('tenBit') && (await works('tenBit'))) {
      found.push('tenBit');
    }
    features[codec] = found;
  }
  return features;
}

/** Whether `on` decodes a few frames of H.264 (made here by the CPU first). */
async function decodes(
  tools: Tools,
  capture: Capture,
  on: Hardware,
  dir: string,
): Promise<boolean> {
  const clip = join(dir, 'clip.mp4');
  const made = await capture(tools.ffmpeg, [
    '-hide_banner',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=30',
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
    ...hardwareInputArgs({ ...on, decode: true }),
    '-i',
    clip,
    '-f',
    'null',
    '-',
  ]);
  return decoded !== null;
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

/**
 * A VA-API device's name from its driver's (`ffmpeg -v verbose` says it): Mesa's names AMD's card
 * (`… for AMD Radeon RX 7900 XTX (radeonsi, …)`); Intel's driver names only itself.
 */
export function vaapiName(log: string): string | null {
  const driver = /VAAPI driver: (.+?)\.?\s*$/m.exec(log)?.[1];
  if (!driver) return null;
  const card = /^Mesa .*? for (.+?) \(/.exec(driver)?.[1];
  if (card) return card.slice(0, 120);
  if (/intel/i.test(driver)) return 'Intel graphics';
  return driver.slice(0, 120);
}

/** VA-API's render devices, in order. */
async function renderDevices(): Promise<string[]> {
  try {
    const names = await readdir('/dev/dri');
    return names
      .filter((name) => /^renderD\d+$/.test(name))
      .sort()
      .map((name) => `/dev/dri/${name}`);
  } catch {
    return [];
  }
}

/** How many codecs and features a find has: the better of two devices has more. */
const reach = (features: FoundHardware['features']) =>
  Object.values(features).reduce((sum, list) => sum + 1 + (list?.length ?? 0), 0);

export type HardwareSearch = {
  found: FoundHardware | null;
  /** NVIDIA's GPUs `nvidia-smi` sees, whether or not they encode. */
  nvidia: NodeMachine['gpus'];
  notes: string[];
};

/** The machine's video hardware, tried (`--gpu off`: none). */
export async function findHardware(options: {
  tools: Tools;
  capture: Capture;
  gpu: GpuUse;
  encoders: ReadonlySet<string>;
  platform: NodeJS.Platform;
  cpuModel: string;
  /** A folder to make a clip in. */
  scratch: string;
}): Promise<HardwareSearch> {
  const { tools, capture, encoders } = options;
  const notes: string[] = [];
  const listed = (kind: HardwareKind) =>
    (['h264', 'hevc', 'av1', 'prores'] as const).some((codec) => {
      const encoder = hardwareEncoder(kind, codec);
      return encoder !== null && encoders.has(encoder);
    });
  const kinds = (['nvenc', 'videotoolbox', 'vaapi'] as const).filter(listed);
  if (options.gpu === 'off') {
    if (kinds.length > 0) notes.push('not encoding on video hardware (--gpu off)');
    return { found: null, nvidia: [], notes };
  }
  const found = async (on: Hardware, name: string): Promise<FoundHardware | null> => {
    const features = await trial(tools, capture, on, encoders);
    if (Object.keys(features).length === 0) return null;
    const decode = await decodes(tools, capture, on, options.scratch);
    return { hardware: { ...on, decode }, name, features };
  };

  // NVIDIA's first: a GPU of its own is the fastest there is.
  let nvidia: NodeMachine['gpus'] = [];
  if (kinds.includes('nvenc') && options.platform !== 'darwin') {
    const smi = await capture('nvidia-smi', [
      '--query-gpu=name,memory.total',
      '--format=csv,noheader,nounits',
    ]);
    nvidia = smi === null ? [] : nvidiaGpus(smi);
    const first = nvidia[0];
    if (first) {
      const nvenc = await found({ kind: 'nvenc', device: null, decode: true }, first.name);
      if (nvenc) return { found: nvenc, nvidia, notes };
      notes.push(`the NVIDIA GPU's encoders didn't work (is its driver installed?)`);
    }
  }
  if (kinds.includes('videotoolbox') && options.platform === 'darwin') {
    const vt = await found({ kind: 'videotoolbox', device: null, decode: true }, options.cpuModel);
    if (vt) return { found: vt, nvidia, notes };
    notes.push("this Mac's video encoders didn't work: encoding on the CPU");
  }
  if (kinds.includes('vaapi') && options.platform === 'linux') {
    let best: FoundHardware | null = null;
    for (const device of await renderDevices()) {
      const log = await capture(
        tools.ffmpeg,
        [
          '-hide_banner',
          '-v',
          'verbose',
          '-init_hw_device',
          `vaapi=hw:${device}`,
          '-f',
          'lavfi',
          '-i',
          'nullsrc=size=64x64',
          '-frames:v',
          '1',
          '-f',
          'null',
          '-',
        ],
        { stderr: true },
      );
      if (log === null) continue;
      const vaapi = await found(
        { kind: 'vaapi', device, decode: true },
        vaapiName(log) ?? 'Graphics',
      );
      if (vaapi && (!best || reach(vaapi.features) > reach(best.features))) best = vaapi;
    }
    if (best) return { found: best, nvidia, notes };
    if ((await renderDevices()).length > 0) {
      notes.push("the graphics' video encoders didn't work (is its VA-API driver installed?)");
    }
  }
  return { found: null, nvidia, notes };
}
