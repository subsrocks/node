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
  FPS_RATIOS,
  fpsFilter,
  gpuEncodes,
  pixelFormat,
  settingsOf,
  videoArgs,
} from '../src/engine/encode.ts';
import { ENCODES } from '../src/engine/encode-matrix.ts';
import { renderFilter } from '../src/engine/render.ts';
import { FRAME_RATES, type RenderJob, RenderSettings } from '../src/job.ts';

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
    expect(videoArgs(hevc, 0, 'gpu')).toEqual([
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
    expect(decodeArgs(hevc, 'gpu')).toEqual(['-hwaccel', 'cuda']);
    expect(decodeArgs(hevc)).toEqual([]);
    // A constant quality as NVENC's own, capped; H.264 at High; 10 bits as P010.
    const capped = videoArgs(h264, 0, 'gpu');
    expect(capped.slice(0, 2)).toEqual(['-c:v', 'h264_nvenc']);
    expect(capped).toEqual(
      expect.arrayContaining(['-cq', String((h264.rate as { crf: number }).crf)]),
    );
    expect(capped).toEqual(expect.arrayContaining(['-profile:v', 'high']));
    const tenBit: RenderSettings = { ...hevc, tenBit: true };
    expect(pixelFormat(tenBit, 'gpu')).toBe('p010le');
    expect(pixelFormat(tenBit)).toBe('yuv420p10le');
    expect(videoArgs(tenBit, 0, 'gpu')).toEqual(expect.arrayContaining(['-profile:v', 'main10']));
    expect(videoArgs({ ...hevc, codec: 'av1' }, 0, 'gpu').slice(0, 2)).toEqual([
      '-c:v',
      'av1_nvenc',
    ]);
    // ProRes stays the CPU's.
    const prores: RenderSettings = { ...h264, codec: 'prores' };
    expect(gpuEncodes(prores)).toBe(false);
    expect(videoArgs(prores, 0, 'gpu')).toEqual(videoArgs(prores));
    expect(decodeArgs(prores, 'gpu')).toEqual([]);
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
