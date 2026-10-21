import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nvidiaGpus, trialArgs, trialSettings, vaapiName } from '../src/agent/hardware.ts';
import {
  describeMachine,
  encodersLine,
  ffmpegVersion,
  fontProviderOf,
  listedNames,
  machineLine,
} from '../src/agent/machine.ts';
import {
  defaultName,
  machineName,
  parseOptions,
  serverUrl,
  UsageError,
} from '../src/agent/options.ts';
import { duration, Output, size } from '../src/agent/output.ts';
import { jobLine, newer } from '../src/agent/session.ts';
import { Store } from '../src/agent/store.ts';
import { findTools } from '../src/agent/tools.ts';
import { parallelPlan } from '../src/engine/parallel.ts';
import type { RenderJob } from '../src/job.ts';
import type { NodeMachine } from '../src/protocol.ts';

describe('the command line', () => {
  it('starts by default, from flags or the environment, a flag first', () => {
    const options = parseOptions(['--token', 'sr_reg_1', '--name', 'Edit bay'], {
      SUBS_TOKEN: 'sr_reg_2',
      SUBS_GPU: 'off',
      SUBS_CONTAINER: '1',
    });
    expect(options).toMatchObject({
      command: 'start',
      token: 'sr_reg_1',
      name: 'Edit bay',
      gpu: 'off',
      server: 'https://subs.rocks',
      data: '/data',
      log: 'pretty',
    });
    expect(parseOptions(['doctor'], {}).command).toBe('doctor');
    expect(parseOptions(['--version'], {}).command).toBe('version');
    expect(parseOptions([], {}).ffmpeg).toBeNull();
    expect(parseOptions(['--ffmpeg', '/opt/ffmpeg/bin/ffmpeg'], { SUBS_FFMPEG: 'x' }).ffmpeg).toBe(
      '/opt/ffmpeg/bin/ffmpeg',
    );
  });

  it('names a machine for the computer, not a container’s id or a Mac network’s .local', () => {
    expect(machineName('Zachs-MacBook-Pro.local')).toBe('Zachs-MacBook-Pro');
    expect(machineName('  ')).toBe('machine');
    expect(machineName('x'.repeat(80))).toHaveLength(60);
    if (process.platform !== 'darwin') {
      expect(defaultName({ SUBS_CONTAINER: '1' }, '08fee3664f1d')).toBe('Docker');
      expect(defaultName({}, '08fee3664f1d')).toBe('08fee3664f1d');
      expect(defaultName({ SUBS_CONTAINER: '1' }, 'edit-bay')).toBe('edit-bay');
    }
    expect(parseOptions(['--name', 'Studio.local'], {}).name).toBe('Studio');
  });

  it('says what’s wrong with what it was given', () => {
    expect(() => parseOptions(['bogus'], {})).toThrow(UsageError);
    expect(() => parseOptions(['--gpu', 'maybe'], {})).toThrow('--gpu is auto or off');
    expect(() => parseOptions(['--log', 'xml'], {})).toThrow(UsageError);
  });

  it('talks to subs.rocks over HTTPS, or to a development server on this machine', () => {
    expect(serverUrl('https://subs.rocks/')).toBe('https://subs.rocks');
    expect(serverUrl('http://localhost:5173')).toBe('http://localhost:5173');
    expect(() => serverUrl('http://subs.rocks')).toThrow(UsageError);
    expect(() => serverUrl('not a url')).toThrow(UsageError);
  });
});

describe('what the machine can do', () => {
  it('reads ffmpeg’s version, encoders and filters', () => {
    expect(ffmpegVersion('ffmpeg version 7.1.1-1+b1 Copyright (c) 2000-2025')).toBe('7.1.1-1+b1');
    const encoders = listedNames(
      [
        'Encoders:',
        ' V..... = Video',
        ' ------',
        ' V....D libx264              libx264 H.264 / AVC',
        ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder',
        ' A....D aac                  AAC (Advanced Audio Coding)',
      ].join('\n'),
    );
    expect(encoders.has('libx264')).toBe(true);
    expect(encoders.has('h264_nvenc')).toBe(true);
    expect(encoders.has('aac')).toBe(true);
    const filters = listedNames(' ... ass               V->V       Render ASS subtitles.');
    expect(filters.has('ass')).toBe(true);
  });

  it('reads the font system libass picks fonts with', () => {
    expect(fontProviderOf('[Parsed_ass_0 @ 0x5f] Using font provider fontconfig')).toBe(
      'fontconfig',
    );
    expect(fontProviderOf('[Parsed_ass_0 @ 0x5f] Using font provider coretext')).toBe('coretext');
    expect(fontProviderOf('[Parsed_ass_0 @ 0x5f] Added subtitle file')).toBeNull();
  });

  it('says how to get an ffmpeg that renders: on a Mac, the program’s own, installed again', async () => {
    const missing = { ffmpeg: '/nowhere/ffmpeg', ffprobe: '/nowhere/ffprobe' };
    const workDir = mkdtempSync(join(tmpdir(), 'subs-node-machine-'));
    const mac = await describeMachine({ tools: missing, gpu: 'off', workDir, platform: 'darwin' });
    expect(mac.problems).toEqual([
      "ffmpeg didn't run (/nowhere/ffmpeg): install it (run the install line again, which brings it, or run the Docker image)",
    ]);
    const linux = await describeMachine({ tools: missing, gpu: 'off', workDir, platform: 'linux' });
    expect(linux.problems).toEqual(["ffmpeg didn't run (/nowhere/ffmpeg): install it"]);
  });

  it('reads its GPUs from nvidia-smi', () => {
    expect(nvidiaGpus('NVIDIA GeForce RTX 4090, 24564\nNVIDIA L4, 23034\n')).toEqual([
      { name: 'NVIDIA GeForce RTX 4090', memoryBytes: 24564 * 1024 * 1024 },
      { name: 'NVIDIA L4', memoryBytes: 23034 * 1024 * 1024 },
    ]);
  });

  it('is said in a line or two', () => {
    const machine: NodeMachine = {
      os: 'linux',
      arch: 'x64',
      container: true,
      cpu: { model: 'AMD Ryzen 9 7950X', threads: 32 },
      memoryBytes: 64 * 1024 ** 3,
      gpus: [{ name: 'NVIDIA GeForce RTX 4090', memoryBytes: null }],
      encoders: { cpu: ['h264', 'hevc', 'av1', 'prores'], gpu: ['h264', 'hevc'] },
      ffmpeg: '7.1.1',
      diskBytes: null,
    };
    expect(machineLine(machine)).toBe(
      'AMD Ryzen 9 7950X · 32 threads · 64 GB · NVIDIA GeForce RTX 4090',
    );
    expect(encodersLine(machine)).toBe('H.264 (GPU) · H.265 (GPU) · AV1 · ProRes');
    const mac: NodeMachine = {
      ...machine,
      cpu: { model: 'Apple M4 Max', threads: 16 },
      gpus: [],
      encoders: { cpu: ['h264', 'hevc', 'av1', 'prores'], gpu: ['h264', 'hevc', 'prores'] },
      hardware: { kind: 'videotoolbox', name: 'Apple M4 Max', features: {} },
    };
    expect(machineLine(mac)).toBe('Apple M4 Max · 16 threads · 64 GB');
    expect(encodersLine(mac)).toBe(
      'H.264 (media engine) · H.265 (media engine) · AV1 · ProRes (media engine)',
    );
  });

  it('names Intel’s and AMD’s graphics from their drivers', () => {
    expect(
      vaapiName(
        '[AVHWDeviceContext @ 0x1] VAAPI driver: Mesa Gallium driver 25.0.7-2 for AMD Radeon RX 7900 XTX (radeonsi, navi31, LLVM 19.1.7, DRM 3.61, 6.12.48).\n',
      ),
    ).toBe('AMD Radeon RX 7900 XTX');
    expect(
      vaapiName(
        '[AVHWDeviceContext @ 0x1] VAAPI driver: Intel iHD driver for Intel(R) Gen Graphics - 25.2.3 ().\n',
      ),
    ).toBe('Intel graphics');
    expect(vaapiName('nothing')).toBeNull();
  });

  it('tries hardware as a render uses it: its device, its upload, the render’s encoder', () => {
    const args = trialArgs(
      { kind: 'vaapi', device: '/dev/dri/renderD129', decode: true },
      trialSettings('hevc', 'tenBit'),
    );
    expect(args.slice(0, 7)).toEqual([
      '-hide_banner',
      '-v',
      'error',
      '-init_hw_device',
      'vaapi=hw:/dev/dri/renderD129',
      '-filter_hw_device',
      'hw',
    ]);
    // Encoding alone: decoding is tried by itself.
    expect(args).not.toContain('-hwaccel');
    expect(args[args.indexOf('-vf') + 1]).toBe('format=p010le,hwupload');
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'hevc_vaapi', '-profile:v', 'main10']));
    expect(trialSettings('h264', 'capped').rate).toEqual({ mode: 'crf', crf: 23, maxKbps: 6000 });
  });
});

describe('a render on this machine’s threads', () => {
  const job = (minutes: number, grid = true) => ({
    durationMs: minutes * 60_000,
    ...(grid ? { grid: { fps: '30' as const, frames: minutes * 1800 } } : {}),
    settings: {
      codec: 'hevc' as const,
      size: null,
      fps: null,
      rate: { mode: 'vbr' as const, kbps: 30_000, maxKbps: 60_000 },
      speed: 'medium' as const,
      tenBit: false,
      proresProfile: 'hq' as const,
      keyframeSeconds: null,
      audio: { kbps: 320, sampleRate: null },
    },
    crf: 23,
    speed: 'medium' as const,
    audioKbps: 320,
    width: null,
    height: null,
  });
  const k4 = 3840 * 1920;
  const gb = 1024 ** 3;

  it('encodes a piece for every four threads, as many as its memory holds', () => {
    expect(parallelPlan(job(18), { threads: 16, memoryBytes: 64 * gb }, null, k4)).toEqual({
      slots: 4,
      pieces: 8,
      threads: 4,
    });
    // Docker Desktop's 8 GB holds three 4K encodes of H.265.
    expect(parallelPlan(job(18), { threads: 16, memoryBytes: 8 * gb }, null, k4)).toMatchObject({
      slots: 3,
      threads: 5,
    });
    expect(parallelPlan(job(18), { threads: 64, memoryBytes: 256 * gb }, null, k4).slots).toBe(8);
  });

  it('makes it whole on a small machine, a short render, or one without a frame grid', () => {
    const whole = { slots: 1, pieces: 1, threads: 4 };
    expect(parallelPlan(job(18), { threads: 4, memoryBytes: 64 * gb }, null, k4)).toEqual(whole);
    expect(parallelPlan(job(0.5), { threads: 16, memoryBytes: 64 * gb }, null, k4).slots).toBe(1);
    expect(
      parallelPlan(job(18, false), { threads: 16, memoryBytes: 64 * gb }, null, k4).slots,
    ).toBe(1);
  });

  it('keeps hardware encoding two at once, pieces no shorter than half a minute', () => {
    const vt = { kind: 'videotoolbox' as const, device: null, decode: true };
    expect(parallelPlan(job(18), { threads: 16, memoryBytes: 64 * gb }, vt, k4)).toEqual({
      slots: 2,
      pieces: 4,
      threads: 8,
    });
    expect(parallelPlan(job(1.2), { threads: 16, memoryBytes: 64 * gb }, vt, k4).pieces).toBe(2);
  });
});

describe('its ffmpeg', () => {
  /** A Homebrew with ffmpeg-full in it, as `brew install ffmpeg-full` leaves it. */
  function homebrew(): string {
    const prefix = mkdtempSync(join(tmpdir(), 'subs-node-brew-'));
    const bin = join(prefix, 'opt/ffmpeg-full/bin');
    mkdirSync(bin, { recursive: true });
    for (const tool of ['ffmpeg', 'ffprobe']) {
      writeFileSync(join(bin, tool), '#!/bin/sh\n');
      chmodSync(join(bin, tool), 0o755);
    }
    return prefix;
  }

  it('is the one it was told, its ffprobe beside it', async () => {
    expect(await findTools('/opt/ff/bin/ffmpeg', {})).toEqual({
      ffmpeg: '/opt/ff/bin/ffmpeg',
      ffprobe: '/opt/ff/bin/ffprobe',
    });
    expect(await findTools('ffmpeg7', {})).toEqual({ ffmpeg: 'ffmpeg7', ffprobe: 'ffprobe' });
  });

  it('is Homebrew’s ffmpeg-full on a Mac, which isn’t on the PATH', async () => {
    const prefix = homebrew();
    expect(await findTools(null, { HOMEBREW_PREFIX: prefix }, 'darwin')).toEqual({
      ffmpeg: join(prefix, 'opt/ffmpeg-full/bin/ffmpeg'),
      ffprobe: join(prefix, 'opt/ffmpeg-full/bin/ffprobe'),
    });
  });

  it('is the program’s own, beside it, before any other', async () => {
    const prefix = homebrew();
    const own = join(prefix, 'opt/ffmpeg-full/bin');
    expect(await findTools(null, {}, 'linux', own)).toEqual({
      ffmpeg: join(own, 'ffmpeg'),
      ffprobe: join(own, 'ffprobe'),
    });
    expect(await findTools(null, {}, 'linux', '/nowhere')).toEqual({
      ffmpeg: 'ffmpeg',
      ffprobe: 'ffprobe',
    });
  });

  it('is the PATH’s elsewhere, or the engine’s own when it’s set', async () => {
    const prefix = homebrew();
    expect(await findTools(null, { HOMEBREW_PREFIX: prefix }, 'linux')).toEqual({
      ffmpeg: 'ffmpeg',
      ffprobe: 'ffprobe',
    });
    expect(await findTools(null, { FFMPEG: '/usr/lib/ffmpeg' }, 'darwin')).toEqual({
      ffmpeg: '/usr/lib/ffmpeg',
      ffprobe: 'ffprobe',
    });
  });
});

describe('what it says', () => {
  it('says durations and sizes as people do', () => {
    expect(duration(4_000)).toBe('4 s');
    expect(duration(12 * 60_000)).toBe('12 min');
    expect(duration(65 * 60_000)).toBe('1 h 5 min');
    expect(size(6_400_000)).toBe('6.4 MB');
    expect(size(1_250_000_000)).toBe('1.3 GB');
  });

  it('writes progress a tenth at a time where lines can’t be rewritten', () => {
    const lines: string[] = [];
    const out = new Output({ format: 'pretty', sink: { write: (text) => lines.push(text) } });
    for (const fraction of [0.01, 0.05, 0.12, 0.13, 0.5, 0.99])
      out.progress('Rendering', fraction, null);
    expect(lines.map((line) => line.trim())).toEqual([
      'Rendering 1%',
      'Rendering 12%',
      'Rendering 50%',
      'Rendering 99%',
    ]);
  });

  it('writes one JSON object a line when asked', () => {
    const lines: string[] = [];
    const out = new Output({ format: 'json', sink: { write: (text) => lines.push(text) } });
    out.ok('Rendered', { file: '6.4 MB' });
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      level: 'info',
      message: 'Rendered',
      file: '6.4 MB',
    });
  });

  it('tells versions apart, and a render’s job in a few words', () => {
    expect(newer('1.2.10', '1.2.9')).toBe(true);
    expect(newer('1.2.0', '1.2.0')).toBe(false);
    expect(newer('1.1.9', '1.2.0')).toBe(false);
    const job = {
      durationMs: 724_000,
      settings: { codec: 'hevc', size: { width: 3840, height: 2160 } },
      encoder: 'gpu',
    } as RenderJob;
    expect(jobLine(job)).toBe('12:04 at 3840×2160 → H.265 on the GPU');
  });
});

describe('its folder', () => {
  it('keeps its credential readable by its owner alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subs-node-store-'));
    const store = new Store(dir);
    await store.prepare();
    expect(await store.credential()).toBeNull();
    const credential = {
      server: 'https://subs.rocks',
      id: 'node_1',
      name: 'Edit bay',
      secret: 's',
    };
    await store.saveCredential(credential);
    expect(await store.credential()).toEqual(credential);
    expect(statSync(join(dir, 'node.json')).mode & 0o777).toBe(0o600);
    await store.forget();
    expect(await store.credential()).toBeNull();
  });
});
