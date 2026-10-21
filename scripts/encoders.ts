/**
 * Every encode a render preset can ask for, made for a second here: each codec with each rate
 * control, 10-bit, a frame rate and keyframes, ProRes's profiles. In an image, it proves that
 * image's ffmpeg has every encoder and takes every argument; natively, the same of this machine.
 * Only types from `../src/job.ts`, so it runs with nothing installed:
 *
 *   node scripts/encoders.ts
 */
import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioArgs, container, fpsFilter, pixelFormat, videoArgs } from '../src/engine/encode.ts';
import { ENCODES } from '../src/engine/encode-matrix.ts';
import type { RenderSettings } from '../src/job.ts';

function ffmpeg(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(process.env['FFMPEG'] ?? 'ffmpeg', [
      '-hide_banner',
      '-v',
      'error',
      ...args,
    ]);
    const err: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => resolve(String(error)));
    child.on('close', (code) => resolve(code === 0 ? null : Buffer.concat(err).toString().trim()));
  });
}

/** One second of a test picture and a tone, encoded as `settings` say. Null when it worked. */
export async function tryEncode(settings: RenderSettings, dir: string, name: string) {
  const filters = [fpsFilter(settings), `format=${pixelFormat(settings)}`].filter(Boolean);
  return ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=330:sample_rate=48000',
    '-t',
    '1',
    '-vf',
    filters.join(','),
    ...videoArgs(settings),
    ...audioArgs(settings),
    '-y',
    join(dir, `${name}.${container(settings).extension}`),
  ]);
}

if (import.meta.main) {
  const dir = await mkdtemp(join(tmpdir(), 'encoders-'));
  const rows = ['| Encode | Result |', '|---|---|'];
  let ok = true;
  try {
    for (const [name, settings] of Object.entries(ENCODES)) {
      const failure = await tryEncode(settings, dir, name);
      ok &&= failure === null;
      rows.push(
        `| ${name} | ${failure === null ? 'ok' : `**failed**: ${failure.split('\n')[0]}`} |`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const summary = ['## Render encoders', '', ...rows, ''].join('\n');
  process.stdout.write(summary);
  const file = process.env['GITHUB_STEP_SUMMARY'];
  if (file) await appendFile(file, summary);
  if (!ok) process.exit(1);
}
