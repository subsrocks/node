import { JobError } from '../engine/errors.ts';
import { fetchVideo } from '../engine/fetch.ts';
import { renderInParallel } from '../engine/parallel.ts';
import { EngineError, FetchError, FetchJob, RenderJob } from '../job.ts';
import type { FromJob, ToJob } from './runner.ts';

/**
 * A job's own process (`__job`): reads its job from the node, runs the engine on it (a render, on
 * the machine's hardware and in pieces at once where the machine gains by it; a download, ADR
 * 0092), tells the node its progress and how it ended, and exits. The engine's settings (where the job's files are, the
 * token for them, where to work, the tools) come from the environment the node started it with.
 */
export async function jobProcess(): Promise<void> {
  const send = (message: FromJob) =>
    new Promise<void>((resolve) => {
      if (!process.send) resolve();
      else process.send(message, () => resolve());
    });
  const message = await new Promise<ToJob>((resolve) => {
    process.once('message', (value) => resolve(value as ToJob));
  });
  try {
    if (message.kind === 'fetch') {
      const job = FetchJob.parse(message.input);
      const dir = process.env['WORK_DIR'] ?? '.';
      const result = await fetchVideo(job, dir, (fraction) => {
        void send({ type: 'fetched', fraction });
      });
      await send({ type: 'done', result });
      process.disconnect?.();
      return;
    }
    const input = RenderJob.parse(message.input);
    const result = await renderInParallel(
      input,
      process.env['WORK_DIR'] ?? '.',
      {
        onProgress: (progress) => void send({ type: 'progress', ...progress }),
        onPieces: (plan) => void send({ type: 'pieces', ...plan }),
      },
      { ...(message.hardware ? { hardware: message.hardware } : {}), machine: message.budget },
    );
    await send({ type: 'done', result });
  } catch (error) {
    const failure =
      error instanceof JobError
        ? error
        : new JobError(
            'processing_failed',
            error instanceof Error ? error.message : String(error),
            true,
          );
    await send({
      type: 'failed',
      error: {
        code:
          (message.kind === 'fetch'
            ? FetchError.safeParse(failure.code).data
            : EngineError.safeParse(failure.code).data) ?? 'processing_failed',
        retryable: failure.retryable,
        detail: failure.message.slice(0, 2000),
      },
    });
  }
  process.disconnect?.();
}
