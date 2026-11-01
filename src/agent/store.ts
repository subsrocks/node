import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { NodeJobKind, NodeJobOutcome } from '../protocol.ts';

/**
 * The node's folder (`--data`): its credential, the jobs' ends it hasn't been able to report yet,
 * the built-in fonts, its yt-dlp when it fetched one, and a folder per job while it works. In the image it's the `/data` volume,
 * so the node keeps its place in the workspace across restarts and updates.
 */

/** What joining a workspace gave it: kept readable by its owner only. */
const Credential = z.object({
  server: z.string(),
  id: z.string(),
  name: z.string(),
  secret: z.string(),
});
export type Credential = z.infer<typeof Credential>;

/**
 * A job's end, kept until subs.rocks acknowledges it, so a restart can't lose a finished render
 * or download. Its kind, from 1.4 (before, a render's).
 */
const Pending = z.object({
  job: z.string(),
  kind: NodeJobKind.default('render'),
  outcome: NodeJobOutcome,
});
export type Pending = z.infer<typeof Pending>;
/** Each job's end not yet heard, a render's and a download's; one alone, as before 1.4. */
const Pendings = z.union([z.array(Pending).max(8), Pending.transform((one) => [one])]);

export class Store {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  get fontsDir(): string {
    return join(this.dir, 'fonts');
  }

  get workDir(): string {
    return join(this.dir, 'work');
  }

  /** Its folders, made where missing, and what a job left behind cleared. */
  async prepare(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await rm(this.workDir, { recursive: true, force: true });
    await mkdir(this.workDir, { recursive: true });
    await mkdir(this.fontsDir, { recursive: true });
  }

  private async read<T>(name: string, schema: z.ZodType<T>): Promise<T | null> {
    let text: string;
    try {
      text = await readFile(join(this.dir, name), 'utf8');
    } catch {
      return null;
    }
    try {
      return schema.parse(JSON.parse(text));
    } catch {
      return null;
    }
  }

  /** Written whole or not at all: to a file beside it, then moved over it. */
  private async write(name: string, value: unknown): Promise<void> {
    const path = join(this.dir, name);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  }

  credential(): Promise<Credential | null> {
    return this.read('node.json', Credential);
  }

  saveCredential(credential: Credential): Promise<void> {
    return this.write('node.json', credential);
  }

  async forget(): Promise<void> {
    await rm(join(this.dir, 'node.json'), { force: true });
    await rm(join(this.dir, 'pending.json'), { force: true });
  }

  async pending(): Promise<Pending[]> {
    return (await this.read('pending.json', Pendings)) ?? [];
  }

  async setPending(pending: readonly Pending[]): Promise<void> {
    if (pending.length === 0) await rm(join(this.dir, 'pending.json'), { force: true });
    else await this.write('pending.json', pending);
  }
}
