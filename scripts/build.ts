/**
 * Builds the node: `dist/subs-node.mjs`, one readable ESM file the image runs with its Node.js;
 * and with `--sea`, `dist/subs-node-<os>-<arch>`, this program as a single executable for the
 * machine it's built on (Node.js 25.5 or newer builds it, carrying itself inside). The release
 * workflow builds one on each platform it releases for.
 *
 *   node scripts/build.ts          the bundle
 *   node scripts/build.ts --sea    the bundle, and the executable
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BuildOptions, build } from 'esbuild';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const sea = process.argv.includes('--sea');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const common: BuildOptions = {
  entryPoints: [join(ROOT, 'src/agent/main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  // Readable, so whoever runs it can read what runs.
  minify: false,
  legalComments: 'inline',
  logLevel: 'warning',
};

await build({
  ...common,
  format: 'esm',
  // The entry's `#!/usr/bin/env node` comes with it.
  outfile: join(DIST, 'subs-node.mjs'),
});
console.log('dist/subs-node.mjs');

if (sea) {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 25 || (major === 25 && minor < 5)) {
    throw new Error(
      `a single executable needs Node.js 25.5 or newer to build (this is ${process.versions.node})`,
    );
  }
  // A single executable's entry is CommonJS.
  await build({ ...common, format: 'cjs', outfile: join(DIST, 'subs-node.cjs') });
  const os = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform as string];
  if (!os) throw new Error(`no executable for ${process.platform}`);
  const name = `subs-node-${os}-${process.arch}`;
  const config = join(DIST, 'sea-config.json');
  writeFileSync(
    config,
    JSON.stringify({
      main: join(DIST, 'subs-node.cjs'),
      output: join(DIST, name),
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
    }),
  );
  execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' });
  // macOS runs only signed code: an ad hoc signature, as Node.js's own docs do.
  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--sign', '-', '--force', join(DIST, name)], { stdio: 'inherit' });
  }
  rmSync(config);
  console.log(`dist/${name}`);
}
