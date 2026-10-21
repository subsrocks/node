import { defineConfig } from 'vitest/config';

/**
 * The engine's tests run ffmpeg on real media: a few seconds each on a quiet machine, more on a
 * busy CI runner. 30 s leaves room without hiding a hang.
 */
export default defineConfig({
  test: { testTimeout: 30_000 },
});
