import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * The downloader a node downloads linked videos with (ADR 0092): yt-dlp, the one subs.rocks's own
 * fetcher runs. The one `--yt-dlp` names; else the PATH's (the image has it); else its official
 * release, pinned here (the same as subs.rocks's), downloaded once into the data folder and
 * checked against the release's SHA-256 before it's ever run. And the JavaScript runtime it solves
 * YouTube's challenges with, when the machine has one.
 */

const run = promisify(execFile);

/** The release a node fetches for itself, and each platform's file of it with its SHA-256. */
export const YTDLP_RELEASE = {
  version: '2026.08.19',
  assets: {
    'linux-x64': {
      file: 'yt-dlp_linux',
      sha256: '58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a',
    },
    'linux-arm64': {
      file: 'yt-dlp_linux_aarch64',
      sha256: 'b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc',
    },
    // One file for Apple silicon and Intel.
    'darwin-arm64': {
      file: 'yt-dlp_macos',
      sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202',
    },
    'darwin-x64': {
      file: 'yt-dlp_macos',
      sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202',
    },
  } as Record<string, { file: string; sha256: string }>,
} as const;

export type Downloader = {
  /** The yt-dlp to run. */
  ytDlp: string;
  /** Its version, as it says it. */
  version: string;
  /** The JavaScript runtime it's given for YouTube's challenges, or '' when there's none. */
  jsRuntime: string;
};

/** A program's version, if it runs at all. */
async function versionOf(file: string, flag = '--version'): Promise<string | null> {
  try {
    const { stdout } = await run(file, [flag], { timeout: 15_000 });
    return stdout.trim().split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

/** The JavaScript runtime the machine has for yt-dlp: node, then deno, or none. */
async function jsRuntime(): Promise<string> {
  for (const name of ['node', 'deno']) {
    if (await versionOf(name)) return name;
  }
  return '';
}

/** Where the pinned release is kept in the data folder. */
const kept = (dataDir: string) => join(dataDir, 'bin', `yt-dlp-${YTDLP_RELEASE.version}`);

/** The release, downloaded and checked, into the data folder. */
async function fetchRelease(
  dataDir: string,
  platform: string,
  fetcher: typeof fetch,
): Promise<string> {
  const asset = YTDLP_RELEASE.assets[platform];
  if (!asset) throw new Error(`there's no yt-dlp release for ${platform}`);
  const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_RELEASE.version}/${asset.file}`;
  const response = await fetcher(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sum = createHash('sha256').update(bytes).digest('hex');
  if (sum !== asset.sha256) {
    throw new Error(`yt-dlp ${YTDLP_RELEASE.version} isn't what its release says (${sum})`);
  }
  const path = kept(dataDir);
  await mkdir(join(dataDir, 'bin'), { recursive: true });
  // Written aside, then moved into place: a half-written file is never taken for it.
  const partial = `${path}.partial`;
  await writeFile(partial, bytes, { mode: 0o755 });
  await chmod(partial, 0o755);
  await rename(partial, path);
  return path;
}

/** Whether a file is the pinned release, by its SHA-256. */
async function isRelease(path: string, platform: string): Promise<boolean> {
  const asset = YTDLP_RELEASE.assets[platform];
  try {
    const bytes = await readFile(path);
    return asset !== undefined && createHash('sha256').update(bytes).digest('hex') === asset.sha256;
  } catch {
    return false;
  }
}

/**
 * The downloader, found or fetched; null, with why, when there's none to be had (no release for
 * this platform, GitHub unreachable).
 */
export async function findDownloader(
  given: string | null,
  dataDir: string,
  options: {
    platform?: string;
    fetcher?: typeof fetch;
    /** Whether the PATH's is looked for (it is, but where a test says otherwise). */
    onPath?: boolean;
    onFetch?: (version: string) => void;
  } = {},
): Promise<Downloader | { problem: string }> {
  const platform = options.platform ?? `${process.platform}-${process.arch}`;
  const runtime = await jsRuntime();
  if (given) {
    const version = await versionOf(given);
    if (!version) return { problem: `--yt-dlp ${given} doesn't run` };
    return { ytDlp: given, version, jsRuntime: runtime };
  }
  const onPath = options.onPath === false ? null : await versionOf('yt-dlp');
  if (onPath) return { ytDlp: 'yt-dlp', version: onPath, jsRuntime: runtime };
  const path = kept(dataDir);
  try {
    if (!(await isRelease(path, platform))) {
      await rm(path, { force: true });
      options.onFetch?.(YTDLP_RELEASE.version);
      await fetchRelease(dataDir, platform, options.fetcher ?? fetch);
    }
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
  const version = await versionOf(path);
  if (!version) return { problem: `yt-dlp ${YTDLP_RELEASE.version} doesn't run on this machine` };
  return { ytDlp: path, version, jsRuntime: runtime };
}
