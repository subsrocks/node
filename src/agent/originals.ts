import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Output } from './output.ts';

/**
 * The originals a machine keeps (ADR 0093), so the next render of a video doesn't bring it over
 * again: the ones its renders read, and the ones it downloaded itself. Each is known by its
 * version in subs.rocks's storage (`bytes:etag`, which changes whenever the file does), so a video
 * replaced there is simply not found here. Each is checked against the SHA-256 this machine took
 * when it kept it, before every use: a damaged copy is dropped, and the video read from storage.
 *
 * Bounded: so many bytes, the ones used longest ago going first; so long since each was last used;
 * and never leaving the disk with less than `freeBytes`. Everything goes when the machine leaves
 * its workspace (`Store.forget`). It all happens in the node's own process, so one job's copy
 * going can't race another's. A job works on a hard link, which outlives the copy if that goes.
 */

export type OriginalsLimits = { maxBytes: number; maxAgeMs: number; freeBytes: number };

/** Up to 50 GB, 30 days since each was last used, and never leaving less than 20 GB free. */
export const DEFAULT_ORIGINALS: OriginalsLimits = {
  maxBytes: 50e9,
  maxAgeMs: 30 * 24 * 60 * 60_000,
  freeBytes: 20e9,
};

const Kept = z.object({
  version: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  usedAt: z.number().int(),
});
type Kept = z.infer<typeof Kept>;

const META = '.json';
const PARTIAL = '.partial';

/** The version of a stored file, as `inputVersion` says it: its bytes, then storage's ETag. */
export const fileVersion = (bytes: number, etag: string) => `${bytes}:${etag}`;

/** The size a version says its file is; null for anything else. */
export function bytesOfVersion(version: string): number | null {
  const match = /^(\d{1,15}):[\w.-]{1,200}$/.exec(version);
  return match ? Number(match[1]) : null;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export class Originals {
  private readonly dir: string;
  private readonly limits: OriginalsLimits;
  private readonly log: Pick<Output, 'warn' | 'debug'>;
  private readonly now: () => number;
  /** What changes the folder, one at a time, so a sweep can't take a copy half-recorded for lost. */
  private turn: Promise<unknown> = Promise.resolve();

  constructor(
    dir: string,
    limits: OriginalsLimits,
    log: Pick<Output, 'warn' | 'debug'>,
    now: () => number = Date.now,
  ) {
    this.dir = dir;
    this.limits = limits;
    this.log = log;
    this.now = now;
  }

  /** A version's file name: a hash, whatever subs.rocks calls it. */
  private nameOf(version: string): string {
    return createHash('sha256').update(version).digest('hex');
  }

  /** Its folder made, what a stop left half-kept cleared, and what's past its time gone. */
  async prepare(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const file of await readdir(this.dir)) {
      if (file.endsWith(PARTIAL)) await rm(join(this.dir, file), { force: true });
    }
    await this.sweep();
  }

  /** Its turn, once what's before it is done, whichever way that ended. */
  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const done = this.turn.then(work, work);
    this.turn = done.catch(() => undefined);
    return done;
  }

  /** What's kept, the used longest ago first; a copy without its record, or a record without its copy, goes. */
  private async entries(): Promise<(Kept & { name: string })[]> {
    const files = await readdir(this.dir).catch(() => [] as string[]);
    const copies = new Set(files.filter((file) => /^[0-9a-f]{64}$/.test(file)));
    const entries: (Kept & { name: string })[] = [];
    for (const file of files) {
      if (!file.endsWith(META)) continue;
      const name = file.slice(0, -META.length);
      const record = await readFile(join(this.dir, file), 'utf8')
        .then((text) => Kept.safeParse(JSON.parse(text)))
        .catch(() => null);
      if (record?.success && copies.has(name)) {
        entries.push({ ...record.data, name });
        copies.delete(name);
      } else {
        await rm(join(this.dir, file), { force: true });
      }
    }
    for (const orphan of copies) await rm(join(this.dir, orphan), { force: true });
    return entries.sort((a, b) => a.usedAt - b.usedAt);
  }

  private async drop(name: string): Promise<void> {
    await rm(join(this.dir, name), { force: true });
    await rm(join(this.dir, `${name}${META}`), { force: true });
  }

  /**
   * The copy of a version, checked and linked as `dest` for a job to read; false when there's
   * none, or it's damaged (and so dropped), or it can't be linked: the job reads storage then.
   */
  async linkInto(version: string, dest: string): Promise<boolean> {
    const name = this.nameOf(version);
    const path = join(this.dir, name);
    const record = await readFile(`${path}${META}`, 'utf8')
      .then((text) => Kept.safeParse(JSON.parse(text)))
      .catch(() => null);
    if (!record?.success || record.data.version !== version) return false;
    try {
      const sound =
        (await stat(path)).size === record.data.bytes &&
        (await sha256File(path)) === record.data.sha256;
      if (!sound) {
        this.log.warn('Its copy of a video was damaged: reading it from subs.rocks again');
        await this.drop(name);
        return false;
      }
      await rm(dest, { force: true });
      await link(path, dest);
      await writeFile(
        `${path}${META}`,
        JSON.stringify({ ...record.data, usedAt: this.now() } satisfies Kept),
      );
      return true;
    } catch (error) {
      this.log.debug(`Its copy of a video can't be used: ${String(error)}`);
      return false;
    }
  }

  /**
   * Keeps a whole file of this version, moved from the job's folder as that goes: moved at once,
   * so it's safe from the folder's removal, and checked after, without holding the job's end up.
   * A part (a job stopped mid-copy), or one the limits have no room for, isn't kept.
   */
  async take(version: string, from: string): Promise<void> {
    const bytes = bytesOfVersion(version);
    if (bytes === null || bytes > this.limits.maxBytes) return;
    const size = await stat(from)
      .then((file) => file.size)
      .catch(() => null);
    if (size !== bytes) return;
    const name = this.nameOf(version);
    const partial = join(this.dir, `${name}.${process.pid}.${this.now()}${PARTIAL}`);
    try {
      await rename(from, partial);
    } catch (error) {
      // Another disk than the job's folder: nothing is kept, and nothing's lost.
      this.log.debug(`A video can't be kept: ${String(error)}`);
      return;
    }
    void this.settle(version, bytes, name, partial).catch((error: unknown) => {
      this.log.debug(`A video wasn't kept: ${String(error)}`);
      void rm(partial, { force: true });
    });
  }

  private async settle(version: string, bytes: number, name: string, partial: string) {
    const sha256 = await sha256File(partial);
    await this.inTurn(async () => {
      const path = join(this.dir, name);
      await rename(partial, path);
      await writeFile(
        `${path}${META}`,
        JSON.stringify({ version, bytes, sha256, usedAt: this.now() } satisfies Kept),
      );
      await this.withinLimits();
    });
  }

  /** Back within its limits: past their time first, then the used longest ago. */
  sweep(): Promise<void> {
    return this.inTurn(() => this.withinLimits());
  }

  private async withinLimits(): Promise<void> {
    const entries = await this.entries();
    const now = this.now();
    let total = 0;
    const kept: typeof entries = [];
    for (const entry of entries) {
      if (now - entry.usedAt > this.limits.maxAgeMs) await this.drop(entry.name);
      else {
        kept.push(entry);
        total += entry.bytes;
      }
    }
    for (const entry of kept) {
      const { bavail, bsize } = await statfs(this.dir);
      if (total <= this.limits.maxBytes && bavail * bsize >= this.limits.freeBytes) break;
      await this.drop(entry.name);
      total -= entry.bytes;
    }
  }

  /** How much is kept, for `doctor` to say. */
  async size(): Promise<{ videos: number; bytes: number }> {
    const entries = await this.inTurn(() => this.entries());
    return {
      videos: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    };
  }
}
