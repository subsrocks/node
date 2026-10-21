import type { z } from 'zod';
import { NODE_PROTOCOL, PROTOCOL_HEADER } from '../protocol.ts';
import { NODE_VERSION } from '../version.ts';

/**
 * Requests to subs.rocks: each says which node and protocol it is, and a refusal comes back as
 * `Refused` with subs.rocks's code for it, so the node can say what to do about it.
 */

export class Refused extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(`subs.rocks refused: ${code} (HTTP ${status})`);
    this.name = 'Refused';
    this.code = code;
    this.status = status;
  }
}

/** subs.rocks couldn't be reached, or answered in a way it doesn't (a proxy's page). */
export class Unreachable extends Error {
  override readonly name = 'Unreachable';
}

export function headers(secret: string | null): Record<string, string> {
  return {
    'User-Agent': `subs-node/${NODE_VERSION}`,
    [PROTOCOL_HEADER]: String(NODE_PROTOCOL),
    ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
  };
}

export async function call<T>(
  server: string,
  path: string,
  init: { method?: string; secret?: string | null; body?: unknown; timeoutMs?: number },
  schema: z.ZodType<T> | null,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${server}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...headers(init.secret ?? null),
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
    throw new Unreachable(`${server} didn't answer${cause ? `: ${cause}` : ''}`);
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    throw new Unreachable(`${server} answered HTTP ${response.status}, not as subs.rocks does`);
  }
  if (!response.ok) {
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    if (typeof code === 'string') throw new Refused(code, response.status);
    throw new Unreachable(`${server} answered HTTP ${response.status}`);
  }
  if (schema === null) return undefined as T;
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new Unreachable(`${server} answered in a shape this node doesn't know`);
  return parsed.data;
}
