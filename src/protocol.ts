import { z } from 'zod';
import { JobFailure, RenderJob, RenderResult, VideoCodec } from './job.ts';

/**
 * How a node and subs.rocks talk. A node registers once with a token from its workspace's
 * settings, keeps the credential it's given, then holds a WebSocket open to subs.rocks, which
 * sends it renders one at a time. The node reads and writes a render's files over HTTPS with a
 * token for that render alone, and reports how it ended over the socket.
 *
 * Everything a node is told is here: a render's job names its files by the job's own names
 * (`original`, `subtitles.ass`), never by where subs.rocks keeps them, and carries nothing about
 * the project or the people in it.
 *
 *   POST {server}/api/nodes/register      RegisterNodeInput → RegisterNodeResult
 *   GET  {server}/api/nodes/self          the node as subs.rocks knows it (NodeSelf), or why not
 *   DELETE {server}/api/nodes/self        removes it from its workspace
 *   GET  {server}/api/nodes/connect       the WebSocket: NodeMessage up, ServerMessage down
 *   *    {server}/api/nodes/io/objects/{name}?token=…   a job's files (engine/io.ts)
 *   GET  {server}/fonts/built-in.json     the built-in fonts renders draw with (BuiltInFonts)
 *
 * Requests but `register` carry `Authorization: Bearer {secret}`; refusals answer as subs.rocks's
 * API does, `{ error: { code } }`, with the codes in `NODE_REFUSALS`.
 */

/** What this side speaks. A node speaking another is refused at connect (`NODE_OUTDATED`). */
export const NODE_PROTOCOL = 1;

/** Sent on every request, so subs.rocks can refuse a node that speaks another protocol. */
export const PROTOCOL_HEADER = 'X-Subs-Node-Protocol';

/** A node's name in its workspace: what people see in the list. */
export const NodeName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\p{Cc}]+$/u, { error: 'no_control_characters' });
export type NodeName = z.infer<typeof NodeName>;

/** A job as the node knows it: subs.rocks's name for it, opaque. */
export const JobRef = z.string().min(1).max(80);

/** What a machine can do, as it says itself (subs.rocks shows it, and sends work it can do). */
export const NodeMachine = z.object({
  /** `process.platform` and `process.arch`: `linux`, `darwin`; `x64`, `arm64`. */
  os: z.string().max(40),
  arch: z.string().max(20),
  /** Running in the published image rather than as a program on the machine itself. */
  container: z.boolean(),
  cpu: z.object({
    model: z.string().max(120),
    /** Threads it can run at once (`os.availableParallelism()`). */
    threads: z.number().int().positive().max(4096),
  }),
  memoryBytes: z.number().int().nonnegative(),
  /** Its NVIDIA GPUs, when there are any it can use. */
  gpus: z
    .array(
      z.object({
        name: z.string().max(120),
        memoryBytes: z.number().int().nonnegative().nullable(),
      }),
    )
    .max(16),
  /**
   * The codecs it encodes, on its CPU, and on its GPU (NVENC, each tried once at start). The GPU's
   * are empty when it has none, or was told not to use it (`--gpu off`).
   */
  encoders: z.object({
    cpu: z.array(VideoCodec).max(4),
    gpu: z.array(VideoCodec).max(4),
  }),
  /** Its ffmpeg's version, as `ffmpeg -version` says it. */
  ffmpeg: z.string().max(80),
  /** Free space where it works, when it said hello; null when it couldn't tell. */
  diskBytes: z.number().int().nonnegative().nullable(),
});
export type NodeMachine = z.infer<typeof NodeMachine>;

/** `POST /api/nodes/register`: a machine joins the workspace whose token it brings. */
export const RegisterNodeInput = z.strictObject({
  token: z.string().min(1).max(200),
  /** The name it asks for (its host name, or `--name`); taken, a number is added. */
  name: NodeName,
  version: z.string().min(1).max(40),
  machine: NodeMachine,
});
export type RegisterNodeInput = z.infer<typeof RegisterNodeInput>;

export const NodeIdentity = z.object({ id: z.string(), name: z.string() });
export type NodeIdentity = z.infer<typeof NodeIdentity>;

export const RegisterNodeResult = z.object({
  node: NodeIdentity,
  /** Its credential, given this once: the machine keeps it, subs.rocks only its hash. */
  secret: z.string(),
});
export type RegisterNodeResult = z.infer<typeof RegisterNodeResult>;

/** `GET /api/nodes/self`: the node, and the newest version there is. */
export const NodeSelf = z.object({
  node: NodeIdentity,
  /** The newest version of the node, for a nudge to update. */
  latest: z.string(),
});
export type NodeSelf = z.infer<typeof NodeSelf>;

/**
 * Why subs.rocks refuses a node, as the `code` of a refusal: its registration token is wrong or
 * expired; its credential is unknown (it was removed); its workspace's plan has no machines of its
 * own, or it has as many as it may, or it's suspended; or the node speaks an older protocol.
 */
export const NODE_REFUSALS = [
  'NODE_TOKEN_INVALID',
  'NODE_INVALID',
  'NODES_NOT_ON_PLAN',
  'NODES_FULL',
  'WORKSPACE_SUSPENDED',
  'NODE_OUTDATED',
] as const;
export type NodeRefusal = (typeof NODE_REFUSALS)[number];

/** How a job ended on the node: made, failed, or given back unfinished when the node stopped. */
export const NodeJobOutcome = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('done'),
    ms: z.number().nonnegative(),
    result: RenderResult,
  }),
  z.strictObject({
    state: z.literal('failed'),
    ms: z.number().nonnegative(),
    error: JobFailure,
  }),
  z.strictObject({ state: z.literal('released'), ms: z.number().nonnegative() }),
]);
export type NodeJobOutcome = z.infer<typeof NodeJobOutcome>;

/**
 * What a node says, as JSON text frames. Beside them, `ping` (plain text) every so often, which
 * subs.rocks answers `pong`: a connection that stops answering is a dead one.
 */
export const NodeMessage = z.discriminatedUnion('type', [
  /** First, on every connection: what it is and can do, and the job it's still carrying out. */
  z.strictObject({
    type: z.literal('hello'),
    protocol: z.number().int(),
    /** The jobs its engine understands (`ENGINE_VERSION`). */
    engine: z.number().int(),
    version: z.string().max(40),
    machine: NodeMachine,
    job: JobRef.nullable(),
    /** It takes no new job: it's stopping once its job is done. */
    draining: z.boolean(),
  }),
  /** It took a job it was sent and is working on it. */
  z.strictObject({ type: z.literal('started'), job: JobRef }),
  /** A job ended; said again until subs.rocks acknowledges it (`ack`). */
  z.strictObject({ type: z.literal('ended'), job: JobRef, outcome: NodeJobOutcome }),
  /** It takes no new job from now on. */
  z.strictObject({ type: z.literal('draining') }),
]);
export type NodeMessage = z.infer<typeof NodeMessage>;

/** A render for the node: its job, and the token its files are read and written with. */
export const NodeJob = z.object({
  id: JobRef,
  kind: z.literal('render'),
  input: RenderJob,
  /** For this job's files only, while it's this node's (`?token=` on `/api/nodes/io`). */
  token: z.string().min(1).max(300),
});
export type NodeJob = z.infer<typeof NodeJob>;

/** What subs.rocks says, as JSON text frames. */
export const ServerMessage = z.discriminatedUnion('type', [
  /** After its hello: who it is, and the newest version there is. */
  z.object({ type: z.literal('welcome'), node: NodeIdentity, latest: z.string() }),
  /** A job to do, when it's free. */
  z.object({ type: z.literal('job'), job: NodeJob }),
  /** Stop a job: someone stopped the render, or it's no longer this node's. */
  z.object({ type: z.literal('cancel'), job: JobRef }),
  /** Its `ended` for a job was heard. */
  z.object({ type: z.literal('ack'), job: JobRef }),
  /** Its workspace renamed it. */
  z.object({ type: z.literal('renamed'), name: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** Plain-text frames that keep the connection known alive, answered without waking anything. */
export const PING = 'ping';
export const PONG = 'pong';

/**
 * Why subs.rocks closed a connection (WebSocket close codes): the node was removed from its
 * workspace, its plan stopped including machines of its own, it connected again elsewhere, its
 * workspace was suspended, or it said something that didn't read.
 */
export const NODE_CLOSE = {
  removed: 4001,
  plan: 4002,
  replaced: 4004,
  suspended: 4005,
  invalid: 4006,
} as const;

/** `GET /fonts/built-in.json`: the fonts renders draw with when a template brings none. */
export const BuiltInFonts = z.object({
  fonts: z.array(
    z.object({
      /** The file's name in the fonts folder. */
      file: z.string().regex(/^[\w.-]+$/),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      bytes: z.number().int().positive(),
      /** Where to download it, on subs.rocks. */
      url: z.string(),
    }),
  ),
});
export type BuiltInFonts = z.infer<typeof BuiltInFonts>;
