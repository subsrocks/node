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
import { audioArgs, container, settingsOf, videoArgs } from './encode.ts';
import { JobError } from './errors.ts';
import { NETWORK_INPUT, run, seconds } from './ffmpeg.ts';
import { getFile, objectUrl, putFile, putJson } from './io.ts';
import {
  EncodeProgress,
  FontReport,
  prepareRender,
  probeOutput,
  renderAudioFilter,
  renderFilter,
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
async function countFrames(path: string): Promise<number> {
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

/** One piece: the render's filters on its grid, its frames only, without sound. */
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
      // The original's own timestamps, so the filters place every frame and subtitle on the
      // render's timeline; `-ss` counts from the file's start, a little before the piece's.
      '-copyts',
      ...(piece.seekMs > 0 ? ['-ss', seconds(piece.seekMs)] : []),
      '-i',
      objectUrl(job.input.key),
      '-map',
      '0:v:0',
      '-an',
      '-vf',
      renderFilter(job, piece),
      ...videoArgs(settings, gridMs(piece.startFrame, grid) / 1000),
      '-avoid_negative_ts',
      'make_zero',
      out,
    ],
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
async function hasAudio(url: string): Promise<boolean> {
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

/** The render's sound, made as the whole render makes it, for the join to add. */
export async function renderAudio(
  job: RenderAudioJob,
  workDir: string,
): Promise<RenderAudioResult> {
  const input = objectUrl(job.input.key);
  if (!(await hasAudio(input))) return { output: null };
  const prores = job.settings.codec === 'prores';
  const out = join(workDir, prores ? 'audio.mov' : 'audio.m4a');
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
  return { output: await putFile(out, job.output.key, prores ? 'video/quicktime' : 'audio/mp4') };
}

/** A join that can't be trusted: not retried, so the render is made on one machine instead. */
function mismatch(detail: string): JobError {
  return new JobError('processing_failed', `pieces don't join: ${detail}`, false);
}

/**
 * The pieces joined in order, with the sound, into the render's file, stream copied: refused
 * unless every piece holds its frames and is encoded alike, and the joined file holds all of them,
 * timed on the grid.
 */
export async function joinRender(job: RenderJoinJob, workDir: string): Promise<RenderJoinResult> {
  const file = container(job.settings);
  const paths = job.pieces.map((_, i) => join(workDir, `piece-${i}.${file.extension}`));
  await Promise.all(job.pieces.map((piece, i) => getFile(piece.key, paths[i] ?? '')));
  const audio = job.audio
    ? join(workDir, `audio.${job.settings.codec === 'prores' ? 'mov' : 'm4a'}`)
    : null;
  if (job.audio && audio) await getFile(job.audio.key, audio);

  const encodings = await Promise.all(paths.map(encodingOf));
  const counts = await Promise.all(paths.map(countFrames));
  job.pieces.forEach((piece, i) => {
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
      const frames = job.pieces[i]?.frames ?? 0;
      return `file '${path}'\nduration ${((frames * den) / num).toFixed(6)}\n`;
    })
    .join('');
  const listPath = join(workDir, 'pieces.txt');
  await writeFile(listPath, list);
  const out = join(workDir, `render.${file.extension}`);
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

  const total = job.pieces.reduce((sum, piece) => sum + piece.frames, 0);
  const joined = await countFrames(out);
  if (joined !== total) throw mismatch(`the joined file holds ${joined} frames, not ${total}`);
  const probed = await probeOutput(out);
  const expectedMs = gridMs(total, job.grid);
  if (Math.abs(probed.durationMs - expectedMs) > gridMs(1, job.grid) + 50) {
    throw mismatch(`the joined file lasts ${probed.durationMs} ms, not ${Math.round(expectedMs)}`);
  }
  return { output: await putFile(out, job.output.key, file.mime), ...probed };
}
