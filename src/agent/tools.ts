import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The ffmpeg and ffprobe renders run with: the ones `--ffmpeg` names (ffprobe beside it); the
 * engine's own `FFMPEG` and `FFPROBE`, as subs.rocks's machines set them; on a Mac, Homebrew's
 * `ffmpeg-full`, which Homebrew keeps off the PATH and is its ffmpeg with libass (its `ffmpeg`
 * has none); or the PATH's.
 */
export type Tools = { ffmpeg: string; ffprobe: string };

/** Where Homebrew is on a Mac: where it says, then Apple silicon's place, then Intel's. */
function homebrews(env: NodeJS.ProcessEnv): string[] {
  return [env['HOMEBREW_PREFIX'], '/opt/homebrew', '/usr/local'].filter(
    (prefix): prefix is string => Boolean(prefix),
  );
}

async function runnable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findTools(
  given: string | null,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<Tools> {
  if (given) {
    // A path's ffprobe is the one beside it; a bare name's, the PATH's.
    const beside = given.includes('/') ? join(dirname(given), 'ffprobe') : 'ffprobe';
    return { ffmpeg: given, ffprobe: beside };
  }
  const ffmpeg = env['FFMPEG'];
  if (ffmpeg) return { ffmpeg, ffprobe: env['FFPROBE'] ?? 'ffprobe' };
  if (platform === 'darwin') {
    for (const prefix of homebrews(env)) {
      const bin = join(prefix, 'opt/ffmpeg-full/bin');
      const tools = { ffmpeg: join(bin, 'ffmpeg'), ffprobe: join(bin, 'ffprobe') };
      if ((await runnable(tools.ffmpeg)) && (await runnable(tools.ffprobe))) return tools;
    }
  }
  return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
}
