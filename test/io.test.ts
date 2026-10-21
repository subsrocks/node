import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Storing a job's files (`putFile`): small ones in one request, large ones in parts through the
 * storage host's multipart verbs, every request made again when it fails in a way that may pass,
 * against a stand-in host that can drop a connection or refuse. And reading an original from a
 * copy where there's room (`originalInput`).
 */
const store = new Map<string, Buffer>();
const uploads = new Map<string, Map<number, Buffer>>();
const seen: string[] = [];
/** Requests to fail, by `METHOD part-or-key`, each once per entry: `drop` cuts the connection. */
let failing: { match: string; how: 'drop' | 503 | 403 }[] = [];
let storage: Server;
let putFile: typeof import('../src/engine/io.ts').putFile;
let originalInput: typeof import('../src/engine/io.ts').originalInput;

const work = mkdtempSync(join(tmpdir(), 'io-test-'));
const fast = { retryDelaysMs: [1, 1, 1] };

function body(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function file(name: string, length: number): { path: string; bytes: Buffer } {
  const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 31 + 7) % 256));
  const path = join(work, name);
  writeFileSync(path, bytes);
  return { path, bytes };
}

beforeAll(async () => {
  storage = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://storage');
    const key = decodeURIComponent(url.pathname.replace(/^\/objects\//, ''));
    const uploadId = url.searchParams.get('uploadId');
    const partNumber = url.searchParams.get('partNumber');
    const name = `${request.method} ${partNumber ? `part ${partNumber}` : uploadId ? 'upload' : key}`;
    seen.push(name);
    const failure = failing.find((entry) => name.includes(entry.match));
    if (failure) {
      failing = failing.filter((entry) => entry !== failure);
      const { how } = failure;
      if (how === 'drop') {
        // Part of the body read, then the connection cut, as the platform's proxy did.
        request.once('data', () => request.socket.destroy());
        return;
      }
      await body(request);
      response.writeHead(how).end();
      return;
    }
    if (request.method === 'POST' && url.searchParams.has('uploads')) {
      const id = `up-${uploads.size + 1}`;
      uploads.set(id, new Map());
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ uploadId: id }));
      return;
    }
    if (request.method === 'PUT' && uploadId && partNumber) {
      const bytes = await body(request);
      uploads.get(uploadId)?.set(Number(partNumber), bytes);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ partNumber: Number(partNumber), etag: `e${partNumber}` }));
      return;
    }
    if (request.method === 'POST' && uploadId) {
      const { parts, bytes } = JSON.parse((await body(request)).toString()) as {
        parts: { partNumber: number; etag: string }[];
        bytes: number;
      };
      const stored = uploads.get(uploadId);
      const whole = Buffer.concat(
        parts.map((part) => stored?.get(part.partNumber) ?? Buffer.alloc(0)),
      );
      if (whole.byteLength !== bytes) {
        response.writeHead(500).end();
        return;
      }
      store.set(key, whole);
      response.writeHead(201).end();
      return;
    }
    if (request.method === 'DELETE' && uploadId) {
      uploads.delete(uploadId);
      response.writeHead(204).end();
      return;
    }
    if (request.method === 'PUT') {
      store.set(key, await body(request));
      response.writeHead(201).end();
      return;
    }
    const stored = request.method === 'GET' ? store.get(key) : undefined;
    if (stored) {
      response.writeHead(200, { 'Content-Length': stored.byteLength });
      response.end(stored);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => storage.listen(0, '127.0.0.1', resolve));
  process.env['MEDIA_IO_ORIGIN'] = `http://127.0.0.1:${(storage.address() as AddressInfo).port}`;
  ({ putFile, originalInput } = await import('../src/engine/io.ts'));
});

afterAll(() => {
  storage.close();
});

beforeEach(() => {
  store.clear();
  uploads.clear();
  seen.length = 0;
  failing = [];
});

describe('putFile', () => {
  it('stores a small file in one request, made again after a 503', async () => {
    const { path, bytes } = file('small.bin', 1000);
    failing = [{ match: 'PUT ws/a/small', how: 503 }];
    const written = await putFile(path, 'ws/a/small', 'application/octet-stream', fast);
    expect(store.get('ws/a/small')).toEqual(bytes);
    expect(written).toEqual({
      key: 'ws/a/small',
      bytes: 1000,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mime: 'application/octet-stream',
    });
    expect(seen.filter((name) => name === 'PUT ws/a/small')).toHaveLength(2);
  });

  it('stores a large file in parts, sending again only the part whose connection dropped', async () => {
    const { path, bytes } = file('large.bin', 10_000);
    failing = [{ match: 'part 2', how: 'drop' }];
    const written = await putFile(path, 'ws/a/large', 'video/mp4', { ...fast, partBytes: 3000 });
    expect(store.get('ws/a/large')).toEqual(bytes);
    expect(written.bytes).toBe(10_000);
    // Four parts (the last shorter), part 2 twice, finished once.
    expect(seen.filter((name) => name.startsWith('PUT part')).sort()).toEqual([
      'PUT part 1',
      'PUT part 2',
      'PUT part 2',
      'PUT part 3',
      'PUT part 4',
    ]);
    expect(seen.filter((name) => name === 'POST upload')).toHaveLength(1);
  });

  it('drops the upload and fails to be retried when a part can’t be stored', async () => {
    const { path } = file('refused.bin', 10_000);
    failing = [{ match: 'part 3', how: 403 }];
    await expect(
      putFile(path, 'ws/a/refused', 'video/mp4', { ...fast, partBytes: 3000 }),
    ).rejects.toMatchObject({
      name: 'JobError',
      retryable: true,
      message: 'storing part 3 of 4 of ws/a/refused failed: HTTP 403',
    });
    expect(seen).toContain('DELETE upload');
    expect(store.has('ws/a/refused')).toBe(false);
  });
});

describe('originalInput', () => {
  it('reads an original from a copy on the disk when there’s room beside it', async () => {
    const { bytes } = file('to-copy.bin', 5000);
    store.set('ws/a/original', bytes);
    failing = [{ match: 'GET ws/a/original', how: 503 }];
    const dir = mkdtempSync(join(work, 'job-'));
    const input = await originalInput('ws/a/original', dir, (size) => size, fast);
    expect(input).toBe(join(dir, 'original'));
    expect(readFileSync(input)).toEqual(bytes);
    // Asked for again after the 503, then copied whole.
    expect(seen.filter((name) => name === 'GET ws/a/original')).toHaveLength(2);
  });

  it('reads it from storage as it goes when the disk can’t hold it and what the job writes', async () => {
    store.set('ws/a/original', file('too-big.bin', 5000).bytes);
    const dir = mkdtempSync(join(work, 'job-'));
    const input = await originalInput('ws/a/original', dir, () => Number.MAX_SAFE_INTEGER, fast);
    expect(input).toMatch(/\/objects\/ws\/a\/original$/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
