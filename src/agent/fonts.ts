import { createHash } from 'node:crypto';
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BuiltInFonts } from '../protocol.ts';
import { call } from './api.ts';

/**
 * The fonts renders draw with when a template brings none: the very files subs.rocks's editor
 * previews with, downloaded from subs.rocks before a render and kept, each checked against its
 * SHA-256. So a render on this machine draws what the preview drew, and fonts subs.rocks adds
 * later reach the node without an update.
 */

const AT_ONCE = 4;

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/** Whether `path` holds the font, by size first and then its hash. */
async function holds(path: string, font: { sha256: string; bytes: number }): Promise<boolean> {
  try {
    if ((await stat(path)).size !== font.bytes) return false;
  } catch {
    return false;
  }
  return (await sha256(path)) === font.sha256;
}

/** Hashes already checked this run, so a render doesn't hash 35 MB of fonts again. */
const checked = new Map<string, string>();

/**
 * The fonts folder holding exactly the built-in fonts: missing ones downloaded, any no longer
 * built in removed. Returns how many it downloaded.
 */
export async function syncFonts(server: string, dir: string): Promise<number> {
  const { fonts } = await call(server, '/fonts/built-in.json', {}, BuiltInFonts);
  const wanted = new Set(fonts.map((font) => font.file));
  for (const name of await readdir(dir)) {
    if (!wanted.has(name)) {
      await rm(join(dir, name), { force: true });
      checked.delete(name);
    }
  }
  let downloaded = 0;
  const queue = [...fonts];
  const worker = async () => {
    for (let font = queue.shift(); font; font = queue.shift()) {
      const path = join(dir, font.file);
      if (checked.get(font.file) === font.sha256 || (await holds(path, font))) {
        checked.set(font.file, font.sha256);
        continue;
      }
      const response = await fetch(new URL(font.url, server), {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`font ${font.file}: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (hash !== font.sha256) throw new Error(`font ${font.file} isn't the file it should be`);
      const temporary = `${path}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, path);
      checked.set(font.file, font.sha256);
      downloaded += 1;
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  return downloaded;
}
