#!/usr/bin/env node
// A stand-in for yt-dlp in the node's tests: it "downloads" by copying `FAKE_VIDEO`, speaking
// yt-dlp's own lines (the progress template's and `--print`'s JSON), and writes the page's
// details beside it, as yt-dlp does. Signed in (`--cookies` with a `SESSDATA`), its title says so;
// a page that turns it away (`refused` in the address) fails as Bilibili's does.
import { copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('2026.08.19\n');
  process.exit(0);
}
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const url = args.at(-1) ?? '';
if (url.includes('refused')) {
  process.stderr.write(
    'ERROR: [BiliBili] x: Unable to download webpage: HTTP Error 412: Precondition Failed\n',
  );
  process.exit(1);
}
const cookies = option('--cookies');
const signedIn = cookies !== undefined && readFileSync(cookies, 'utf8').includes('\tSESSDATA\t');
const dir = option('--paths') ?? process.cwd();
const path = join(dir, 'video.mp4');
const title = signedIn ? 'A video, signed in' : 'A video';
writeFileSync(
  join(dir, 'video.info.json'),
  JSON.stringify({ id: 'x', title, webpage_url_domain: 'www.bilibili.com', formats: [] }),
);
copyFileSync(process.env.FAKE_VIDEO ?? '', path);
const bytes = statSync(path).size;
process.stdout.write(`subs-progress downloading ${Math.round(bytes / 2)} ${bytes} NA NA\n`);
process.stdout.write(`subs-progress finished ${bytes} ${bytes} NA NA\n`);
process.stdout.write(
  `${JSON.stringify({ filepath: path, title, description: null, webpage_url_domain: 'www.bilibili.com', duration: 2, channel: null, channel_id: null, upload_date: '20261101', width: 320, height: 240 })}\n`,
);
