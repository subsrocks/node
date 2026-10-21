import { spawn } from 'node:child_process';
import { config } from './config.ts';
import { classifyFfmpegFailure } from './errors.ts';

/** Keeps the last bytes of a chatty stream, so stderr can't exhaust memory. */
class Tail {
  private text = '';
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  push(chunk: Buffer) {
    this.text = (this.text + chunk.toString('utf8')).slice(-this.limit);
  }
  toString() {
    return this.text;
  }
}

export type RunOptions = {
  /** Receives stdout chunks (e.g. PCM for peaks); otherwise stdout is collected. */
  onStdout?: (chunk: Buffer) => void;
  /** Receives every stderr chunk too (e.g. `silencedetect` lines), beyond the kept tail. */
  onStderr?: (chunk: Buffer) => void;
  signal?: AbortSignal;
  /** Where the tool runs, so filters can name files relatively (no escaping of paths). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

/** Runs ffmpeg or ffprobe; rejects with a classified `JobError` on a non-zero exit. */
export function run(
  tool: 'ffmpeg' | 'ffprobe',
  args: string[],
  options: RunOptions = {},
): Promise<string> {
  const bin = tool === 'ffmpeg' ? config.ffmpeg : config.ffprobe;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    const stderr = new Tail(16 * 1024);
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      if (options.onStdout) options.onStdout(chunk);
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      options.onStderr?.(chunk);
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
      else reject(classifyFfmpegFailure(stderr.toString() || `${tool} exited with ${code}`));
    });
  });
}

/** Common input flags: fail fast on stalled network reads from storage. */
export const NETWORK_INPUT = ['-rw_timeout', '60000000'];

/** Seconds with millisecond precision, as ffmpeg's `-t` wants. */
export function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}
