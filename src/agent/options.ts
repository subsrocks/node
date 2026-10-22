import { execFileSync } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { LogFormat } from './output.ts';

/**
 * The node's commands and what they're given, from flags or, for a container, the environment
 * (`SUBS_TOKEN` for `--token`). A flag wins over its variable.
 */

export const COMMANDS = ['start', 'doctor', 'status', 'remove', 'version', 'help'] as const;
export type Command = (typeof COMMANDS)[number];

export type GpuUse = 'auto' | 'off';

export type Options = {
  command: Command;
  /** subs.rocks, or another deployment of it (development's). */
  server: string;
  /** Where the node keeps its credential, its fonts and its work. */
  data: string;
  log: LogFormat;
  verbose: boolean;
  /** `start`'s: a registration token, the name to ask for, and whether to use a GPU. */
  token: string | null;
  name: string;
  gpu: GpuUse;
  /** The ffmpeg to render with (its ffprobe beside it), or null to find one (`tools.ts`). */
  ffmpeg: string | null;
};

export class UsageError extends Error {}

export const USAGE = `subs-node: render subs.rocks videos on this machine

Usage
  subs-node [start] --token <token>     join a workspace and wait for renders
  subs-node start                       wait for renders (once it has joined)
  subs-node doctor                      check this machine can render
  subs-node status                      say which workspace it renders for
  subs-node remove                      leave the workspace and forget it
  subs-node version

Options
  --token <token>   the registration token from Settings › Render machines (SUBS_TOKEN)
  --name <name>     what the workspace calls it; this machine's name if not given (SUBS_NAME)
  --gpu auto|off    encode on an NVIDIA GPU when there is one (SUBS_GPU, default auto)
  --ffmpeg <path>   the ffmpeg to render with, its ffprobe beside it (SUBS_FFMPEG); found if not
                    given: Homebrew's ffmpeg-full on a Mac, else the PATH's
  --url <url>       where subs.rocks is (SUBS_URL, default https://subs.rocks)
  --data <dir>      where it keeps its credential, fonts and work (SUBS_DATA)
  --log pretty|json how it writes its log (SUBS_LOG, default pretty)
  --verbose         say more, the engine's own lines too

Docs: https://subs.rocks/docs/machines
`;

/**
 * What a machine is called unless it's told: a Mac's own name (`Zach's MacBook Pro`), else its
 * host name without the `.local` a Mac's network adds; in a container, which knows only its own
 * id for a host name, `Docker` (the command Settings gives names it for the computer).
 */
export function defaultName(env: NodeJS.ProcessEnv, host = hostname()): string {
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync('scutil', ['--get', 'ComputerName'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
      }).trim();
      if (name) return name;
    } catch {
      // Not there: the host name, then.
    }
  }
  if (env['SUBS_CONTAINER'] === '1' && /^[0-9a-f]{12}$/.test(host)) return 'Docker';
  return host;
}

/** A name as the workspace keeps it: without a Mac network's `.local`, at most 60 characters. */
export function machineName(name: string): string {
  const trimmed = name.trim().replace(/\.local$/i, '');
  return trimmed === '' ? 'machine' : trimmed.slice(0, 60);
}

/** Where the node keeps its files: the image's volume, or a folder in the home directory. */
function defaultData(env: NodeJS.ProcessEnv): string {
  if (env['SUBS_CONTAINER'] === '1') return '/data';
  return join(homedir(), '.subs-node');
}

/** subs.rocks's address, checked: HTTPS, but for a development server on this machine. */
export function serverUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`--url isn't an address: ${value}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new UsageError(`--url must be https:// (http:// only for this machine): ${value}`);
  }
  return url.origin;
}

export function parseOptions(argv: readonly string[], env: NodeJS.ProcessEnv): Options {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) return { ...base(env), command: 'help' };
  if (values.version) return { ...base(env), command: 'version' };
  const [first = 'start', ...rest] = positionals;
  if (!(COMMANDS as readonly string[]).includes(first)) {
    throw new UsageError(`there's no command “${first}”`);
  }
  if (rest.length > 0) throw new UsageError(`unexpected: ${rest.join(' ')}`);
  const log = values.log ?? env['SUBS_LOG'] ?? 'pretty';
  if (log !== 'pretty' && log !== 'json') throw new UsageError('--log is pretty or json');
  const gpu = values.gpu ?? env['SUBS_GPU'] ?? 'auto';
  if (gpu !== 'auto' && gpu !== 'off') throw new UsageError('--gpu is auto or off');
  const name = machineName(values.name ?? env['SUBS_NAME'] ?? defaultName(env));
  return {
    command: first as Command,
    server: serverUrl(values.url ?? env['SUBS_URL'] ?? 'https://subs.rocks'),
    data: values.data ?? env['SUBS_DATA'] ?? defaultData(env),
    log,
    verbose: values.verbose ?? env['SUBS_VERBOSE'] === '1',
    token: values.token ?? env['SUBS_TOKEN'] ?? null,
    name,
    gpu,
    ffmpeg: values.ffmpeg ?? env['SUBS_FFMPEG'] ?? null,
  };
}

const OPTIONS = {
  token: { type: 'string' },
  name: { type: 'string' },
  gpu: { type: 'string' },
  ffmpeg: { type: 'string' },
  url: { type: 'string' },
  data: { type: 'string' },
  log: { type: 'string' },
  verbose: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

function base(env: NodeJS.ProcessEnv): Omit<Options, 'command'> {
  return {
    server: 'https://subs.rocks',
    data: defaultData(env),
    log: 'pretty',
    verbose: false,
    token: null,
    name: hostname(),
    gpu: 'auto',
    ffmpeg: null,
  };
}
