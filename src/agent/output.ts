/**
 * What the node says while it runs: lines for people reading a terminal or `docker logs`, with a
 * mark for how each went, or one JSON object a line (`--log json`) for a log collector. Progress
 * rewrites its own line on a terminal and is said every tenth of the way elsewhere.
 */

export type LogFormat = 'pretty' | 'json';
type Level = 'info' | 'warn' | 'error' | 'debug';
type Fields = Record<string, unknown>;

const ESC = '\u001b[';
const STYLES = {
  dim: [2, 22],
  bold: [1, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  cyan: [36, 39],
} as const;
type Style = keyof typeof STYLES;

/** Where it writes, and how: separate so tests can read it. */
export type Sink = { write(text: string): void; isTTY?: boolean };

export class Output {
  private readonly format: LogFormat;
  private readonly sink: Sink;
  private readonly color: boolean;
  private readonly verbose: boolean;
  /** A progress line is on screen, not yet ended by a newline. */
  private open = false;
  /** The tenth of the way last said, where lines can't be rewritten. */
  private lastTenth = -1;

  constructor(options: {
    format: LogFormat;
    verbose?: boolean;
    sink?: Sink;
    /** Colours: on a terminal unless `NO_COLOR` says not. */
    color?: boolean;
  }) {
    this.format = options.format;
    this.sink = options.sink ?? process.stdout;
    this.verbose = options.verbose ?? false;
    this.color =
      options.color ??
      (this.format === 'pretty' &&
        Boolean(this.sink.isTTY) &&
        !process.env['NO_COLOR'] &&
        process.env['TERM'] !== 'dumb');
  }

  paint(style: Style, text: string): string {
    if (!this.color) return text;
    const [on, off] = STYLES[style];
    return `${ESC}${on}m${text}${ESC}${off}m`;
  }

  private line(level: Level, mark: string, message: string, fields: Fields): void {
    if (level === 'debug' && !this.verbose) return;
    if (this.format === 'json') {
      this.sink.write(
        `${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`,
      );
      return;
    }
    const detail = Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' ');
    const text = `${mark} ${message}${detail ? `  ${this.paint('dim', detail)}` : ''}`;
    this.endProgress();
    this.sink.write(`${text}\n`);
  }

  /** Something that went as it should. */
  ok(message: string, fields: Fields = {}): void {
    this.line('info', this.paint('green', '✓'), message, fields);
  }

  info(message: string, fields: Fields = {}): void {
    this.line('info', this.paint('cyan', '•'), message, fields);
  }

  warn(message: string, fields: Fields = {}): void {
    this.line('warn', this.paint('yellow', '!'), message, fields);
  }

  error(message: string, fields: Fields = {}): void {
    this.line('error', this.paint('red', '✗'), message, fields);
  }

  /** What only `--verbose` shows: the engine's own lines, each request. */
  debug(message: string, fields: Fields = {}): void {
    this.line('debug', this.paint('dim', '·'), message, fields);
  }

  /** A paragraph of help, as it is (pretty only). */
  say(text: string): void {
    if (this.format === 'json') return;
    this.endProgress();
    this.sink.write(`${text}\n`);
  }

  /**
   * How far a render is: on a terminal, one line rewritten as it moves; elsewhere a line every
   * tenth of the way, so `docker logs` stays readable.
   */
  progress(message: string, fraction: number, remainingMs: number | null): void {
    const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    const left = remainingMs === null ? '' : ` · ${duration(remainingMs)} left`;
    if (this.format === 'json' || !this.sink.isTTY) {
      const tenth = Math.floor(percent / 10);
      if (tenth === this.lastTenth) return;
      this.lastTenth = tenth;
      if (this.format === 'json') {
        this.line('info', '', message, { percent, remainingMs });
      } else {
        this.sink.write(`  ${message} ${percent}%${left}\n`);
      }
      return;
    }
    const width = 24;
    const filled = Math.round((percent / 100) * width);
    const bar = `${'█'.repeat(filled)}${this.paint('dim', '░'.repeat(width - filled))}`;
    this.sink.write(`\r${ESC}2K  ${message} ${bar} ${percent}%${left}`);
    this.open = true;
  }

  /** Ends a progress line on a terminal, so the next line starts on its own. */
  endProgress(): void {
    this.lastTenth = -1;
    if (!this.open) return;
    this.open = false;
    this.sink.write('\n');
  }
}

/** A duration as people say it: `45 s`, `12 min`, `1 h 5 min`. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** A size as people say it: `512 MB`, `1.2 GB`. */
export function size(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
