import { z } from 'zod';

/**
 * What a render is, as the engine makes it: the encode's settings and the jobs that burn subtitles
 * into a video, whole or in pieces, with what each answers. subs.rocks composes these jobs (its
 * `@subs/contracts` re-exports every name here), and the engine (`src/engine`) carries them out on
 * subs.rocks's own machines and on a node alike, so a render comes out the same on either.
 *
 * Inputs and outputs are files by name (`ObjectRef`); the engine reads and writes them through
 * its storage host (`engine/io.ts`). On a node the names are the job's own (`original`,
 * `subtitles.ass`), never where subs.rocks keeps them.
 *
 * subs.rocks and the engine deploy apart (a node can run an older engine for weeks), so a field
 * is added optional on the side that reads it, and `ENGINE_VERSION` says which jobs an engine
 * understands.
 */

/**
 * The jobs this engine understands and makes as subs.rocks expects. Bumped when a job gains a
 * field an older engine would ignore, or the same job comes out differently; a node is sent only
 * jobs of its own engine's version.
 */
export const ENGINE_VERSION = 1;

/** The video encoders a render can use: H.264, H.265, AV1, and ProRes for editing. */
export const VIDEO_CODECS = ['h264', 'hevc', 'av1', 'prores'] as const;
export const VideoCodec = z.enum(VIDEO_CODECS);
export type VideoCodec = z.infer<typeof VideoCodec>;

/** The encoders' speed for quality trade, slowest last (x264's and x265's names; AV1's mapped). */
export const ENCODER_SPEEDS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
] as const;
export const EncoderSpeed = z.enum(ENCODER_SPEEDS);
export type EncoderSpeed = z.infer<typeof EncoderSpeed>;

/** ProRes 422 Proxy, LT, 422, HQ, and 4444. */
export const PRORES_PROFILES = ['proxy', 'lt', 'standard', 'hq', '4444'] as const;
export const ProresProfile = z.enum(PRORES_PROFILES);
export type ProresProfile = z.infer<typeof ProresProfile>;

/** Frame rates as people name them, with the exact ratio the encoder is given. */
export const FRAME_RATES = {
  '23.976': '24000/1001',
  '24': '24',
  '25': '25',
  '29.97': '30000/1001',
  '30': '30',
  '48': '48',
  '50': '50',
  '59.94': '60000/1001',
  '60': '60',
} as const;
export type FrameRate = keyof typeof FRAME_RATES;
export const FrameRate = z.enum(Object.keys(FRAME_RATES) as [FrameRate, ...FrameRate[]]);

/** A frame rate's exact ratio as numbers: frame `n` starts at `n * den / num` seconds. */
export function frameRatio(rate: FrameRate): { num: number; den: number } {
  const [num = 0, den = 1] = FRAME_RATES[rate].split('/').map(Number);
  return { num, den };
}

/**
 * The frames a render's video follows: one every `1 / fps`, the first at zero, `frames` of them.
 * On a grid, a render cut into pieces joins frame for frame, whichever machine drew each.
 */
export const FrameGrid = z.object({
  fps: FrameRate,
  frames: z.number().int().positive(),
});
export type FrameGrid = z.infer<typeof FrameGrid>;

/** A video bitrate in kbit/s: 100 kbit/s to 400 Mbit/s. */
const Kbps = z.number().int().min(100).max(400_000);

/**
 * How the encoder spends bits: a constant quality (CRF; lower is better and bigger), optionally
 * capped at a bitrate for streaming; a constant bitrate; or an average bitrate with a ceiling.
 * ProRes has none: its profile sets the quality.
 */
export const RateControl = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('crf'),
    crf: z.number().int().min(0).max(63),
    /** A ceiling for streaming and players with little buffer; null: none. */
    maxKbps: Kbps.nullable(),
  }),
  z.strictObject({ mode: z.literal('cbr'), kbps: Kbps }),
  z.strictObject({ mode: z.literal('vbr'), kbps: Kbps, maxKbps: Kbps }),
]);
export type RateControl = z.infer<typeof RateControl>;

/** The highest CRF each encoder takes (x264 and x265 stop at 51; SVT-AV1 at 63). */
export const MAX_CRF: Readonly<Record<Exclude<VideoCodec, 'prores'>, number>> = {
  h264: 51,
  hevc: 51,
  av1: 63,
};

/** A frame side: even (4:2:0 needs it), 16 to 4096 (DCI 4K's width). */
const Side = z
  .number()
  .int()
  .min(16)
  .max(4096)
  .refine((n) => n % 2 === 0, { error: 'side_odd' });

/** Audio rates a render can resample to; null keeps the original's. */
export const SAMPLE_RATES = [44_100, 48_000] as const;

/**
 * Everything a render's encode is: the picture (codec, frame, rate, bits), and the sound. The frame
 * fits the original inside the size asked for, letterboxed; null keeps the original's size, and a
 * null frame rate keeps its rate. Settings an encoder doesn't use (a rate for ProRes, a ProRes
 * profile for H.264) are kept but don't apply.
 */
export const RenderSettings = z
  .strictObject({
    codec: VideoCodec,
    size: z.strictObject({ width: Side, height: Side }).nullable(),
    fps: FrameRate.nullable(),
    rate: RateControl,
    speed: EncoderSpeed,
    /** 10-bit colour: H.265 and AV1 (ProRes always is; H.264 at 10 bits plays almost nowhere). */
    tenBit: z.boolean(),
    proresProfile: ProresProfile,
    /** A keyframe at least this often, for seeking and streaming; null: the encoder's choice. */
    keyframeSeconds: z.number().min(0.5).max(20).nullable(),
    audio: z.strictObject({
      kbps: z.number().int().min(64).max(512),
      sampleRate: z.union([z.literal(SAMPLE_RATES[0]), z.literal(SAMPLE_RATES[1])]).nullable(),
    }),
  })
  .superRefine((settings, ctx) => {
    const { codec, rate } = settings;
    if (codec !== 'prores' && rate.mode === 'crf' && rate.crf > MAX_CRF[codec]) {
      ctx.addIssue({ code: 'custom', message: 'crf_too_high', path: ['rate', 'crf'] });
    }
    if (rate.mode === 'vbr' && rate.maxKbps < rate.kbps) {
      ctx.addIssue({ code: 'custom', message: 'ceiling_below_average', path: ['rate', 'maxKbps'] });
    }
    if (codec === 'h264' && settings.tenBit) {
      ctx.addIssue({ code: 'custom', message: 'ten_bit_h264', path: ['tenBit'] });
    }
  });
export type RenderSettings = z.infer<typeof RenderSettings>;

/**
 * The video hardware a render can be encoded on: NVIDIA's NVENC, Apple's VideoToolbox (Apple
 * silicon's media engines, Quick Sync on an Intel Mac) and VA-API (Intel's and AMD's graphics on
 * Linux). A job asks only for the machine's hardware (`encoder: 'gpu'`); the machine knows which it
 * has.
 */
export const HARDWARE_KINDS = ['nvenc', 'videotoolbox', 'vaapi'] as const;
export const HardwareKind = z.enum(HARDWARE_KINDS);
export type HardwareKind = z.infer<typeof HardwareKind>;

/**
 * What a render's settings ask of an encoder besides its codec, which a machine's hardware may not
 * do: a constant quality (`crf`), one with a ceiling (`capped`), an average bitrate with a ceiling
 * (`vbr`), a constant bitrate (`cbr`), 10-bit colour, and ProRes 4444. A node tries each on its
 * hardware when it starts, and subs.rocks sends a render there only when it can do all it asks.
 */
export const HARDWARE_FEATURES = ['crf', 'capped', 'vbr', 'cbr', 'tenBit', 'prores4444'] as const;
export const HardwareFeature = z.enum(HARDWARE_FEATURES);
export type HardwareFeature = z.infer<typeof HardwareFeature>;

/** What `settings` ask of the hardware encoding them (`HARDWARE_FEATURES`). */
export function featuresOf(settings: RenderSettings): HardwareFeature[] {
  if (settings.codec === 'prores') return settings.proresProfile === '4444' ? ['prores4444'] : [];
  const { rate } = settings;
  const mode: HardwareFeature =
    rate.mode === 'crf' ? (rate.maxKbps === null ? 'crf' : 'capped') : rate.mode;
  return settings.tenBit && settings.codec !== 'h264' ? [mode, 'tenBit'] : [mode];
}

/** A file a job reads or writes, by its name in storage. */
export const ObjectRef = z.object({ key: z.string().min(1).max(512) });
export type ObjectRef = z.infer<typeof ObjectRef>;

/** A file the engine wrote. */
export const WrittenFile = z.object({
  key: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mime: z.string(),
});
export type WrittenFile = z.infer<typeof WrittenFile>;

/**
 * Burns subtitles into the original: the ASS file an export writes, drawn by libass with the given
 * fonts only, onto the video scaled to fit `width` × `height` (letterboxed), or as it is when
 * those are null. `startPtsMs` puts frames on the canonical timeline the cues are timed on.
 */
export const RenderJob = z.object({
  input: ObjectRef,
  subtitles: ObjectRef,
  /** The workspace's font files the template names; the built-in fonts come with the engine. */
  fonts: z.array(ObjectRef).max(50),
  output: ObjectRef,
  startPtsMs: z.number().int(),
  durationMs: z.number().int().positive(),
  width: z.number().int().positive().max(4096).nullable(),
  height: z.number().int().positive().max(4096).nullable(),
  /**
   * x264's quality (lower is better) and speed, and the sound's bitrate: what a runner older than
   * `settings` encodes by, so a job composed after a deploy still runs on one mid-rollout.
   */
  crf: z.number().int().min(0).max(51),
  speed: z.enum(['veryfast', 'faster', 'fast', 'medium', 'slow']),
  audioKbps: z.number().int().min(64).max(512),
  /** The encode in full (codec, frame rate, bits, sound); the fields above when absent. */
  settings: RenderSettings.optional(),
  /**
   * The frames it draws: the canonical timeline on this grid, up to `frames`. Absent, the
   * original's own timing (jobs composed before grids, and originals with no steady rate).
   */
  grid: FrameGrid.optional(),
  /**
   * Where the engine keeps a `ProgressReport` while it encodes. Optional: a job composed before
   * a deploy can run on the runner after it.
   */
  progress: ObjectRef.optional(),
  /**
   * Stretches of the original left out (its cut-outs, merged, in order): their frames and sound go
   * and what follows moves up; `durationMs` is then the length without them.
   */
  cuts: z
    .array(z.object({ startMs: z.number().int().min(0), endMs: z.number().int().positive() }))
    .max(200)
    .optional(),
  /**
   * What encodes it: the CPU's encoders, or the machine's video hardware (`HARDWARE_KINDS`:
   * NVENC on subs.rocks's GPU machines; on a node, whichever it has), decoding there too where it
   * can, the rest of the render alike. Absent, the CPU's.
   */
  encoder: z.enum(['cpu', 'gpu']).optional(),
});
export type RenderJob = z.infer<typeof RenderJob>;
export type RenderEncoder = NonNullable<RenderJob['encoder']>;

export const RenderResult = z.object({
  output: WrittenFile,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  /**
   * The faces libass drew with, by PostScript name, in the order it picked them, and characters
   * no font had (they came out as boxes). Empty from a runner older than font reports.
   */
  faces: z.array(z.string()).max(50).default([]),
  missingGlyphs: z.array(z.string()).max(100).default([]),
});
export type RenderResult = z.infer<typeof RenderResult>;

/** How far an encode is, as the engine writes it while it works (`RenderJob.progress`). */
export type ProgressReport = { fraction: number; remainingMs: number | null };

/** The most pieces a render is cut into: four hours of 4K HEVC at about a minute and a half each. */
export const MAX_RENDER_PIECES = 240;

/**
 * A render in pieces: its frames cut into pieces no machine takes long over, each drawn and
 * encoded by a machine of its own (`render_piece`), its sound made once beside them
 * (`render_audio`), then joined into one file, checked frame for frame (`render_join`).
 */

/** One piece: its frames on the render's grid, and where reading the original starts for them. */
export const RenderPiece = z.object({
  index: z
    .number()
    .int()
    .min(0)
    .max(MAX_RENDER_PIECES - 1),
  /** Its frames, `startFrame` up to `endFrame` (not included). */
  startFrame: z.number().int().min(0),
  endFrame: z.number().int().positive(),
  /**
   * Where reading the original starts, on its canonical timeline: a little before the piece's
   * first frame, so the frame showing then is decoded whole.
   */
  seekMs: z.number().int().min(0),
});
export type RenderPiece = z.infer<typeof RenderPiece>;

/** A piece of a render: the render's job, on its grid, drawing only the piece's frames. */
export const RenderPieceJob = RenderJob.extend({ grid: FrameGrid, piece: RenderPiece });
export type RenderPieceJob = z.infer<typeof RenderPieceJob>;

export const RenderPieceResult = z.object({
  /** The piece's video alone, in the render's codec and container. */
  output: WrittenFile,
  /** The frames it holds: the piece's, but for a last piece of a video that ends early. */
  frames: z.number().int().nonnegative(),
  faces: RenderResult.shape.faces,
  missingGlyphs: RenderResult.shape.missingGlyphs,
});
export type RenderPieceResult = z.infer<typeof RenderPieceResult>;

/** A render's sound, made once, as the whole render would make it. */
export const RenderAudioJob = z.object({
  input: ObjectRef,
  output: ObjectRef,
  startPtsMs: z.number().int(),
  durationMs: z.number().int().positive(),
  cuts: RenderJob.shape.cuts,
  settings: RenderSettings,
});
export type RenderAudioJob = z.infer<typeof RenderAudioJob>;

/** The sound, or null when the original has none. */
export const RenderAudioResult = z.object({ output: WrittenFile.nullable() });
export type RenderAudioResult = z.infer<typeof RenderAudioResult>;

/**
 * The pieces joined, in order, with the sound: refused (not retried) unless every piece is
 * encoded alike and the frames come out whole and in order, so the render is made on one machine
 * instead.
 */
export const RenderJoinJob = z.object({
  pieces: z
    .array(z.object({ key: z.string().min(1).max(512), frames: z.number().int().positive() }))
    .min(2)
    .max(MAX_RENDER_PIECES),
  audio: ObjectRef.nullable(),
  grid: FrameGrid,
  settings: RenderSettings,
  output: ObjectRef,
});
export type RenderJoinJob = z.infer<typeof RenderJoinJob>;

export const RenderJoinResult = RenderResult.pick({
  output: true,
  width: true,
  height: true,
  durationMs: true,
});
export type RenderJoinResult = z.infer<typeof RenderJoinResult>;

/**
 * Why a job failed, as the engine says: something went wrong that may pass (`processing_failed`:
 * a dropped connection, a machine out of memory), or the video itself can't be read
 * (`corrupt_media`) or decoded (`unsupported_media`).
 */
export const ENGINE_ERRORS = ['processing_failed', 'corrupt_media', 'unsupported_media'] as const;
export const EngineError = z.enum(ENGINE_ERRORS);
export type EngineError = z.infer<typeof EngineError>;

/** A job that failed: why, whether trying again may help, and what the tools said. */
export const JobFailure = z.object({
  code: EngineError,
  retryable: z.boolean(),
  detail: z.string().max(2000),
});
export type JobFailure = z.infer<typeof JobFailure>;
