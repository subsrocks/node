import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { Output } from '../src/agent/output.ts';
import { startJob } from '../src/agent/runner.ts';
import { Store } from '../src/agent/store.ts';
import { findTools } from '../src/agent/tools.ts';
import type { ProgressReport, RenderJob } from '../src/job.ts';
import type { NodeJob } from '../src/protocol.ts';

/**
 * A render on this machine, end to end, without subs.rocks: a stand-in serves the built-in fonts'
 * list and a job's files to whoever brings its token, and the agent runs the engine on them in a
 * process of its own, as it does for subs.rocks.
 */

function has(tool: string): boolean {
  try {
    execFileSync(tool, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
// The ffmpeg the node would find: on a Mac, Homebrew's ffmpeg-full.
const tools = await findTools(null, process.env);
const describe = suite.skipIf(!(has(tools.ffmpeg) && has(tools.ffprobe)));

const TOKEN = 'node_test.secret';
const work = mkdtempSync(join(tmpdir(), 'subs-node-runner-'));
const files = new Map<string, Buffer>();
const progress: string[] = [];
let server: Server;
let origin = '';

function body(request: IncomingMessage): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => done(Buffer.concat(chunks)));
    request.on('error', fail);
  });
}

beforeAll(async () => {
  const original = join(work, 'original.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=25:duration=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-shortest',
    original,
  ]);
  files.set('original', readFileSync(original));
  files.set(
    'subtitles.ass',
    Buffer.from(
      [
        '[Script Info]',
        'ScriptType: v4.00+',
        'PlayResX: 320',
        'PlayResY: 240',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        'Style: Default,sans-serif,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1',
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:00.20,0:00:01.80,Default,,0,0,0,,Hello',
        '',
      ].join('\n'),
    ),
  );
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://storage');
    if (url.pathname === '/fonts/built-in.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ fonts: [] }));
      return;
    }
    const name = /^\/api\/nodes\/io\/objects\/([^/]+)$/.exec(url.pathname)?.[1];
    if (!name || url.searchParams.get('token') !== TOKEN) {
      response.writeHead(403).end();
      return;
    }
    if (request.method === 'PUT') {
      const bytes = await body(request);
      if (name === 'progress.json') progress.push(bytes.toString());
      else files.set(name, bytes);
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end('{}');
      return;
    }
    const stored = files.get(name);
    if (!stored) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stored.byteLength,
    });
    response.end(request.method === 'HEAD' ? undefined : stored);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

const job = (token = TOKEN): NodeJob => ({
  id: 'job_test',
  kind: 'render',
  token,
  input: {
    input: { key: 'original' },
    subtitles: { key: 'subtitles.ass' },
    fonts: [],
    output: { key: 'render.mp4' },
    progress: { key: 'progress.json' },
    startPtsMs: 0,
    durationMs: 2000,
    width: null,
    height: null,
    crf: 23,
    speed: 'veryfast',
    audioKbps: 128,
    settings: {
      codec: 'h264',
      size: null,
      fps: null,
      rate: { mode: 'crf', crf: 23, maxKbps: null },
      speed: 'veryfast',
      tenBit: false,
      proresProfile: 'hq',
      keyframeSeconds: null,
      audio: { kbps: 128, sampleRate: null },
    },
  } satisfies RenderJob,
});

const command = {
  file: process.execPath,
  args: [resolve(import.meta.dirname, '../src/agent/main.ts'), '__job'],
};
const quiet = new Output({ format: 'json', sink: { write: () => undefined } });

describe('a render on this machine', () => {
  it('reads its files with its token, makes the video, and writes it back', async () => {
    const store = new Store(join(work, 'node'));
    await store.prepare();
    const heard: ProgressReport[] = [];
    const running = startJob(job(), {
      server: origin,
      store,
      log: quiet,
      tools,
      onProgress: (report) => heard.push(report),
      command,
    });
    const outcome = await running.ended;
    expect(outcome).toMatchObject({
      state: 'done',
      result: { output: { key: 'render.mp4', mime: 'video/mp4' }, width: 320, height: 240 },
    });
    const made = join(work, 'made.mp4');
    writeFileSync(made, files.get('render.mp4') ?? Buffer.alloc(0));
    const streams = JSON.parse(
      execFileSync(tools.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', made], {
        encoding: 'utf8',
      }),
    ) as { streams: { codec_name: string }[] };
    expect(streams.streams.map((stream) => stream.codec_name)).toEqual(['h264', 'aac']);
  });

  it('fails, to be tried again, when its token isn’t good', async () => {
    const store = new Store(join(work, 'node-2'));
    await store.prepare();
    const outcome = await startJob(job('node_test.wrong'), {
      server: origin,
      store,
      log: quiet,
      tools,
      onProgress: () => undefined,
      command,
    }).ended;
    expect(outcome).toMatchObject({ state: 'failed', error: { retryable: true } });
  });

  it('is given back at once when the node stops', async () => {
    const store = new Store(join(work, 'node-3'));
    await store.prepare();
    const running = startJob(job(), {
      server: origin,
      store,
      log: quiet,
      tools,
      onProgress: () => undefined,
      command,
    });
    running.stop('release');
    expect(await running.ended).toMatchObject({ state: 'released' });
  });
});
