import { type FrameGrid, frameRatio, type RenderPiece } from './job.ts';

/**
 * How a render is cut into pieces: subs.rocks spreads them across its machines (ADR 0044), and a
 * node with more threads than one encoder uses encodes several of its own at once (ADR 0078). Pure,
 * so a plan is the same however often it's made.
 */

/** Each piece reads the original from this long before its first frame. */
export const PREROLL_MS = 2_000;

/** When frame `n` starts on the grid, in milliseconds. */
export function frameMs(frame: number, grid: FrameGrid): number {
  const { num, den } = frameRatio(grid.fps);
  return (frame * den * 1000) / num;
}

/** Where a moment of the cut video comes from in the original: later by every cut-out before it. */
export function uncutTime(ms: number, cuts: readonly { startMs: number; endMs: number }[]): number {
  let at = ms;
  for (const cut of cuts) {
    if (cut.startMs > at) break;
    at += cut.endMs - cut.startMs;
  }
  return at;
}

/**
 * The render's `count` pieces, equal in frames, each starting where the render forces a keyframe
 * when it forces them (so they fall where one encode's would). Empty when it's made whole.
 */
export function planPieces(
  grid: FrameGrid,
  count: number,
  cuts: readonly { startMs: number; endMs: number }[],
  keyframeSeconds: number | null = null,
): RenderPiece[] {
  if (count < 2) return [];
  const { num, den } = frameRatio(grid.fps);
  const starts = [0];
  for (let i = 1; i < count; i++) {
    let frame = Math.round((grid.frames * i) / count);
    if (keyframeSeconds) {
      // The first frame at or after the nearest forced keyframe's time.
      const point = Math.round(frameMs(frame, grid) / 1000 / keyframeSeconds) * keyframeSeconds;
      frame = Math.ceil((point * num) / den - 1e-9);
    }
    const last = starts.at(-1) ?? 0;
    if (frame > last && frame < grid.frames) starts.push(frame);
  }
  if (starts.length < 2) return [];
  return starts.map((startFrame, index) => ({
    index,
    startFrame,
    endFrame: starts[index + 1] ?? grid.frames,
    seekMs: Math.max(0, Math.floor(uncutTime(frameMs(startFrame, grid), cuts) - PREROLL_MS)),
  }));
}
