import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `install.sh` as people run it, piped into this machine's `sh` (dash on Debian and Ubuntu, an
 * old bash on macOS), installing from a release's files in a folder: a stand-in program, its
 * archive and SHA256SUMS.
 */

const SCRIPT = resolve(import.meta.dirname, '../scripts/install.sh');
const text = readFileSync(SCRIPT, 'utf8');

function has(tool: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status === 0;
}

/** This machine's program, as the script names it. */
const os = process.platform === 'darwin' ? 'macos' : 'linux';
const asset = `subs-node-${os}-${process.arch}`;

/** A release's files in a folder: a program that says its version and that the machine's fine. */
function release(sums?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'subs-node-release-'));
  const program = join(dir, asset);
  writeFileSync(
    program,
    '#!/bin/sh\nif [ "$1" = version ]; then echo 9.9.9; else echo "ran $1"; fi\n',
  );
  chmodSync(program, 0o755);
  execFileSync('tar', ['-czf', `${asset}.tar.gz`, asset], { cwd: dir });
  const hash = createHash('sha256')
    .update(readFileSync(join(dir, `${asset}.tar.gz`)))
    .digest('hex');
  writeFileSync(join(dir, 'SHA256SUMS'), sums ?? `${hash}  ${asset}.tar.gz\n`);
  return dir;
}

/** `curl … | sh`, from `from`, into a new folder. */
function install(from: string) {
  const home = mkdtempSync(join(tmpdir(), 'subs-node-home-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const run = spawnSync('sh', [], {
    input: text,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'],
      HOME: home,
      SUBS_NODE_FROM: `file://${from}`,
      SUBS_NODE_DIR: bin,
    },
  });
  return { ...run, program: join(bin, 'subs-node') };
}

describe('the install script', () => {
  it('braces every expansion, which macOS’s sh needs before a character that isn’t ASCII', () => {
    const code = text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(code.match(/\$[A-Za-z_]\w*/g) ?? []).toEqual([]);
  });

  it('parses in this machine’s sh', () => {
    expect(spawnSync('sh', ['-n', SCRIPT]).status).toBe(0);
  });

  it.skipIf(!has('curl'))('installs the program, then checks the machine with it', () => {
    const run = install(release());
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Downloading ${asset}…`);
    expect(run.stdout).toContain(`Installed 9.9.9 at ${run.program}`);
    expect(run.stdout).toContain('ran doctor');
    expect(execFileSync(run.program, ['version'], { encoding: 'utf8' })).toBe('9.9.9\n');
  });

  it.skipIf(!has('curl'))('installs nothing that isn’t the release’s file', () => {
    const run = install(release(`${'0'.repeat(64)}  ${asset}.tar.gz\n`));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('its SHA-256 differs');
    expect(existsSync(run.program)).toBe(false);
  });
});
