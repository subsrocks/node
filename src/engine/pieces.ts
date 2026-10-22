import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type FrameGrid,
  frameRatio,
  type RenderAudioJob,
  type RenderAudioResult,
  type RenderJoinJob,
  type RenderJoinResult,
  type RenderPieceJob,
  type RenderPieceResult,
} from '../job.ts';
import { audioArgs, container, decodeArgs, settingsOf, videoArgs } from './encode.ts';
import { JobError } from './errors.ts';
import { NETWORK_INPUT, type RunOptions, run, seconds } from './ffmpeg.ts';
import type { Hardware } from './hardware.ts';
import { getFile, type IoOptions, objectUrl, putFile, putJson } from './io.ts';
import {
  bytesStage,
  EncodeProgress,
  FontReport,
  prepareRender,
  probeOutput,
  progressWriter,
  renderAudioFilter,
  renderFilter,
  saveFile,
} from './render.ts';

/**
 * A render on several machines: each draws and encodes a piece of its frames, one makes
 * its sound, and one joins them. On the render's frame grid, the joined file has the very frames
 * one machine would have made; the join checks that it does before it's kept.
 */

/** How long `frames` frames last on a grid, in milliseconds. */
export function gridMs(frames: number, grid: FrameGrid): number {
  const { num, den } = frameRatio(grid.fps);
  return (frames * den * 1000) / num;
}

/** The video frames in a file (its packets: one a frame), read without decoding. */
export async function countFrames(path: string): Promise<number> {
  const output = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-count_packets',
    '-show_entries',
    'stream=nb_read_packets',
    '-of',
    'csv=p=0',
    path,
  ]);
  return Number.parseInt(output.trim(), 10) || 0;
}

/**
 * What decides whether encoded pieces join into one stream: the codec, its profile and level, the
 * frame and pixel format, and the parameter sets every decoder starts from (`extradata`), which
 * the joined file keeps one copy of.
 */
async function encodingOf(path: string): Promise<string> {
  const output = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_data_hash',
    'sha256',
    '-show_entries',
    'stream=codec_name,profile,level,width,height,pix_fmt,extradata_hash',
    '-of',
    'csv=p=0',
    path,
  ]);
  return output.trim();
}

/**
 * One piece's encode: the render's filters on its grid, its frames only, without sound, read
 * from `input` (the original, in storage or a copy), on `on`'s hardware or the CPU's encoders (on
 * `threads` of them when given), written to `out`.
 */
export async function encodePiece(
  job: RenderPieceJob,
  input: string,
  out: string,
  encoding: { on: Hardware | null; threads: number | null },
  options: Pick<RunOptions, 'cwd' | 'env' | 'onStderr' | 'onStdout' | 'signal'>,
): Promise<void> {
  const settings = settingsOf(job);
  const { piece, grid } = job;
  await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-y',
      '-loglevel',
      'info',
      '-progress',
      'pipe:1',
      ...NETWORK_INPUT,
      ...decodeArgs(encoding.on, encoding.threads),
      // The original's own timestamps, so the filters place every frame and subtitle on the
      // render's timeline; `-ss` counts from the file's start, a little before the piece's.
      '-copyts',
      ...(piece.seekMs > 0 ? ['-ss', seconds(piece.seekMs)] : []),
      '-i',
      input,
      '-map',
      '0:v:0',
      '-an',
      '-vf',
      renderFilter(job, piece, encoding.on),
      ...videoArgs(settings, gridMs(piece.startFrame, grid) / 1000, encoding.on, encoding.threads),
      '-avoid_negative_ts',
      'make_zero',
      out,
    ],
    options,
  );
}

/** One piece, on a machine of its own: read from storage, written back. */
export async function renderPiece(
  job: RenderPieceJob,
  workDir: string,
): Promise<RenderPieceResult> {
  const env = await prepareRender(job, workDir);
  const settings = settingsOf(job);
  const file = container(settings);
  const out = join(workDir, `piece.${file.extension}`);
  const { piece, grid } = job;
  const report = new FontReport();
  const progressFile = job.progress;
  const progress = progressFile
    ? new EncodeProgress(gridMs(piece.endFrame - piece.startFrame, grid), (value) =>
        putJson(progressFile.key, value),
      )
    : null;
  await encodePiece(
    job,
    objectUrl(job.input.key),
    out,
    { on: null, threads: null },
    {
      cwd: workDir,
      env,
      onStderr: (chunk) => report.push(chunk),
      onStdout: (chunk) => progress?.push(chunk),
    },
  );
  await progress?.settle();
  const frames = await countFrames(out);
  return { output: await putFile(out, job.output.key, file.mime), frames, ...report.finish() };
}

/** Whether the original has sound: renders of silent videos have none either. */
export async function hasAudio(url: string): Promise<boolean> {
  const output = await run('ffprobe', [
    ...NETWORK_INPUT,
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=index',
    '-of',
    'csv=p=0',
    url,
  ]);
  return output.trim() !== '';
}

/** The file a render's sound is made into apart from its picture, as the join takes it. */
export function audioFile(settings: RenderAudioJob['settings']): string {
  return settings.codec === 'prores' ? 'audio.mov' : 'audio.m4a';
}

/**
 * The render's sound, made as the whole render makes it, from `input` into `out`, for the join
 * to add; false when the original has none.
 */
export async function encodeAudio(
  job: Omit<RenderAudioJob, 'input' | 'output'>,
  input: string,
  out: string,
): Promise<boolean> {
  if (!(await hasAudio(input))) return false;
  await run('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-y',
    '-loglevel',
    'error',
    ...NETWORK_INPUT,
    '-i',
    input,
    '-map',
    '0:a:0',
    '-vn',
    '-af',
    renderAudioFilter(job),
    ...audioArgs(job.settings),
    '-t',
    seconds(job.durationMs),
    out,
  ]);
  return true;
}

/** The render's sound on a machine of its own: read from storage, written back. */
export async function renderAudio(
  job: RenderAudioJob,
  workDir: string,
): Promise<RenderAudioResult> {
  const prores = job.settings.codec === 'prores';
  const out = join(workDir, audioFile(job.settings));
  if (!(await encodeAudio(job, objectUrl(job.input.key), out))) return { output: null };
  return { output: await putFile(out, job.output.key, prores ? 'video/quicktime' : 'audio/mp4') };
}

/**
 * A join that can't be trusted: not retried, so the render is made whole instead (on one of
 * subs.rocks's machines, or on the node that made the pieces).
 */
export class JoinMismatch extends JobError {
  constructor(detail: string) {
    super('processing_failed', `pieces don't join: ${detail}`, false);
    this.name = 'JoinMismatch';
  }
}

function mismatch(detail: string): JoinMismatch {
  return new JoinMismatch(detail);
}

/**
 * Pieces' files joined in order, with the sound, into `out`, stream copied: refused unless every
 * piece holds its frames and is encoded alike, and the joined file holds all of them, timed on the
 * grid. Each piece is `{ path, frames }`, the frames it should hold.
 */
export async function joinPieces(
  job: Pick<RenderJoinJob, 'grid' | 'settings'>,
  pieces: readonly { path: string; frames: number }[],
  audio: string | null,
  out: string,
  workDir: string,
): Promise<{ width: number; height: number; durationMs: number }> {
  const paths = pieces.map((piece) => piece.path);
  const encodings = await Promise.all(paths.map(encodingOf));
  const counts = await Promise.all(paths.map(countFrames));
  pieces.forEach((piece, i) => {
    if (encodings[i] !== encodings[0]) {
      throw mismatch(`piece ${i + 1} is encoded as ${encodings[i]}, piece 1 as ${encodings[0]}`);
    }
    if (counts[i] !== piece.frames) {
      throw mismatch(`piece ${i + 1} holds ${counts[i]} frames, not ${piece.frames}`);
    }
  });

  // Each piece lasts exactly its frames: a file's own duration leaves its last frame out, and the
  // next piece would start a frame early.
  const { num, den } = frameRatio(job.grid.fps);
  const list = paths
    .map((path, i) => {
      const frames = pieces[i]?.frames ?? 0;
      return `file '${path}'\nduration ${((frames * den) / num).toFixed(6)}\n`;
    })
    .join('');
  const listPath = join(workDir, 'pieces.txt');
  await writeFile(listPath, list);
  await run('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    ...(audio ? ['-i', audio] : []),
    '-map',
    '0:v:0',
    ...(audio ? ['-map', '1:a:0'] : []),
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    out,
  ]);

  const total = pieces.reduce((sum, piece) => sum + piece.frames, 0);
  const joined = await countFrames(out);
  if (joined !== total) throw mismatch(`the joined file holds ${joined} frames, not ${total}`);
  const probed = await probeOutput(out);
  const expectedMs = gridMs(total, job.grid);
  if (Math.abs(probed.durationMs - expectedMs) > gridMs(1, job.grid) + 50) {
    throw mismatch(`the joined file lasts ${probed.durationMs} ms, not ${Math.round(expectedMs)}`);
  }
  return probed;
}

/**
 * The pieces joined on a machine of their own: read from storage, saying how much of them has
 * come where the job gives their sizes, and written back.
 */
export async function joinRender(job: RenderJoinJob, workDir: string): Promise<RenderJoinResult> {
  const write = progressWriter(job.progress);
  const file = container(job.settings);
  const pieces = job.pieces.map((piece, i) => ({
    path: join(workDir, `piece-${i}.${file.extension}`),
    frames: piece.frames,
  }));
  const gathering = bytesStage('joining', write);
  // The pieces come at once: how much of all of them has, where the job gives their sizes.
  const total = job.pieces.reduce((sum, piece) => sum + (piece.bytes ?? 0), 0);
  const came = job.pieces.map(() => 0);
  const gather = (i: number): IoOptions => {
    const told = gathering.io.onBytes;
    if (!told || total === 0) return {};
    return {
      onBytes: (done) => {
        came[i] = done;
        told(
          came.reduce((sum, bytes) => sum + bytes, 0),
          total,
        );
      },
    };
  };
  await Promise.all(
    job.pieces.map((piece, i) => getFile(piece.key, pieces[i]?.path ?? '', gather(i))),
  );
  const audio = job.audio ? join(workDir, audioFile(job.settings)) : null;
  if (job.audio && audio) await getFile(job.audio.key, audio);
  const out = join(workDir, `render.${file.extension}`);
  const probed = await joinPieces(job, pieces, audio, out, workDir);
  await gathering.settle();
  return { output: await saveFile(out, job.output.key, file.mime, write), ...probed };
}
