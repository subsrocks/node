import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
import { Originals } from '../src/agent/originals.ts';
import { duration, Output, size } from '../src/agent/output.ts';
import { jobLine, newer } from '../src/agent/session.ts';
import { Store } from '../src/agent/store.ts';
import { findTools } from '../src/agent/tools.ts';
import { findDownloader, YTDLP_RELEASE } from '../src/agent/ytdlp.ts';
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

  it('downloads videos for its workspace, signed in, unless told not to', () => {
    expect(parseOptions([], {})).toMatchObject({ downloads: 'on', cookies: 'on', ytDlp: null });
    expect(
      parseOptions(['--cookies', 'off', '--yt-dlp', '/opt/yt-dlp'], { SUBS_DOWNLOADS: 'off' }),
    ).toMatchObject({ downloads: 'off', cookies: 'off', ytDlp: '/opt/yt-dlp' });
    expect(() => parseOptions(['--downloads', 'maybe'], {})).toThrow('--downloads is on or off');
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

  it('keeps the ends of a render and a download until they’re heard, as 1.3 kept one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subs-node-pending-'));
    const store = new Store(dir);
    await store.prepare();
    expect(await store.pending()).toEqual([]);
    // A node before 1.4 kept one, a render's.
    const released = { state: 'released' as const, ms: 0 };
    writeFileSync(join(dir, 'pending.json'), JSON.stringify({ job: 'job_1', outcome: released }));
    expect(await store.pending()).toEqual([{ job: 'job_1', kind: 'render', outcome: released }]);
    await store.setPending([
      { job: 'job_1', kind: 'render', outcome: released },
      { job: 'job_2', kind: 'fetch', outcome: released },
    ]);
    expect((await store.pending()).map((each) => each.kind)).toEqual(['render', 'fetch']);
    await store.setPending([]);
    expect(await store.pending()).toEqual([]);
  });
});

describe('its downloader', () => {
  const fake = resolve(import.meta.dirname, 'fixtures/fake-yt-dlp.mjs');

  it('is the one it was told, when that runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subs-node-ytdlp-'));
    expect(await findDownloader(fake, dir)).toMatchObject({ ytDlp: fake, version: '2026.08.19' });
    expect(await findDownloader('/nowhere/yt-dlp', dir)).toEqual({
      problem: "--yt-dlp /nowhere/yt-dlp doesn't run",
    });
  });

  it('is never a release that isn’t what its checksum says', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subs-node-ytdlp-'));
    const fetcher = (async () => new Response('not yt-dlp')) as unknown as typeof fetch;
    const found = await findDownloader(null, dir, {
      platform: 'linux-x64',
      fetcher,
      // As if none were on the PATH: the test machine's own isn't looked at here.
      onPath: false,
    });
    expect(found).toMatchObject({
      problem: expect.stringContaining("isn't what its release says"),
    });
    expect(() => statSync(join(dir, 'bin', `yt-dlp-${YTDLP_RELEASE.version}`))).toThrow();
  });

  it('is the release subs.rocks’s images have', () => {
    // The node's own; and subs.rocks's fetcher's, beside it in subs.rocks's repository (not in the
    // node's public one).
    for (const file of ['../Dockerfile', '../../containers/media/Dockerfile']) {
      const path = resolve(import.meta.dirname, file);
      if (!existsSync(path)) continue;
      const dockerfile = readFileSync(path, 'utf8');
      expect(dockerfile).toContain(`YTDLP_VERSION=${YTDLP_RELEASE.version}`);
      expect(dockerfile).toContain(
        `YTDLP_SHA256_AMD64=${YTDLP_RELEASE.assets['linux-x64']?.sha256}`,
      );
      expect(dockerfile).toContain(
        `YTDLP_SHA256_ARM64=${YTDLP_RELEASE.assets['linux-arm64']?.sha256}`,
      );
    }
  });
});

describe('the originals it keeps', () => {
  const quiet = { warn: () => undefined, debug: () => undefined };
  const limits = { maxBytes: 1000, maxAgeMs: 1000, freeBytes: 0 };
  /** A folder, a clock to move, and a job's whole original of `bytes` to keep. */
  async function kept(over: Partial<typeof limits> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'subs-node-originals-'));
    let at = 10_000;
    const originals = new Originals(join(dir, 'kept'), { ...limits, ...over }, quiet, () => at);
    await originals.prepare();
    const take = async (version: string, bytes: number, fill = 'x') => {
      const file = join(dir, `job-${version.replace(/\W/g, '')}`);
      writeFileSync(file, fill.repeat(bytes));
      await originals.take(version, file);
      // Moved at once, checked after: waited for here.
      await vi.waitFor(async () => {
        const found = readdirSync(join(dir, 'kept'));
        expect(found.filter((name) => name.endsWith('.partial'))).toEqual([]);
        expect(found.some((name) => name.endsWith('.json'))).toBe(true);
      });
    };
    const pass = (ms: number) => {
      at += ms;
    };
    return { dir, originals, take, pass };
  }

  it('gives a job its copy of the same version, linked, and no other', async () => {
    const { dir, originals, take } = await kept();
    await take('100:abc', 100);
    const job = join(dir, 'original');
    expect(await originals.linkInto('100:abc', job)).toBe(true);
    expect(readFileSync(job, 'utf8')).toBe('x'.repeat(100));
    // Replaced in storage, its version isn't this one: read from there.
    expect(await originals.linkInto('100:def', join(dir, 'other'))).toBe(false);
    expect(await originals.size()).toEqual({ videos: 1, bytes: 100 });
  });

  it('keeps only a whole file: a part, a stopped copy, an unreadable version aren’t', async () => {
    const { dir, originals } = await kept();
    const part = join(dir, 'part');
    writeFileSync(part, 'x'.repeat(40));
    await originals.take('100:abc', part);
    await originals.take('not a version', part);
    await originals.take('100:abc', join(dir, 'nowhere'));
    expect(await originals.size()).toEqual({ videos: 0, bytes: 0 });
    expect(existsSync(part)).toBe(true);
  });

  it('drops a damaged copy, and the job reads storage', async () => {
    const { dir, originals, take } = await kept();
    await take('100:abc', 100);
    const copy = readdirSync(join(dir, 'kept')).find((name) => /^[0-9a-f]{64}$/.test(name)) ?? '';
    // The same size: only the checksum can tell.
    writeFileSync(join(dir, 'kept', copy), 'y'.repeat(100));
    expect(await originals.linkInto('100:abc', join(dir, 'original'))).toBe(false);
    expect(existsSync(join(dir, 'original'))).toBe(false);
    expect(await originals.size()).toEqual({ videos: 0, bytes: 0 });
  });

  it('stays within its limits: the used longest ago goes first, then what’s past its time', async () => {
    const { dir, originals, take, pass } = await kept();
    await take('600:old', 600);
    pass(10);
    await take('300:new', 300);
    pass(10);
    // Used again: no longer the oldest.
    expect(await originals.linkInto('600:old', join(dir, 'a'))).toBe(true);
    pass(10);
    await take('400:big', 400);
    await vi.waitFor(async () => expect((await originals.size()).bytes).toBe(1000));
    expect(await originals.linkInto('300:new', join(dir, 'b'))).toBe(false);
    pass(5000);
    await originals.sweep();
    expect(await originals.size()).toEqual({ videos: 0, bytes: 0 });
    // A job's link outlives its copy.
    expect(readFileSync(join(dir, 'a'), 'utf8')).toBe('x'.repeat(600));
  });

  it('keeps nothing larger than it may, and leaves the disk its room', async () => {
    const tight = await kept({ maxBytes: 50 });
    const file = join(tight.dir, 'large');
    writeFileSync(file, 'x'.repeat(100));
    await tight.originals.take('100:abc', file);
    expect(await tight.originals.size()).toEqual({ videos: 0, bytes: 0 });
    const full = await kept({ freeBytes: Number.MAX_SAFE_INTEGER });
    const small = join(full.dir, 'small');
    writeFileSync(small, 'x'.repeat(10));
    await full.originals.take('10:abc', small);
    await vi.waitFor(async () => {
      expect(readdirSync(join(full.dir, 'kept'))).toEqual([]);
    });
  });

  it('goes with its place in the workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subs-node-forget-'));
    const store = new Store(dir);
    await store.prepare();
    mkdirSync(store.originalsDir, { recursive: true });
    writeFileSync(join(store.originalsDir, 'video'), 'x');
    await store.forget();
    expect(existsSync(store.originalsDir)).toBe(false);
  });

  it('is on unless told otherwise, up to 50 GB', () => {
    expect(parseOptions([], {}).keepOriginals).toBe(50e9);
    expect(parseOptions(['--keep-originals', '200'], {}).keepOriginals).toBe(200e9);
    expect(parseOptions([], { SUBS_KEEP_ORIGINALS: 'off' }).keepOriginals).toBe(0);
    expect(() => parseOptions(['--keep-originals', 'lots'], {})).toThrow(
      '--keep-originals is a number of gigabytes, or off',
    );
    expect(parseOptions([], {}).keepFree).toBe(20e9);
    expect(parseOptions(['--keep-free', '5'], { SUBS_KEEP_FREE: '9' }).keepFree).toBe(5e9);
    expect(() => parseOptions(['--keep-free', 'x'], {})).toThrow(
      '--keep-free is a number of gigabytes',
    );
  });
});
