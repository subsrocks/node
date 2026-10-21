#!/usr/bin/env node
import { access, constants } from 'node:fs/promises';
import { ENGINE_VERSION } from '../job.ts';
import { NODE_PROTOCOL, NodeSelf, RegisterNodeResult } from '../protocol.ts';
import { NODE_VERSION } from '../version.ts';
import { call, Refused, Unreachable } from './api.ts';
import { jobProcess } from './job-process.ts';
import { describeMachine, encodersLine, machineLine } from './machine.ts';
import { type Options, parseOptions, USAGE, UsageError } from './options.ts';
import { Output, size } from './output.ts';
import { Session } from './session.ts';
import { type Credential, Store } from './store.ts';

/**
 * `subs-node`: a machine of a workspace's own that renders its videos. `start` joins the
 * workspace with a registration token the first time, then waits for renders; the rest look
 * after it. See USAGE, and https://subs.rocks/docs/machines.
 */

const TOOLS = {
  ffmpeg: process.env['FFMPEG'] ?? 'ffmpeg',
  ffprobe: process.env['FFPROBE'] ?? 'ffprobe',
};

/** What each refusal means to the person reading the log, and what to do. */
const REFUSED: Record<string, string> = {
  NODE_TOKEN_INVALID:
    'That registration token is wrong or has expired (they last an hour). Get a new one in Settings › Your machines.',
  NODE_INVALID:
    'This machine was removed from its workspace. To render for it again, add it again in Settings › Your machines.',
  NODES_NOT_ON_PLAN:
    "The workspace's plan doesn't include machines of its own: they come with the Team and Studio plans.",
  NODES_FULL:
    'The workspace has as many machines as it may. Remove one in Settings › Your machines.',
  WORKSPACE_SUSPENDED: 'The workspace is suspended.',
  NODE_OUTDATED: `subs.rocks needs a newer version of this node than ${NODE_VERSION}. Update it: https://subs.rocks/docs/machines#updating`,
  RATE_LIMITED: 'Too many tries: wait a minute and try again.',
};

function explain(error: unknown): string {
  if (error instanceof Refused) return REFUSED[error.code] ?? `subs.rocks refused: ${error.code}`;
  if (error instanceof Unreachable) return error.message;
  return error instanceof Error ? error.message : String(error);
}

async function machineOf(options: Options, store: Store, log: Output) {
  const described = await describeMachine({ tools: TOOLS, gpu: options.gpu, workDir: store.dir });
  for (const problem of described.problems) log.error(problem);
  if (described.problems.length > 0) {
    log.say('\nRun `subs-node doctor` for more, or see https://subs.rocks/docs/machines');
    return null;
  }
  const { machine } = described;
  log.ok(`ffmpeg ${machine.ffmpeg} · ${encodersLine(machine)}`);
  log.ok(machineLine(machine));
  for (const note of described.notes) log.info(note);
  return machine;
}

async function start(options: Options, log: Output): Promise<number> {
  log.say(log.paint('bold', `subs.rocks node ${NODE_VERSION}`));
  const store = new Store(options.data);
  try {
    await store.prepare();
  } catch (error) {
    log.error(`Can't write to its data folder ${options.data}: ${explain(error)}`);
    return 1;
  }
  const machine = await machineOf(options, store, log);
  if (!machine) return 1;
  let credential = await store.credential();
  if (credential && credential.server !== options.server) {
    log.error(
      `This data folder belongs to a node of ${credential.server}, not ${options.server}. Use another --data, or \`subs-node remove\` first.`,
    );
    return 1;
  }
  if (!credential) {
    if (!options.token) {
      log.error('This machine hasn’t joined a workspace yet: start it with --token (SUBS_TOKEN).');
      log.say('Get a token in Settings › Your machines on subs.rocks.');
      return 1;
    }
    try {
      const joined = await call(
        options.server,
        '/api/nodes/register',
        {
          method: 'POST',
          body: { token: options.token, name: options.name, version: NODE_VERSION, machine },
        },
        RegisterNodeResult,
      );
      credential = {
        server: options.server,
        id: joined.node.id,
        name: joined.node.name,
        secret: joined.secret,
      };
      await store.saveCredential(credential);
      log.ok(`Joined the workspace as “${joined.node.name}”`);
    } catch (error) {
      log.error(explain(error));
      return 1;
    }
  }
  const session = new Session({ server: options.server, credential, store, log, machine });
  let asked = 0;
  const stop = (signal: NodeJS.Signals) => {
    asked += 1;
    // Ctrl-C finishes the render under way first; again, or a TERM (a container stopping), gives
    // it back at once for another machine.
    const now = signal === 'SIGTERM' || asked > 1;
    if (session.busy && !now) {
      log.warn(
        'Finishing this render, then stopping. Ctrl-C again stops now (it goes to another machine).',
      );
    }
    session.stop(now);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const end = await session.run();
  switch (end) {
    case 'removed':
      await store.forget();
      log.error(REFUSED['NODE_INVALID'] ?? '');
      return 1;
    case 'outdated':
      log.error(REFUSED['NODE_OUTDATED'] ?? '');
      return 1;
    case 'replaced':
      log.error(
        'Another copy of this node connected, so this one stopped. Each machine needs its own data folder (--data).',
      );
      return 1;
    case 'stopped':
      log.ok('Stopped');
      return 0;
  }
}

async function doctor(options: Options, log: Output): Promise<number> {
  log.say(log.paint('bold', `subs.rocks node ${NODE_VERSION}`));
  let bad = 0;
  const [major = 0] = process.versions.node.split('.').map(Number);
  if (major >= 24) log.ok(`Node.js ${process.versions.node}`);
  else {
    bad += 1;
    log.error(`Node.js ${process.versions.node}: it needs 24 or newer`);
  }
  const store = new Store(options.data);
  try {
    await store.prepare();
    await access(options.data, constants.W_OK);
    log.ok(`Data folder ${options.data}`);
  } catch (error) {
    bad += 1;
    log.error(`Data folder ${options.data}: ${explain(error)}`);
  }
  const described = await describeMachine({ tools: TOOLS, gpu: options.gpu, workDir: store.dir });
  for (const problem of described.problems) {
    bad += 1;
    log.error(problem);
  }
  if (described.problems.length === 0) {
    const { machine } = described;
    log.ok(`ffmpeg ${machine.ffmpeg} with libass · ${encodersLine(machine)}`);
    log.ok(machineLine(machine));
    if (machine.diskBytes !== null) {
      const free = machine.diskBytes;
      const say = free < 20e9 ? log.warn.bind(log) : log.ok.bind(log);
      say(
        `${size(free)} free for renders${free < 20e9 ? ': a long 4K render needs 20 GB or more' : ''}`,
      );
    }
  }
  for (const note of described.notes) log.info(note);
  try {
    await call(options.server, '/api/health', {}, null);
    log.ok(`Reaches ${options.server}`);
  } catch (error) {
    bad += 1;
    log.error(`Can't reach ${options.server}: ${explain(error)}`);
  }
  const credential = await store.credential();
  if (credential) {
    try {
      const self = await call(
        options.server,
        '/api/nodes/self',
        { secret: credential.secret },
        NodeSelf,
      );
      log.ok(`Joined as “${self.node.name}”`);
    } catch (error) {
      bad += 1;
      log.error(explain(error));
    }
  } else {
    log.info('Hasn’t joined a workspace yet: `subs-node start --token …`');
  }
  log.say(
    bad === 0
      ? '\nThis machine can render.'
      : `\n${bad} thing${bad === 1 ? '' : 's'} to fix first.`,
  );
  return bad === 0 ? 0 : 1;
}

async function status(options: Options, log: Output): Promise<number> {
  const credential = await new Store(options.data).credential();
  if (!credential) {
    log.info('This machine hasn’t joined a workspace (`subs-node start --token …`).');
    return 1;
  }
  try {
    const self = await call(
      credential.server,
      '/api/nodes/self',
      { secret: credential.secret },
      NodeSelf,
    );
    log.ok(`“${self.node.name}”, a machine of a workspace on ${new URL(credential.server).host}`);
    return 0;
  } catch (error) {
    log.error(explain(error));
    return 1;
  }
}

async function remove(options: Options, log: Output): Promise<number> {
  const store = new Store(options.data);
  const credential: Credential | null = await store.credential();
  if (!credential) {
    log.info('This machine hasn’t joined a workspace: nothing to remove.');
    return 0;
  }
  try {
    await call(
      credential.server,
      '/api/nodes/self',
      { method: 'DELETE', secret: credential.secret },
      null,
    );
  } catch (error) {
    // Removed already, from the workspace's settings: forgetting it is all that's left.
    if (!(error instanceof Refused && error.code === 'NODE_INVALID')) {
      log.error(explain(error));
      return 1;
    }
  }
  await store.forget();
  log.ok(`Removed “${credential.name}” from its workspace`);
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  // A render's own process (runner.ts).
  if (argv[0] === '__job') {
    await jobProcess();
    return 0;
  }
  let options: Options;
  try {
    options = parseOptions(argv, process.env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`subs-node: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  const log = new Output({ format: options.log, verbose: options.verbose });
  switch (options.command) {
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    case 'version':
      process.stdout.write(
        `${NODE_VERSION} (protocol ${NODE_PROTOCOL}, engine ${ENGINE_VERSION})\n`,
      );
      return 0;
    case 'start':
      return start(options, log);
    case 'doctor':
      return doctor(options, log);
    case 'status':
      return status(options, log);
    case 'remove':
      return remove(options, log);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `subs-node: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
