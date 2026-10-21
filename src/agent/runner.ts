import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isSea } from 'node:sea';
import { EngineError, type JobFailure, type ProgressReport, RenderResult } from '../job.ts';
import type { NodeJob, NodeJobOutcome } from '../protocol.ts';
import { syncFonts } from './fonts.ts';
import type { Output } from './output.ts';
import type { Store } from './store.ts';

/**
 * A render on this machine: the built-in fonts made current, then the engine in a process of its
 * own (this program again, `__job`), told where the job's files are and the token for them, and
 * nothing else of the node's (its credential stays here). Stopping it kills that process and every
 * ffmpeg under it. Its folder is removed when it ends, however it ends.
 */

/** What the job's process says (`job-process.ts`). */
export type FromJob =
  | ({ type: 'progress' } & ProgressReport)
  | { type: 'done'; result: unknown }
  | { type: 'failed'; error: JobFailure };

/** What it's told: the job, its files named as the job names them. */
export type ToJob = { kind: 'render'; input: unknown };

export type RunningJob = {
  readonly id: string;
  /** How it ended; never rejects. */
  readonly ended: Promise<NodeJobOutcome>;
  /** Stops it at once; it ends `released` (given back) or as `stopped` says. */
  stop(how: 'release' | 'cancel'): void;
};

/** This program, as a command that runs another of its commands. */
function self(command: string): { file: string; args: string[] } {
  if (isSea()) return { file: process.execPath, args: [command] };
  const entry = process.argv[1];
  if (!entry) throw new Error('no entry point to start a job from');
  return { file: process.execPath, args: [...process.execArgv, entry, command] };
}

function failed(detail: string, retryable: boolean, started: number): NodeJobOutcome {
  return {
    state: 'failed',
    ms: Date.now() - started,
    error: { code: 'processing_failed', retryable, detail: detail.slice(0, 2000) },
  };
}

/** A safe folder name for a job, whatever subs.rocks calls it. */
const folderOf = (id: string) => id.replace(/[^\w-]/g, '_').slice(0, 80);

export function startJob(
  job: NodeJob,
  context: {
    server: string;
    store: Store;
    log: Output;
    onProgress: (progress: ProgressReport) => void;
    /** How it starts a job's process: this program again (`__job`), unless told otherwise. */
    command?: { file: string; args: string[] };
  },
): RunningJob {
  const { server, store, log } = context;
  const started = Date.now();
  let child: ChildProcess | null = null;
  let stopped: 'release' | 'cancel' | null = null;

  const kill = () => {
    const pid = child?.pid;
    if (!pid || child?.exitCode !== null) return;
    try {
      // Its own process group: the engine and every ffmpeg it started.
      process.kill(-pid, 'SIGKILL');
    } catch {
      child?.kill('SIGKILL');
    }
  };

  const run = async (): Promise<NodeJobOutcome> => {
    try {
      const downloaded = await syncFonts(server, store.fontsDir);
      if (downloaded > 0) log.info(`Downloaded ${downloaded} built-in fonts`);
    } catch (error) {
      return failed(`the built-in fonts didn't download: ${String(error)}`, true, started);
    }
    if (stopped) return { state: 'released', ms: Date.now() - started };
    const workDir = join(store.workDir, folderOf(job.id));
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });
    try {
      return await new Promise<NodeJobOutcome>((resolve) => {
        const command = context.command ?? self('__job');
        const process_ = spawn(command.file, command.args, {
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: {
            ...process.env,
            // Where the engine reads and writes the job's files, and with what: this job's token.
            MEDIA_IO_ORIGIN: `${server}/api/nodes/io`,
            MEDIA_IO_TOKEN: job.token,
            WORK_DIR: workDir,
            FONTS_DIR: store.fontsDir,
            // Nothing of the node's own that the job doesn't need.
            SUBS_TOKEN: '',
          },
        });
        child = process_;
        let outcome: NodeJobOutcome | null = null;
        for (const stream of [process_.stdout, process_.stderr]) {
          if (!stream) continue;
          createInterface({ input: stream }).on('line', (line) => log.debug(line));
        }
        process_.on('message', (raw: FromJob) => {
          if (raw.type === 'progress') {
            context.onProgress({ fraction: raw.fraction, remainingMs: raw.remainingMs });
          } else if (raw.type === 'done') {
            const result = RenderResult.safeParse(raw.result);
            outcome = result.success
              ? { state: 'done', ms: Date.now() - started, result: result.data }
              : failed("the engine's result didn't read", true, started);
          } else if (raw.type === 'failed') {
            const code = EngineError.safeParse(raw.error.code).data ?? 'processing_failed';
            outcome = {
              state: 'failed',
              ms: Date.now() - started,
              error: { ...raw.error, code, detail: raw.error.detail.slice(0, 2000) },
            };
          }
        });
        process_.on('error', (error) => {
          resolve(failed(`the render didn't start: ${error.message}`, true, started));
        });
        process_.on('exit', (code, signal) => {
          if (stopped === 'release') resolve({ state: 'released', ms: Date.now() - started });
          else if (stopped === 'cancel') resolve(failed('stopped', false, started));
          else if (outcome) resolve(outcome);
          else {
            const how = signal ? `was killed (${signal})` : `exited with ${code}`;
            resolve(failed(`the render's process ${how}`, true, started));
          }
        });
        const message: ToJob = { kind: job.kind, input: job.input };
        process_.send(message);
        if (stopped) kill();
      });
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const ended = run().catch((error: unknown) => failed(String(error), true, started));
  return {
    id: job.id,
    ended,
    stop(how) {
      if (stopped) return;
      stopped = how;
      kill();
    },
  };
}
