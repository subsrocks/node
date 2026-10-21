import manifest from '../package.json' with { type: 'json' };
import { ENGINE_VERSION } from './job.ts';
import { NODE_PROTOCOL } from './protocol.ts';

/** This node's version, as released (`v1.2.3` on GitHub, `ghcr.io/subsrocks/node:1.2.3`). */
export const NODE_VERSION: string = manifest.version;

export { ENGINE_VERSION, NODE_PROTOCOL };
