import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { tryEncode } from '../scripts/encoders.ts';
import {
  audioArgs,
  container,
  decodeArgs,
  encoderOf,
  FPS_RATIOS,
  formatFilters,
  fpsFilter,
  pixelFormat,
  settingsOf,
  videoArgs,
} from '../src/engine/encode.ts';
import { ENCODES } from '../src/engine/encode-matrix.ts';
import {
  type Hardware,
  hardwareEncoder,
  NVENC,
  vaapiQp,
  videotoolboxQuality,
} from '../src/engine/hardware.ts';
import { renderFilter } from '../src/engine/render.ts';
import { FRAME_RATES, featuresOf, type RenderJob, RenderSettings } from '../src/job.ts';

/** 1080p H.264 at CRF 20, Medium, the original's rate and sound at 192 kbit/s. */
const h264: RenderSettings = {
  codec: 'h264',
  size: { width: 1920, height: 1080 },
  fps: null,
  rate: { mode: 'crf', crf: 20, maxKbps: null },
  speed: 'medium',
  tenBit: false,
  proresProfile: 'hq',
  keyframeSeconds: null,
  audio: { kbps: 192, sampleRate: null },
};

describe('a render’s encode', () => {
  it('reads a job from before settings as the H.264 it was', () => {
    const legacy = {
      width: 1920,
      height: 1080,
      crf: 20,
      speed: 'medium',
      audioKbps: 192,
    } as RenderJob;
    expect(settingsOf(legacy)).toEqual(h264);
  });

  it('keeps frame rates as the contract names them', () => {
    expect(FPS_RATIOS).toEqual(FRAME_RATES);
  });

  it('writes H.264 at a quality, capped, constant or average', () => {
    expect(videoArgs(h264)).toEqual([
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '20',
      '-profile:v',
      'high',
    ]);
    expect(videoArgs({ ...h264, rate: { mode: 'crf', crf: 20, maxKbps: 8000 } })).toEqual([
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '20',
      '-maxrate',
      '8000k',
      '-bufsize',
      '16000k',
      '-profile:v',
      'high',
    ]);
    expect(videoArgs({ ...h264, rate: { mode: 'cbr', kbps: 6000 } })).toEqual([
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-b:v',
      '6000k',
      '-minrate',
      '6000k',
      '-maxrate',
      '6000k',
      '-bufsize',
      '6000k',
      '-x264-params',
      'nal-hrd=cbr',
      '-profile:v',
      'high',
    ]);
    expect(
      videoArgs({ ...h264, rate: { mode: 'vbr', kbps: 6000, maxKbps: 9000 }, keyframeSeconds: 2 }),
    ).toEqual([
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-b:v',
      '6000k',
      '-maxrate',
      '9000k',
      '-bufsize',
      '18000k',
      '-profile:v',
      'high',
      '-force_key_frames',
      'expr:gte(t,n_forced*2)',
    ]);
  });

  it('tags H.265 for Apple’s players, and gives AV1 its own speeds and rate modes', () => {
    expect(videoArgs({ ...h264, codec: 'hevc', speed: 'slow' })).toEqual([
      '-c:v',
      'libx265',
      '-preset',
      'slow',
      '-crf',
      '20',
      '-x265-params',
      'log-level=error',
      '-tag:v',
      'hvc1',
    ]);
    expect(
      videoArgs({ ...h264, codec: 'av1', rate: { mode: 'crf', crf: 30, maxKbps: null } }),
    ).toEqual(['-c:v', 'libsvtav1', '-preset', '6', '-crf', '30']);
    // SVT-AV1 takes no ceiling outside a constant quality.
    expect(
      videoArgs({ ...h264, codec: 'av1', rate: { mode: 'vbr', kbps: 4000, maxKbps: 8000 } }),
    ).toEqual(['-c:v', 'libsvtav1', '-preset', '6', '-b:v', '4000k', '-svtav1-params', 'rc=1']);
    expect(videoArgs({ ...h264, codec: 'av1', rate: { mode: 'cbr', kbps: 4000 } })).toEqual([
      '-c:v',
      'libsvtav1',
      '-preset',
      '6',
      '-b:v',
      '4000k',
      '-svtav1-params',
      'rc=2:pred-struct=1',
    ]);
  });

  it('writes ProRes by its profile, with PCM sound, in QuickTime', () => {
    const prores = { ...h264, codec: 'prores' as const, proresProfile: '4444' as const };
    expect(videoArgs(prores)).toEqual(['-c:v', 'prores_ks', '-profile:v', '4', '-vendor', 'apl0']);
    expect(audioArgs(prores)).toEqual(['-c:a', 'pcm_s24le']);
    expect(pixelFormat(prores)).toBe('yuv444p10le');
    expect(pixelFormat({ ...prores, proresProfile: 'hq' })).toBe('yuv422p10le');
    expect(container(prores)).toEqual({ extension: 'mov', mime: 'video/quicktime' });
    expect(container(h264)).toEqual({ extension: 'mp4', mime: 'video/mp4' });
  });

  it('draws at the render’s frame rate and in its pixel format', () => {
    const job = {
      startPtsMs: 40,
      settings: { ...h264, codec: 'hevc', tenBit: true, fps: '23.976' },
    } as RenderJob;
    expect(fpsFilter(settingsOf(job))).toBe('fps=24000/1001');
    expect(renderFilter(job)).toBe(
      'setpts=PTS-0.040/TB,fps=24000/1001,scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,ass=filename=subtitles.ass:fontsdir=fonts,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p10le',
    );
    expect(audioArgs({ ...h264, audio: { kbps: 320, sampleRate: 48_000 } })).toEqual([
      '-c:a',
      'aac',
      '-b:a',
      '320k',
      '-ar',
      '48000',
    ]);
  });

  it('encodes on the GPU with NVENC, decoding there too, the rate and speed carried over', () => {
    const hevc: RenderSettings = {
      ...h264,
      codec: 'hevc',
      speed: 'medium',
      rate: { mode: 'vbr', kbps: 30_000, maxKbps: 60_000 },
    };
    expect(videoArgs(hevc, 0, NVENC)).toEqual([
      '-c:v',
      'hevc_nvenc',
      '-preset',
      'p5',
      '-tune',
      'hq',
      '-rc',
      'vbr',
      '-b:v',
      '30000k',
      '-maxrate',
      '60000k',
      '-bufsize',
      '120000k',
      '-profile:v',
      'main',
      '-tag:v',
      'hvc1',
    ]);
    expect(decodeArgs(NVENC)).toEqual(['-hwaccel', 'cuda']);
    expect(decodeArgs()).toEqual([]);
    // A constant quality as NVENC's own, capped; H.264 at High; 10 bits as P010.
    const capped = videoArgs(h264, 0, NVENC);
    expect(capped.slice(0, 2)).toEqual(['-c:v', 'h264_nvenc']);
    expect(capped).toEqual(
      expect.arrayContaining(['-cq', String((h264.rate as { crf: number }).crf)]),
    );
    expect(capped).toEqual(expect.arrayContaining(['-profile:v', 'high']));
    const tenBit: RenderSettings = { ...hevc, tenBit: true };
    expect(pixelFormat(tenBit, NVENC)).toBe('p010le');
    expect(pixelFormat(tenBit)).toBe('yuv420p10le');
    expect(videoArgs(tenBit, 0, NVENC)).toEqual(expect.arrayContaining(['-profile:v', 'main10']));
    expect(videoArgs({ ...hevc, codec: 'av1' }, 0, NVENC).slice(0, 2)).toEqual([
      '-c:v',
      'av1_nvenc',
    ]);
  });

  it('asks for the hardware a job asks for, when it makes the codec; ProRes on NVENC is the CPU’s', () => {
    const job = (codec: RenderSettings['codec'], encoder?: 'cpu' | 'gpu') =>
      ({ encoder, settings: { ...h264, codec } }) as RenderJob;
    const vt: Hardware = { kind: 'videotoolbox', device: null, decode: true };
    expect(encoderOf(job('hevc', 'gpu'))).toEqual(NVENC);
    expect(encoderOf(job('hevc'))).toBeNull();
    expect(encoderOf(job('prores', 'gpu'))).toBeNull();
    expect(encoderOf(job('prores', 'gpu'), vt)).toEqual(vt);
    expect(encoderOf(job('av1', 'gpu'), vt)).toBeNull();
    expect(hardwareEncoder('vaapi', 'av1')).toBe('av1_vaapi');
  });

  it('encodes on a Mac with VideoToolbox: its hardware only, NV12, a quality from the CRF', () => {
    const vt: Hardware = { kind: 'videotoolbox', device: null, decode: true };
    expect(videoArgs(h264, 0, vt)).toEqual([
      '-c:v',
      'h264_videotoolbox',
      '-allow_sw',
      '0',
      '-prio_speed',
      '0',
      '-q:v',
      '70',
      '-profile:v',
      'high',
    ]);
    expect(videotoolboxQuality(23)).toBe(64);
    expect(videotoolboxQuality(0)).toBe(100);
    expect(videotoolboxQuality(60)).toBe(1);
    const hevc: RenderSettings = { ...h264, codec: 'hevc', speed: 'veryfast', tenBit: true };
    expect(videoArgs({ ...hevc, rate: { mode: 'cbr', kbps: 8000 } }, 0, vt)).toEqual([
      '-c:v',
      'hevc_videotoolbox',
      '-allow_sw',
      '0',
      '-prio_speed',
      '1',
      '-b:v',
      '8000k',
      '-constant_bit_rate',
      '1',
      '-profile:v',
      'main10',
      '-tag:v',
      'hvc1',
    ]);
    expect(pixelFormat(hevc, vt)).toBe('p010le');
    expect(pixelFormat(h264, vt)).toBe('nv12');
    expect(decodeArgs(vt)).toEqual(['-hwaccel', 'videotoolbox']);
    // ProRes on its ProRes engines, at 10 bits, 4:2:2 or 4:4:4.
    const prores: RenderSettings = { ...h264, codec: 'prores', proresProfile: '4444' };
    expect(videoArgs(prores, 0, vt)).toEqual([
      '-c:v',
      'prores_videotoolbox',
      '-profile:v',
      '4444',
      '-allow_sw',
      '0',
    ]);
    expect(pixelFormat(prores, vt)).toBe('p410le');
    expect(pixelFormat({ ...prores, proresProfile: 'hq' }, vt)).toBe('p210le');
  });

  it('encodes on Intel’s and AMD’s graphics with VA-API: its device, an upload, modes by name', () => {
    const va: Hardware = { kind: 'vaapi', device: '/dev/dri/renderD128', decode: true };
    expect(decodeArgs(va)).toEqual([
      '-init_hw_device',
      'vaapi=hw:/dev/dri/renderD128',
      '-filter_hw_device',
      'hw',
      '-hwaccel',
      'vaapi',
      '-hwaccel_device',
      'hw',
    ]);
    expect(decodeArgs({ ...va, decode: false })).toEqual([
      '-init_hw_device',
      'vaapi=hw:/dev/dri/renderD128',
      '-filter_hw_device',
      'hw',
    ]);
    expect(formatFilters(h264, va)).toEqual(['format=nv12', 'hwupload']);
    expect(videoArgs(h264, 0, va)).toEqual([
      '-c:v',
      'h264_vaapi',
      '-rc_mode',
      'CQP',
      '-global_quality',
      '20',
      '-profile:v',
      'high',
    ]);
    expect(vaapiQp('av1', 63)).toBe(255);
    const vbr: RenderSettings = {
      ...h264,
      codec: 'av1',
      rate: { mode: 'vbr', kbps: 6000, maxKbps: 9000 },
    };
    expect(videoArgs(vbr, 0, va)).toEqual([
      '-c:v',
      'av1_vaapi',
      '-rc_mode',
      'VBR',
      '-b:v',
      '6000k',
      '-maxrate',
      '9000k',
      '-bufsize',
      '18000k',
    ]);
    const job = {
      startPtsMs: 0,
      encoder: 'gpu',
      settings: { ...h264, size: null },
    } as RenderJob;
    expect(renderFilter(job, undefined, va)).toBe(
      'setpts=PTS-0.000/TB,ass=filename=subtitles.ass:fontsdir=fonts,format=nv12,hwupload',
    );
  });

  it('says what a render asks of hardware', () => {
    expect(featuresOf(h264)).toEqual(['crf']);
    expect(featuresOf({ ...h264, rate: { mode: 'crf', crf: 20, maxKbps: 8000 } })).toEqual([
      'capped',
    ]);
    expect(
      featuresOf({ ...h264, codec: 'hevc', tenBit: true, rate: { mode: 'cbr', kbps: 1000 } }),
    ).toEqual(['cbr', 'tenBit']);
    expect(featuresOf({ ...h264, tenBit: true })).toEqual(['crf']);
    expect(featuresOf({ ...h264, codec: 'prores', proresProfile: '4444' })).toEqual(['prores4444']);
    expect(featuresOf({ ...h264, codec: 'prores' })).toEqual([]);
  });

  it('gives each CPU encoder the threads it may use', () => {
    // x264 half as many again, as it runs itself.
    expect(videoArgs(h264, 0, null, 4)).toEqual(expect.arrayContaining(['-threads', '6']));
    expect(videoArgs({ ...h264, codec: 'prores' }, 0, null, 4)).toEqual(
      expect.arrayContaining(['-threads', '4']),
    );
    expect(decodeArgs(null, 4)).toEqual(['-filter_threads', '4', '-threads', '4']);
    const x265 = videoArgs({ ...h264, codec: 'hevc' }, 0, null, 4);
    expect(x265[x265.indexOf('-x265-params') + 1]).toBe('log-level=error:pools=4');
    const svt = videoArgs({ ...h264, codec: 'av1' }, 0, null, 4);
    expect(svt[svt.indexOf('-svtav1-params') + 1]).toBe('lp=4');
    expect(videoArgs(h264)).not.toContain('-threads');
  });

  it('checks its matrix against the contract', () => {
    for (const [name, settings] of Object.entries(ENCODES)) {
      expect(RenderSettings.safeParse(settings).success, name).toBe(true);
    }
  });
});

/** The encoders this machine's ffmpeg has. */
const encoders = execFileSync(process.env['FFMPEG'] ?? 'ffmpeg', ['-hide_banner', '-encoders'], {
  encoding: 'utf8',
});
const has = (settings: RenderSettings) =>
  encoders.includes(
    { h264: 'libx264', hevc: 'libx265', av1: 'libsvtav1', prores: 'prores_ks' }[settings.codec],
  );

describe('every encode a preset can ask for', () => {
  const dir = mkdtempSync(join(tmpdir(), 'encode-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // The media image makes all of them in CI (scripts/encoders.ts); here, what this ffmpeg can.
  for (const [name, settings] of Object.entries(ENCODES)) {
    it.skipIf(!has(settings))(`${name} encodes`, async () => {
      expect(await tryEncode(settings, dir, name.replaceAll(/\W+/g, '-'))).toBeNull();
    });
  }
});
