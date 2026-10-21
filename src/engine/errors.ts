import type { EngineError } from '../job.ts';

/**
 * A job that failed, with a code its caller shows people and whether trying again may help
 * (`retryable: false` stops a run). The engine raises `EngineError`s; subs.rocks's own runner
 * raises its ingest jobs' codes too.
 */
export class JobError<Code extends string = EngineError> extends Error {
  readonly code: Code;
  readonly retryable: boolean;

  constructor(code: Code, detail: string, retryable = false) {
    super(detail);
    this.name = 'JobError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** ffmpeg's words for "this file is broken" versus everything else. */
export function classifyFfmpegFailure(stderr: string): JobError {
  const text = stderr.toLowerCase();
  if (
    text.includes('invalid data found when processing input') ||
    text.includes('moov atom not found') ||
    text.includes('ebml header parsing failed') ||
    text.includes('could not find codec parameters')
  ) {
    return new JobError('corrupt_media', stderr.slice(-2000));
  }
  if (text.includes('decoder') && text.includes('not found')) {
    return new JobError('unsupported_media', stderr.slice(-2000));
  }
  // Network hiccups reading from storage, out-of-memory kills, and the rest: try again.
  return new JobError('processing_failed', stderr.slice(-2000), true);
}
