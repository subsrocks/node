import { describe, expect, it } from 'vitest';
import { EncodeProgress } from '../src/engine/render.ts';
import type { ProgressReport } from '../src/job.ts';

/** One `-progress` block, as ffmpeg 7.1 writes it, `doneMs` into the output. */
function block(doneMs: number | null): Buffer {
  const at = doneMs === null ? 'N/A' : String(doneMs * 1000);
  return Buffer.from(`frame=12\nfps=24.00\nout_time_us=${at}\nspeed=1.2x\nprogress=continue\n`);
}

function harness() {
  let now = 1_000_000;
  const written: ProgressReport[] = [];
  const progress = new EncodeProgress(
    60_000,
    async (value) => {
      written.push(value);
    },
    () => now,
  );
  return { progress, written, advance: (ms: number) => (now += ms) };
}

describe('encode progress', () => {
  it('writes the share of the output done every few seconds, with the time left once it can tell', async () => {
    const { progress, written, advance } = harness();
    progress.push(block(null));
    expect(written).toEqual([]);
    progress.push(block(500));
    await progress.settle();
    // The first block is written at once; too early to estimate.
    expect(written).toEqual([{ fraction: 500 / 60_000, remainingMs: null }]);

    advance(2_000);
    progress.push(block(3_000));
    await progress.settle();
    expect(written).toHaveLength(1);

    advance(4_000);
    progress.push(block(6_000));
    await progress.settle();
    // A tenth in 6 s: 54 s to go.
    expect(written.at(-1)).toEqual({ fraction: 0.1, remainingMs: 54_000 });
  });

  it('reads blocks split across chunks, and never counts past the end', async () => {
    const { progress, written } = harness();
    const bytes = block(75_000);
    progress.push(bytes.subarray(0, 25));
    progress.push(bytes.subarray(25));
    await progress.settle();
    expect(written.at(-1)?.fraction).toBe(1);
  });

  it('carries on when a write fails', async () => {
    let now = 0;
    let calls = 0;
    const progress = new EncodeProgress(
      10_000,
      async () => {
        calls += 1;
        throw new Error('storage is away');
      },
      () => now,
    );
    progress.push(block(1_000));
    await progress.settle();
    now += 6_000;
    progress.push(block(5_000));
    await progress.settle();
    expect(calls).toBe(2);
  });
});
