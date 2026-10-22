import type {
  EncoderSpeed,
  HardwareFeature,
  HardwareKind,
  RenderSettings,
  VideoCodec,
} from '../job.ts';

/**
 * A render's encode on video hardware, as ffmpeg drives each kind: NVIDIA's NVENC, Apple's
 * VideoToolbox and VA-API (Intel's and AMD's graphics on Linux). Its device, how it reads the
 * original (decoding on the hardware where it can; ffmpeg decodes on the CPU what it can't), how
 * frames reach it, their pixel format, and the encoder with its rate control. The node tries every
 * combination of these on its hardware when it starts (`agent/hardware.ts`), with these very
 * arguments, so a render asks only for what was seen to work.
 */

/** The hardware a machine encodes on. */
export type Hardware = {
  kind: HardwareKind;
  /** VA-API's device (`/dev/dri/renderD128`); null for the others, which find their own. */
  device: string | null;
  /** Whether it decodes the original too, as it did when tried. */
  decode: boolean;
};

/** subs.rocks's GPU machines' hardware: an NVIDIA GPU's, which a job asking for one gets. */
export const NVENC: Hardware = { kind: 'nvenc', device: null, decode: true };

/** Each kind's encoder for each codec it makes. */
const ENCODERS: Readonly<Record<HardwareKind, Partial<Record<VideoCodec, string>>>> = {
  nvenc: { h264: 'h264_nvenc', hevc: 'hevc_nvenc', av1: 'av1_nvenc' },
  videotoolbox: {
    h264: 'h264_videotoolbox',
    hevc: 'hevc_videotoolbox',
    prores: 'prores_videotoolbox',
  },
  vaapi: { h264: 'h264_vaapi', hevc: 'hevc_vaapi', av1: 'av1_vaapi' },
};

/**
 * What each kind's encoders can honour of `HARDWARE_FEATURES`, if its driver and chip do: a node
 * tries these alone. VA-API has no ceiling on a constant quality.
 */
export const HARDWARE_CAN: Readonly<Record<HardwareKind, readonly HardwareFeature[]>> = {
  nvenc: ['crf', 'capped', 'vbr', 'cbr', 'tenBit'],
  videotoolbox: ['crf', 'capped', 'vbr', 'cbr', 'tenBit', 'prores4444'],
  vaapi: ['crf', 'vbr', 'cbr', 'tenBit'],
};

/** The encoder `kind` makes `codec` with, or null when it has none. */
export function hardwareEncoder(kind: HardwareKind, codec: VideoCodec): string | null {
  return ENCODERS[kind][codec] ?? null;
}

/** NVENC's presets (p1 fastest, p7 best) for the speeds x264 and x265 name. */
const NVENC_PRESETS: Readonly<Record<EncoderSpeed, string>> = {
  ultrafast: 'p1',
  superfast: 'p2',
  veryfast: 'p3',
  faster: 'p4',
  fast: 'p4',
  medium: 'p5',
  slow: 'p6',
  slower: 'p7',
  veryslow: 'p7',
};

/** Speeds at which VideoToolbox is asked to favour speed over quality. */
const VT_FAST: ReadonlySet<EncoderSpeed> = new Set(['ultrafast', 'superfast', 'veryfast']);

/** VideoToolbox's ProRes profiles, by the names the settings use. */
const VT_PRORES: Readonly<Record<RenderSettings['proresProfile'], string>> = {
  proxy: 'proxy',
  lt: 'lt',
  standard: 'standard',
  hq: 'hq',
  '4444': '4444',
};

/**
 * A CRF as VideoToolbox's constant quality (0 to 100, higher better, on Apple silicon): 110 − 2 ×
 * CRF, which puts x264's default of 23 at 64, about where Apple's encoder is as good to look at.
 */
export function videotoolboxQuality(crf: number): number {
  return Math.max(1, Math.min(100, Math.round(110 - 2 * crf)));
}

/** A CRF as VA-API's constant QP: the same scale for H.264 and H.265; AV1's runs to 255. */
export function vaapiQp(codec: VideoCodec, crf: number): number {
  return codec === 'av1' ? Math.min(255, Math.round((crf * 255) / 63)) : crf;
}

const kbps = (n: number) => `${n}k`;

/** What ffmpeg is told before the original: the device, and decoding there. */
export function hardwareInputArgs(on: Hardware): string[] {
  const device =
    on.kind === 'vaapi' && on.device
      ? ['-init_hw_device', `vaapi=hw:${on.device}`, '-filter_hw_device', 'hw']
      : [];
  if (!on.decode) return device;
  const decode =
    on.kind === 'nvenc'
      ? ['-hwaccel', 'cuda']
      : on.kind === 'videotoolbox'
        ? ['-hwaccel', 'videotoolbox']
        : ['-hwaccel', 'vaapi', '-hwaccel_device', 'hw'];
  return [...device, ...decode];
}

/**
 * The frames' pixel format for the hardware: 4:2:0 at 8 or 10 bits, as each takes it (NV12 and
 * P010 where that's its own); ProRes on VideoToolbox 4:2:2, or 4:4:4 for 4444, at 10 bits.
 */
export function hardwarePixelFormat(kind: HardwareKind, settings: RenderSettings): string {
  if (settings.codec === 'prores') return settings.proresProfile === '4444' ? 'p410le' : 'p210le';
  const tenBit = settings.tenBit && settings.codec !== 'h264';
  if (kind === 'nvenc') return tenBit ? 'p010le' : 'yuv420p';
  return tenBit ? 'p010le' : 'nv12';
}

/** The filters after the pixel format that take frames to the hardware: VA-API's upload. */
export function hardwareUpload(kind: HardwareKind): string[] {
  return kind === 'vaapi' ? ['hwupload'] : [];
}

/**
 * How far above a CRF NVENC's `-cq` makes what x264 and x265 make at that CRF (ADR 0081). The same
 * number asks NVENC for near-lossless: measured on an L4 with 4K footage (VMAF against the
 * source, mean and fifth percentile), `-cq` 18 wrote 1.5 to 1.7 times x264's bytes at CRF 18, and
 * `-cq` 25 matched it, for H.264 and H.265 alike. AV1 wasn't measured: its CRF is taken as it is.
 */
export const NVENC_CQ_OVER_CRF = 7;

/** A CRF as NVENC's constant quality (`-cq`, 0 to 51). */
export function nvencQuality(codec: VideoCodec, crf: number): number {
  return codec === 'av1' ? crf : Math.min(51, crf + NVENC_CQ_OVER_CRF);
}

/** NVENC's rate control: a constant quality as its `-cq` (`nvencQuality`). */
function nvencRate(settings: RenderSettings): string[] {
  const { rate } = settings;
  if (rate.mode === 'crf') {
    const cap = rate.maxKbps;
    return [
      '-rc',
      'vbr',
      '-cq',
      String(nvencQuality(settings.codec, rate.crf)),
      '-b:v',
      '0',
      ...(cap === null ? [] : ['-maxrate', kbps(cap), '-bufsize', kbps(cap * 2)]),
    ];
  }
  if (rate.mode === 'cbr') {
    const k = kbps(rate.kbps);
    return ['-rc', 'cbr', '-b:v', k, '-maxrate', k, '-bufsize', k];
  }
  return [
    '-rc',
    'vbr',
    '-b:v',
    kbps(rate.kbps),
    '-maxrate',
    kbps(rate.maxKbps),
    '-bufsize',
    kbps(rate.maxKbps * 2),
  ];
}

/**
 * VideoToolbox's: a constant quality (`videotoolboxQuality`), its ceiling as a data rate limit;
 * an average bitrate with its ceiling; or a constant bitrate (macOS 13 on).
 */
function videotoolboxRate(settings: RenderSettings): string[] {
  const { rate } = settings;
  if (rate.mode === 'crf') {
    const cap = rate.maxKbps;
    return [
      '-q:v',
      String(videotoolboxQuality(rate.crf)),
      ...(cap === null ? [] : ['-maxrate', kbps(cap)]),
    ];
  }
  if (rate.mode === 'cbr') return ['-b:v', kbps(rate.kbps), '-constant_bit_rate', '1'];
  return ['-b:v', kbps(rate.kbps), '-maxrate', kbps(rate.maxKbps)];
}

/**
 * VA-API's: a constant QP, which every driver has (a ceiling on it, none: `HARDWARE_CAN`), or the
 * bitrate modes by name, so a driver without one fails when tried rather than picking another.
 */
function vaapiRate(settings: RenderSettings): string[] {
  const { rate, codec } = settings;
  if (rate.mode === 'crf') {
    return ['-rc_mode', 'CQP', '-global_quality', String(vaapiQp(codec, rate.crf))];
  }
  if (rate.mode === 'cbr') {
    const k = kbps(rate.kbps);
    return ['-rc_mode', 'CBR', '-b:v', k, '-maxrate', k, '-bufsize', k];
  }
  return [
    '-rc_mode',
    'VBR',
    '-b:v',
    kbps(rate.kbps),
    '-maxrate',
    kbps(rate.maxKbps),
    '-bufsize',
    kbps(rate.maxKbps * 2),
  ];
}

/** The encoder and its settings on `kind`'s hardware; `keyframes` where the render forces them. */
export function hardwareVideoArgs(
  kind: HardwareKind,
  settings: RenderSettings,
  keyframes: string[],
): string[] {
  const { codec } = settings;
  const encoder = hardwareEncoder(kind, codec);
  if (!encoder) throw new Error(`${kind} doesn't encode ${codec}`);
  if (codec === 'prores') {
    return ['-c:v', encoder, '-profile:v', VT_PRORES[settings.proresProfile], '-allow_sw', '0'];
  }
  const tenBit = settings.tenBit && codec !== 'h264';
  const profile = [
    ...(codec === 'h264' ? ['-profile:v', 'high'] : []),
    ...(codec === 'hevc' ? ['-profile:v', tenBit ? 'main10' : 'main', '-tag:v', 'hvc1'] : []),
  ];
  if (kind === 'nvenc') {
    return [
      '-c:v',
      encoder,
      '-preset',
      NVENC_PRESETS[settings.speed],
      '-tune',
      'hq',
      ...nvencRate(settings),
      ...profile,
      ...keyframes,
    ];
  }
  if (kind === 'videotoolbox') {
    return [
      '-c:v',
      encoder,
      // Its hardware or nothing: Apple's software encoders are slower than x264 and x265.
      '-allow_sw',
      '0',
      '-prio_speed',
      VT_FAST.has(settings.speed) ? '1' : '0',
      ...videotoolboxRate(settings),
      ...profile,
      ...keyframes,
    ];
  }
  return ['-c:v', encoder, ...vaapiRate(settings), ...profile, ...keyframes];
}
