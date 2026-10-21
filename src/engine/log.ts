/** A line in the runner's log (its stdout and stderr, which Observability keeps), as JSON. */
export function log(
  level: 'info' | 'error',
  message: string,
  fields: Record<string, unknown> = {},
) {
  const line = JSON.stringify({ level, message, ...fields });
  // biome-ignore lint/suspicious/noConsole: the runner's log is its stdout.
  if (level === 'error') console.error(line);
  // biome-ignore lint/suspicious/noConsole: the runner's log is its stdout.
  else console.log(line);
}
