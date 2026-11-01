import type { Hardware } from '../engine/hardware.ts';
import type { MachineBudget } from '../engine/parallel.ts';
import { ENGINE_VERSION, type RenderJob, type RenderStage } from '../job.ts';
import {
  NODE_CLOSE,
  NODE_PROTOCOL,
  type NodeJob,
  type NodeJobOutcome,
  type NodeMachine,
  type NodeMessage,
  NodeSelf,
  PING,
  PONG,
  ServerMessage,
} from '../protocol.ts';
import { NODE_VERSION } from '../version.ts';
import { call, headers, Refused, Unreachable } from './api.ts';
import { duration, type Output, size } from './output.ts';
import { type RunningJob, startJob } from './runner.ts';
import type { Credential, Pending, Store } from './store.ts';
import type { Tools } from './tools.ts';
import type { Downloader } from './ytdlp.ts';

/**
 * The node at work: connected to subs.rocks, it takes renders one at a time, and (with a
 * downloader) downloads of linked videos one at a time beside them (ADR 0092); says how each
 * ended until subs.rocks acknowledges it, and connects again when the connection drops (a deploy
 * drops them all) without stopping a job under way. It ends when it's removed from its workspace,
 * when another copy of it connects, or when it's told to stop.
 */

/** What a render is doing, as its progress line says it. */
const STAGE_WORDS: Record<RenderStage, string> = {
  preparing: 'Copying the video',
  encoding: 'Rendering',
  joining: 'Joining',
  saving: 'Uploading',
};

/** How often it pings, and how long without a pong before it takes the connection for dead. */
const PING_EVERY_MS = 20_000;
const DEAD_AFTER_MS = 50_000;
/** Waits between tries to connect: doubling from a second to a minute, with jitter. */
const FIRST_WAIT_MS = 1_000;
const LONGEST_WAIT_MS = 60_000;
/** While its plan has no machines of its own, or its workspace is suspended: asks again hourly. */
const PARKED_WAIT_MS = 60 * 60_000;

export type SessionEnd =
  /** Stopped as asked, its render finished or given back. */
  | 'stopped'
  /** Removed from its workspace: its credential is forgotten. */
  | 'removed'
  /** Another copy of it connected: two machines share one data folder. */
  | 'replaced'
  /** subs.rocks no longer speaks its protocol: it needs an update. */
  | 'outdated';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** `1.2.10` after `1.2.9`: whether `a` is newer than `b`. */
export function newer(a: string, b: string): boolean {
  const parts = (version: string) => version.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const [p = 0, q = 0] = [x[i], y[i]];
    if (Number.isNaN(p) || Number.isNaN(q)) return false;
    if (p !== q) return p > q;
  }
  return false;
}

/**
 * A render's job in a few words: `12:04 at 3840×2160 → H.265 on the GPU` (`on`, where this
 * machine's hardware encodes: the GPU, or a Mac's media engine).
 */
export function jobLine(input: RenderJob, on = 'the GPU'): string {
  const total = Math.round(input.durationMs / 1000);
  const length = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  const settings = input.settings;
  const frame = settings?.size ? `${settings.size.width}×${settings.size.height}` : 'its own size';
  const codec = { h264: 'H.264', hevc: 'H.265', av1: 'AV1', prores: 'ProRes' }[
    settings?.codec ?? 'h264'
  ];
  return `${length} at ${frame} → ${codec}${input.encoder === 'gpu' ? ` on ${on}` : ''}`;
}

export class Session {
  private readonly server: string;
  private readonly credential: Credential;
  private readonly store: Store;
  private readonly log: Output;
  private readonly machine: NodeMachine;
  private readonly tools: Tools;
  /** Its video hardware, and what it may use, which each render is told. */
  private readonly hardware: Hardware | null;
  private readonly budget: MachineBudget;
  /** The downloader its downloads run, when it takes them (`ytdlp.ts`). */
  private readonly downloader: Downloader | null;
  /** Its downloads may sign in with the workspace's cookies (`--cookies`). */
  private readonly signsIn: boolean;
  private socket: WebSocket | null = null;
  /** The render it's making, and the download beside it. */
  private job: RunningJob | null = null;
  private fetching: RunningJob | null = null;
  /** Jobs someone stopped: their ends aren't reported. */
  private readonly cancelled = new Set<string>();
  /** Jobs' ends said but not yet heard. */
  private pending: Pending[] = [];
  private draining = false;
  private ended: SessionEnd | null = null;
  private readonly wake = new AbortController();
  /** Said once a streak, not on every try. */
  private unreachableSaid = false;
  private updateSaid = false;
  private connectedOnce = false;
  /** The connection now was welcomed. */
  private welcomed = false;

  constructor(context: {
    server: string;
    credential: Credential;
    store: Store;
    log: Output;
    machine: NodeMachine;
    tools: Tools;
    hardware: Hardware | null;
    downloader?: Downloader | null;
    cookies?: boolean;
  }) {
    this.server = context.server;
    this.credential = context.credential;
    this.store = context.store;
    this.log = context.log;
    this.machine = context.machine;
    this.tools = context.tools;
    this.hardware = context.hardware;
    this.downloader = context.downloader ?? null;
    this.signsIn = context.cookies ?? true;
    this.budget = {
      threads: context.machine.cpu.threads,
      memoryBytes: context.machine.memoryBytes,
    };
  }

  /** Runs until the node should stop, and says why. */
  async run(): Promise<SessionEnd> {
    this.pending = await this.store.pending();
    let wait = FIRST_WAIT_MS;
    while (!this.ended) {
      try {
        const self = await call(
          this.server,
          '/api/nodes/self',
          { secret: this.credential.secret },
          NodeSelf,
        );
        this.unreachableSaid = false;
        this.nudge(self.latest);
        const { code, welcomed } = await this.connect();
        if (this.ended) break;
        if (code === NODE_CLOSE.removed) return this.finish('removed');
        if (code === NODE_CLOSE.replaced) return this.finish('replaced');
        if (code === NODE_CLOSE.plan || code === NODE_CLOSE.suspended) {
          await this.park(code === NODE_CLOSE.plan ? 'NODES_NOT_ON_PLAN' : 'WORKSPACE_SUSPENDED');
          continue;
        }
        if (this.draining && !this.busy) return this.finish('stopped');
        // It was connected and welcomed: the waits start over.
        if (welcomed) wait = FIRST_WAIT_MS;
      } catch (error) {
        if (error instanceof Refused) {
          if (error.code === 'NODE_INVALID') return this.finish('removed');
          if (error.code === 'NODE_OUTDATED') return this.finish('outdated');
          if (error.code === 'NODES_NOT_ON_PLAN' || error.code === 'WORKSPACE_SUSPENDED') {
            await this.park(error.code);
            continue;
          }
          this.log.warn(`subs.rocks refused it (${error.code}); trying again`);
        } else if (!this.unreachableSaid) {
          this.unreachableSaid = true;
          const reason = error instanceof Unreachable ? error.message : String(error);
          this.log.warn(`Can't reach subs.rocks: ${reason}. Trying again…`);
        }
      }
      if (this.ended) break;
      await sleep(wait * (0.75 + Math.random() / 2), this.wake.signal);
      wait = Math.min(LONGEST_WAIT_MS, wait * 2);
    }
    return this.ended ?? 'stopped';
  }

  private finish(end: SessionEnd): SessionEnd {
    this.ended = end;
    this.job?.stop('release');
    this.fetching?.stop('release');
    return end;
  }

  /** The job of a kind it's on, or whose end it's still to say. */
  private holding(kind: 'render' | 'fetch'): string | null {
    const running = kind === 'fetch' ? this.fetching : this.job;
    return running?.id ?? this.pending.find((each) => each.kind === kind)?.job ?? null;
  }

  /** Waits an hour while its plan or workspace keeps it from rendering, saying why once. */
  private async park(code: 'NODES_NOT_ON_PLAN' | 'WORKSPACE_SUSPENDED'): Promise<void> {
    this.log.warn(
      code === 'NODES_NOT_ON_PLAN'
        ? "The workspace's plan doesn't include machines of its own. Waiting until it does…"
        : 'The workspace is suspended. Waiting until it isn’t…',
    );
    await sleep(PARKED_WAIT_MS, this.wake.signal);
  }

  /** A nudge to update, once a run, when a newer version is out. */
  private nudge(latest: string): void {
    if (this.updateSaid || !newer(latest, NODE_VERSION)) return;
    this.updateSaid = true;
    this.log.info(`Version ${latest} is out (this is ${NODE_VERSION}): update when it suits you`, {
      docs: 'https://subs.rocks/docs/machines#updating',
    });
  }

  private send(message: NodeMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  /** One connection, until it closes: its close code, and whether subs.rocks welcomed it. */
  private connect(): Promise<{ code: number; welcomed: boolean }> {
    const url = `${this.server.replace(/^http/, 'ws')}/api/nodes/connect`;
    this.welcomed = false;
    return new Promise((resolve) => {
      const socket = new WebSocket(url, {
        headers: headers(this.credential.secret),
      } as unknown as string[]);
      this.socket = socket;
      let lastPong = Date.now();
      let done = false;
      const end = (code: number) => {
        if (done) return;
        done = true;
        clearInterval(heartbeat);
        this.wake.signal.removeEventListener('abort', onWake);
        if (this.socket === socket) this.socket = null;
        resolve({ code, welcomed: this.welcomed });
      };
      const heartbeat = setInterval(() => {
        if (Date.now() - lastPong > DEAD_AFTER_MS) {
          this.log.warn('The connection went quiet; connecting again');
          socket.close();
          end(1006);
          return;
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(PING);
      }, PING_EVERY_MS);
      const onWake = () => {
        socket.close(1000);
        end(1000);
      };
      this.wake.signal.addEventListener('abort', onWake);
      socket.addEventListener('open', () => {
        lastPong = Date.now();
        this.send({
          type: 'hello',
          protocol: NODE_PROTOCOL,
          engine: ENGINE_VERSION,
          version: NODE_VERSION,
          machine: this.machine,
          job: this.holding('render'),
          takes: this.downloader ? ['render', 'fetch'] : ['render'],
          signsIn: this.signsIn,
          fetching: this.holding('fetch'),
          draining: this.draining,
        });
      });
      socket.addEventListener('message', (event) => {
        lastPong = Date.now();
        if (typeof event.data !== 'string' || event.data === PONG) return;
        let raw: unknown;
        try {
          raw = JSON.parse(event.data);
        } catch {
          return;
        }
        this.receive(raw);
      });
      socket.addEventListener('close', (event) => end(event.code));
      socket.addEventListener('error', () => {
        // A close follows; a refused upgrade closes with 1006.
      });
    });
  }

  private receive(raw: unknown): void {
    const read = ServerMessage.safeParse(raw);
    if (!read.success) {
      // A job that doesn't read is said so, so it goes to a machine whose engine reads it.
      const job = (raw as { type?: unknown; job?: { id?: unknown } } | null)?.job?.id;
      if ((raw as { type?: unknown } | null)?.type === 'job' && typeof job === 'string') {
        this.log.error("Got a render this version can't read: update this node");
        this.send({
          type: 'ended',
          job,
          outcome: {
            state: 'failed',
            ms: 0,
            error: {
              code: 'processing_failed',
              retryable: false,
              detail: `the job doesn't read on node ${NODE_VERSION}`,
            },
          },
        });
      }
      return;
    }
    const message = read.data;
    switch (message.type) {
      case 'welcome':
        this.welcomed = true;
        if (!this.connectedOnce) {
          this.log.ok(`Connected to ${new URL(this.server).host} as “${message.node.name}”`);
          this.log.info(
            this.draining ? 'Finishing its render, then stopping' : 'Waiting for renders',
          );
        } else {
          this.log.ok('Connected again');
        }
        this.connectedOnce = true;
        this.nudge(message.latest);
        for (const { job, outcome } of this.pending) this.send({ type: 'ended', job, outcome });
        return;
      case 'job':
        this.take(message.job);
        return;
      case 'cancel':
        for (const running of [this.job, this.fetching]) {
          if (running?.id !== message.job) continue;
          this.cancelled.add(message.job);
          running.stop('cancel');
          this.log.warn(
            running === this.job
              ? 'The render was stopped on subs.rocks'
              : 'The download was stopped on subs.rocks',
          );
        }
        void this.heard(message.job);
        return;
      case 'ack':
        void this.heard(message.job);
        return;
      case 'renamed':
        this.log.info(`Renamed “${message.name}”`);
        void this.store.saveCredential({ ...this.credential, name: message.name });
        return;
    }
  }

  /** Its jobs' ends not yet heard, kept on disk too. */
  private async settle(pending: Pending[]): Promise<void> {
    this.pending = pending;
    await this.store.setPending(pending).catch((error: unknown) => {
      this.log.warn(`Couldn't keep a job's end on disk: ${String(error)}`);
    });
  }

  /** subs.rocks heard a job's end (or stopped it): no need to say it again. */
  private async heard(id: string): Promise<void> {
    if (!this.pending.some((each) => each.job === id)) return;
    await this.settle(this.pending.filter((each) => each.job !== id));
  }

  /**
   * A job it was sent: taken when its slot is free (a render's, or a download's beside it), else
   * given straight back. One someone stopped is free already: its process is being killed, and
   * the new job works in a folder of its own. A download it can't make (no downloader, or turned
   * off) is given back too.
   */
  private take(job: NodeJob): void {
    const fetch = job.kind === 'fetch';
    const slot = fetch ? this.fetching : this.job;
    const busy = slot !== null && !this.cancelled.has(slot.id);
    if (busy || this.draining || this.ended || (fetch && !this.downloader)) {
      this.send({ type: 'ended', job: job.id, outcome: { state: 'released', ms: 0 } });
      return;
    }
    if (job.kind === 'fetch') {
      // Its site, not its address: the log says where it's from, not what.
      const site = (() => {
        try {
          return new URL(job.input.url).hostname.replace(/^www\./, '');
        } catch {
          return 'its site';
        }
      })();
      this.log.info(`Downloading a video from ${site}`);
    } else {
      const line = jobLine(
        job.input,
        this.hardware?.kind === 'videotoolbox' ? 'the media engine' : 'the GPU',
      );
      this.log.info(`Rendering ${line}`);
    }
    let shown: RenderStage | null = null;
    // Told not to sign in, it doesn't, whatever it's offered.
    const given =
      job.kind === 'fetch' && !this.signsIn
        ? { ...job, input: { ...job.input, cookies: null, cookiesFile: undefined } }
        : job;
    const running = startJob(given, {
      server: this.server,
      store: this.store,
      log: this.log,
      tools: this.tools,
      hardware: this.hardware,
      budget: this.budget,
      downloader: this.downloader,
      onProgress: ({ stage, fraction, remainingMs }) => {
        // Each stage on a line of its own.
        if (stage !== shown) this.log.endProgress();
        shown = stage;
        this.log.progress(STAGE_WORDS[stage], fraction, remainingMs);
      },
    });
    if (fetch) this.fetching = running;
    else this.job = running;
    this.send({ type: 'started', job: job.id });
    void running.ended.then((outcome) => this.done(job.id, job.kind, outcome));
  }

  private async done(id: string, kind: NodeJob['kind'], outcome: NodeJobOutcome): Promise<void> {
    // A stopped job ends after the next has started: only its own end clears it.
    if (kind === 'render' && this.job?.id === id) this.job = null;
    if (kind === 'fetch' && this.fetching?.id === id) this.fetching = null;
    if (kind === 'render') this.log.endProgress();
    const what = kind === 'fetch' ? 'download' : 'render';
    if (this.cancelled.has(id)) {
      this.cancelled.delete(id);
    } else {
      if (outcome.state === 'done') {
        const { output } = outcome.result;
        this.log.ok(
          `${kind === 'fetch' ? 'Downloaded' : 'Rendered'} in ${duration(outcome.ms)} · ${size(output.bytes)}`,
        );
      } else if (outcome.state === 'failed') {
        this.log.error(`The ${what} failed: ${outcome.error.detail.split('\n').at(-1)}`, {
          retry: outcome.error.retryable ? 'subs.rocks tries it again' : 'no',
        });
      } else {
        this.log.info(`Gave the ${what} back, for another machine`);
      }
      await this.settle([
        ...this.pending.filter((each) => each.job !== id),
        { job: id, kind, outcome },
      ]);
      this.send({ type: 'ended', job: id, outcome });
    }
    if ((this.draining || this.ended) && !this.busy) {
      // Its ends said (or kept to say next time): it can go.
      await sleep(this.pending.length > 0 ? 2_000 : 0);
      if (!this.ended) this.ended = 'stopped';
      this.wake.abort();
    }
  }

  /**
   * Stops: at once (`now`), giving its jobs back for another machine; or once they're done,
   * taking no other meanwhile.
   */
  stop(now: boolean): void {
    if (!this.busy) {
      this.ended = this.ended ?? 'stopped';
      this.wake.abort();
      return;
    }
    if (now) {
      this.draining = true;
      this.job?.stop('release');
      this.fetching?.stop('release');
      return;
    }
    if (this.draining) return;
    this.draining = true;
    this.send({ type: 'draining' });
  }

  /** Whether it's busy with a render or a download, for a stop asked for twice. */
  get busy(): boolean {
    return this.job !== null || this.fetching !== null;
  }
}
