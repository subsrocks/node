import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { WrittenFile } from '../job.ts';
import { config } from './config.ts';
import { JobError } from './errors.ts';
import { log } from './log.ts';

/**
 * The URL ffmpeg reads an object from (range requests supported), with a query for the storage
 * host's multipart verbs when given.
 */
export function objectUrl(key: string, query: Record<string, string> = {}): string {
  const path = key.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`${config.ioOrigin}/objects/${path}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  if (config.ioToken) url.searchParams.set('token', config.ioToken);
  return url.toString();
}

/**
 * Files larger than this go up in parts, a few at a time, each sent again on its own when it
 * fails. One request carrying a whole 4K render (870 MB) was cut off as it ended,
 * twice, and each time the render's 24-minute encode ran again from the start.
 */
export const PART_BYTES = 64 * 1024 * 1024;
const PARTS_AT_ONCE = 4;
/** The waits before each new try of a request that failed in a way that may pass. */
const RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 15_000];

export type IoOptions = { partBytes?: number; retryDelaysMs?: readonly number[] };

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** A file, or the bytes `start` to `end` (exclusive) of it, as a request body. */
function fileBody(path: string, range?: { start: number; end: number }): RequestInit {
  const stream = createReadStream(path, range && { start: range.start, end: range.end - 1 });
  return { body: Readable.toWeb(stream) as ReadableStream, duplex: 'half' } as RequestInit;
}

function failureOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : error.cause;
  return cause ? `${error.message} (${String(cause)})` : error.message;
}

/**
 * One request to storage, made again (`make` builds it afresh, body and all) after a dropped
 * connection, a 5xx or a 429. A job that still can't store its result fails as one to retry.
 */
async function request(
  what: string,
  delays: readonly number[],
  make: () => [url: string, init: RequestInit],
): Promise<Response> {
  let failure = '';
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1] ?? 0);
    try {
      const response = await fetch(...make());
      if (response.ok) return response;
      failure = `HTTP ${response.status}`;
      await response.body?.cancel();
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      failure = failureOf(error);
    }
  }
  throw new JobError('processing_failed', `${what} failed: ${failure}`, true);
}

/** Streams a local file to storage, in parts when it's large; returns what was written. */
export async function putFile(
  path: string,
  key: string,
  mime: string,
  options: IoOptions = {},
): Promise<WrittenFile> {
  const partBytes = options.partBytes ?? PART_BYTES;
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const { size } = await stat(path);
  const sha256 = await sha256File(path);
  if (size > partBytes) {
    await putParts(path, key, mime, size, partBytes, delays);
  } else {
    await request(`storing ${key}`, delays, () => [
      objectUrl(key),
      {
        method: 'PUT',
        headers: {
          'Content-Type': mime,
          'Content-Length': String(size),
          'X-Content-SHA256': sha256,
        },
        ...fileBody(path),
      },
    ]);
  }
  return { key, bytes: size, sha256, mime };
}

/**
 * A file in parts, through the storage host's multipart verbs: started, its parts stored a few
 * at a time, then finished; dropped if a part can't be stored.
 */
async function putParts(
  path: string,
  key: string,
  mime: string,
  size: number,
  partBytes: number,
  delays: readonly number[],
): Promise<void> {
  const started = await request(`starting ${key} in parts`, delays, () => [
    objectUrl(key, { uploads: '' }),
    { method: 'POST', headers: { 'Content-Type': mime } },
  ]);
  const { uploadId } = (await started.json()) as { uploadId: string };
  const count = Math.ceil(size / partBytes);
  const parts: { partNumber: number; etag: string }[] = [];
  let next = 1;
  let failed = false;
  const sender = async () => {
    while (!failed && next <= count) {
      const partNumber = next++;
      const start = (partNumber - 1) * partBytes;
      const end = Math.min(size, start + partBytes);
      try {
        const response = await request(
          `storing part ${partNumber} of ${count} of ${key}`,
          delays,
          () => [
            objectUrl(key, { uploadId, partNumber: String(partNumber) }),
            {
              method: 'PUT',
              headers: { 'Content-Length': String(end - start) },
              ...fileBody(path, { start, end }),
            },
          ],
        );
        const { etag } = (await response.json()) as { etag: string };
        parts.push({ partNumber, etag });
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  // Every sender is waited for before the upload is dropped, so no part lands after.
  const sent = await Promise.allSettled(
    Array.from({ length: Math.min(PARTS_AT_ONCE, count) }, sender),
  );
  const refused = sent.find((result) => result.status === 'rejected');
  try {
    if (refused) throw refused.reason;
    parts.sort((a, b) => a.partNumber - b.partNumber);
    await request(`finishing ${key}`, delays, () => [
      objectUrl(key, { uploadId }),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts, bytes: size }),
      },
    ]);
  } catch (error) {
    // Best-effort: storage drops an unfinished upload on its own after a week.
    await fetch(objectUrl(key, { uploadId }), { method: 'DELETE' }).catch(() => undefined);
    throw error;
  }
}

/**
 * An object read from storage, its response handed to `use`: asked for again from the start when
 * the response fails or `use` breaks off partway (as `request` decides).
 */
async function readObject<T>(
  key: string,
  options: IoOptions,
  use: (response: Response & { body: ReadableStream }) => Promise<T>,
): Promise<T> {
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  let failure = '';
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1] ?? 0);
    try {
      const response = await fetch(objectUrl(key));
      if (response.ok && response.body)
        return await use(response as Response & { body: ReadableStream });
      failure = `HTTP ${response.status}`;
      await response.body?.cancel();
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      failure = failureOf(error);
    }
  }
  throw new JobError('processing_failed', `reading ${key} failed: ${failure}`, true);
}

async function save(body: ReadableStream, path: string): Promise<number> {
  await pipeline(
    Readable.fromWeb(body as import('node:stream/web').ReadableStream),
    createWriteStream(path),
  );
  return (await stat(path)).size;
}

/** Streams an object to a local file, read again from the start if it breaks off. Its size. */
export function getFile(key: string, path: string, options: IoOptions = {}): Promise<number> {
  return readObject(key, options, (response) => save(response.body, path));
}

/**
 * Where ffmpeg reads an original it takes the picture and the sound of together: a copy
 * in `workDir` when the disk holds it with `spare(bytes)` left for what the job writes, or else
 * storage, read as it goes. ffmpeg reads a file in time order, so an original that keeps its
 * picture and its sound apart (all of one, then all of the other) is read from storage back and
 * forth, in ranges each cut off by the next: 9,329 requests and 19.6 GB for a 204 MB video 2:41
 * long. Its copy is one request.
 */
export async function originalInput(
  key: string,
  workDir: string,
  spare: (bytes: number) => number,
  options: IoOptions = {},
): Promise<string> {
  const path = join(workDir, 'original');
  const copied = await readObject(key, options, async (response) => {
    const length = response.headers.get('Content-Length');
    const bytes = length === null ? Number.NaN : Number(length);
    // A copy that broke off, asked for again: its part isn't counted against the room.
    await rm(path, { force: true });
    const { bavail, bsize } = await statfs(workDir);
    const free = bavail * bsize;
    // Not `>`: a size not given (NaN) isn't copied either.
    if (!(bytes + spare(bytes) <= free)) {
      await response.body.cancel();
      log('info', 'original read from storage: no room to copy it', { key, bytes, free });
      return false;
    }
    await save(response.body, path);
    return true;
  });
  return copied ? path : objectUrl(key);
}

/** Writes a small JSON object to storage, such as a job's progress. */
export async function putJson(key: string, value: unknown): Promise<void> {
  const body = JSON.stringify(value);
  const response = await fetch(objectUrl(key), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
  });
  if (!response.ok) {
    throw new JobError('processing_failed', `storing ${key} failed: HTTP ${response.status}`, true);
  }
}
