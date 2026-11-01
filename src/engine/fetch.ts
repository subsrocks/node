import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  FETCH_THUMBNAIL_WIDTH,
  FETCHED_DESCRIPTION_MAX,
  type FetchError,
  type FetchedDetails,
  type FetchJob,
  type FetchResult,
  MAX_FETCH_BYTES,
  MAX_FETCH_DURATION_MS,
} from '../job.ts';
import { config } from './config.ts';
import { JobError } from './errors.ts';
import { run } from './ffmpeg.ts';
import { getFile, putFile, putJson } from './io.ts';

/**
 * A linked video's download (ADRs 0021, 0025 and 0092): yt-dlp, run on subs.rocks's fetcher and on
 * a workspace's own machine alike, so a video comes the same from either.
 */

/** How often the download's progress is written for the project page. */
const PROGRESS_EVERY_MS = 2000;

/** The line yt-dlp prints for progress, as `--progress-template` makes it. */
const PROGRESS_MARK = 'subs-progress';

/**
 * yt-dlp's words for why a download can't happen, as the codes the project page explains (the
 * legacy downloader's classification, ARCHITECTURE §7.2). Sign-in checks are the workspace's
 * cookies to solve; the rest no cookies change. Null: something else, tried again.
 */
export function classifyYtDlp(stderr: string): FetchError | null {
  const text = stderr.toLowerCase();
  if (
    (text.includes('sign in to confirm you') && text.includes('not a bot')) ||
    text.includes('po token') ||
    text.includes('proof of origin')
  ) {
    return 'source_blocked';
  }
  if (text.includes('age-restricted') || text.includes('sign in to confirm your age')) {
    return 'source_age_restricted';
  }
  // A video a site shows only to accounts (yt-dlp's words for any site's, Bilibili's among them):
  // the workspace's cookies for the site sign in.
  if (text.includes('only available for registered users')) return 'source_blocked';
  if (
    text.includes('video unavailable') ||
    text.includes('private video') ||
    text.includes('this video is private') ||
    text.includes('members-only') ||
    text.includes('premium members only') ||
    text.includes('join this channel') ||
    text.includes('not available in your country') ||
    text.includes('video has been removed') ||
    text.includes("this video isn't available anymore") ||
    text.includes('this live event will begin')
  ) {
    return 'source_unavailable';
  }
  // Turned away as data centers are (Bilibili's risk control): its `412`, said by yt-dlp as the
  // page's error or in its own words, or the CAPTCHA page it reads as a rate limit. Neither
  // waiting a minute nor cookies of ours get past it.
  if (
    text.includes('http error 412') ||
    text.includes('request is blocked by server') ||
    (text.includes('[bilibili]') && text.includes('exceeded the rate limit'))
  ) {
    return 'source_refused';
  }
  if (text.includes('larger than max-filesize')) return 'source_too_large';
  // No site extractor knows the address (the generic one, which reads any page, is off).
  if (text.includes('unsupported url')) return 'source_unsupported';
  return null;
}

/** What a page's details (yt-dlp's info) say for the project: its title, description and site. */
export function detailsOf(info: Record<string, unknown>): FetchedDetails {
  const description = text(info['description']);
  const domain = text(info['webpage_url_domain']);
  return {
    title: text(info['title']),
    description: description ? description.slice(0, FETCHED_DESCRIPTION_MAX) : null,
    site: domain ? domain.replace(/^www\./, '') : null,
  };
}

/** One progress line: how much of the current file has arrived, and of the whole download. */
export function parseProgress(
  line: string,
): { status: string; downloaded: number; total: number | null; approx: number | null } | null {
  const at = line.indexOf(PROGRESS_MARK);
  if (at < 0) return null;
  const [status, downloaded, total, estimate, approx] = line
    .slice(at + PROGRESS_MARK.length)
    .trim()
    .split(/\s+/);
  const number = (value: string | undefined) => {
    const parsed = Number(value);
    return value && value !== 'NA' && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const got = number(downloaded);
  if (!status || got === null) return null;
  return {
    status,
    downloaded: got,
    total: number(total) ?? number(estimate),
    approx: number(approx),
  };
}

/**
 * How far a download is across its files (a video and an audio stream, merged after): the files
 * finished, plus the current one, of the whole the platform estimated; never 1 before it's stored.
 */
export class DownloadProgress {
  private finished = 0;
  private current = 0;
  private whole: number | null = null;
  private currentTotal: number | null = null;

  /** Takes a progress line; true when it was one. */
  take(line: string): boolean {
    const progress = parseProgress(line);
    if (!progress) return false;
    if (progress.approx !== null) this.whole = progress.approx;
    if (progress.status === 'finished') {
      this.finished += progress.total ?? progress.downloaded;
      this.current = 0;
      this.currentTotal = null;
    } else {
      this.current = progress.downloaded;
      this.currentTotal = progress.total;
    }
    return true;
  }

  fraction(): number {
    const whole = this.whole ?? this.currentTotal;
    if (!whole) return 0;
    const done = this.whole ? this.finished + this.current : this.current;
    return Math.min(0.99, Math.max(0, done / whole));
  }
}

const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

/** The day `20260917` names, at UTC midnight. */
/**
 * When it went public, to the second, when the downloader knows: a premiere's release, else its
 * upload (`timestamp`). YouTube's `upload_date` is only the day, in UTC.
 */
export function momentOf(info: Record<string, unknown>): number | null {
  for (const key of ['release_timestamp', 'timestamp']) {
    const seconds = info[key];
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
      return Math.round(seconds * 1000);
    }
  }
  return null;
}

export function dayOf(uploadDate: unknown): number | null {
  if (typeof uploadDate !== 'string' || !/^\d{8}$/.test(uploadDate)) return null;
  return Date.UTC(
    Number(uploadDate.slice(0, 4)),
    Number(uploadDate.slice(4, 6)) - 1,
    Number(uploadDate.slice(6, 8)),
  );
}

const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
const whole = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;

/**
 * The sharpest picture a download asks for, by its short side (yt-dlp's `res`): 4K, as the
 * platforms offer and renders go (ADR 0021, amended); then 1080p, 720p and 480p, the first that
 * fits what a download keeps (the plan's files, ADR 0054, or the runner's 4 GB).
 */
export const DOWNLOAD_CAPS = [2160, 1080, 720, 480] as const;

/**
 * The sizes a download tries, sharpest first, within the workspace's plan (ADR 0020): from 4K or
 * from 1080p, down to 480p. A job without a cap was queued before plans bounded it: 4K.
 */
export function capsFor(quality: number | undefined): number[] {
  const most = quality ?? DOWNLOAD_CAPS[0];
  const caps = DOWNLOAD_CAPS.filter((cap) => cap <= most);
  return caps.length > 0 ? caps : [Math.min(...DOWNLOAD_CAPS)];
}

/** The least a download steps down to, by the short side: larger even there, it's refused. */
const SMALLEST_CAP = Math.min(...DOWNLOAD_CAPS);

/**
 * The formats a download at a cap asks for (yt-dlp's `-f`): the sharpest video from 480p to the
 * cap, by its short side, whose size the page lists within what a download keeps, with audio
 * that fits too. So a video too large at 1080p in H.264 comes in one download, at 1080p in AV1
 * or at 720p, rather than after 1 GB of one that won't fit. Where nothing does by the sizes
 * listed (or the page lists none), the best up to the cap, which yt-dlp stops at the limit.
 */
export function formatsFor(cap: number, maxBytes: number): string {
  const fits = `[filesize<?${maxBytes}]`;
  // The short side is a landscape video's height, a portrait one's width.
  const wide = `[aspect_ratio>=?1][height<=?${cap}][height>=?${SMALLEST_CAP}]`;
  const tall = `[aspect_ratio<?1][width<=?${cap}][width>=?${SMALLEST_CAP}]`;
  return `bv*${fits}${wide}+ba${fits}/bv*${fits}${tall}+ba${fits}/bv*+ba/b`;
}

/** Whether yt-dlp stopped a download at the limit (it says so only out of quiet mode). */
export function stoppedAtLimit(said: string): boolean {
  return said.toLowerCase().includes('larger than max-filesize');
}

/**
 * Whether the video yt-dlp chose was one its page listed as larger than the limit: chosen past
 * every one that fits (formatsFor), so no smaller cap finds one either.
 */
export function listedOver(page: Record<string, unknown>, maxBytes: number): boolean {
  const chosen = typeof page['format_id'] === 'string' ? page['format_id'].split('+') : [];
  const formats = Array.isArray(page['formats']) ? (page['formats'] as unknown[]) : [];
  return formats.some((format) => {
    if (!format || typeof format !== 'object') return false;
    const each = format as Record<string, unknown>;
    return (
      chosen.includes(String(each['format_id'])) &&
      each['vcodec'] !== 'none' &&
      typeof each['filesize'] === 'number' &&
      each['filesize'] > maxBytes
    );
  });
}

/**
 * Why a download that ended well brought no file, from what yt-dlp said: its filter turned the
 * video away (longer than 6 hours, or live), it was larger than a download keeps even at the
 * smallest size, or a refusal it warned of. Anything else is a failure, tried again.
 */
export function nothingDownloaded(printed: string, stderr: string): JobError<FetchError> {
  const detail = `${printed}\n${stderr}`.trim().slice(-2000) || 'nothing was downloaded';
  if (printed.includes('does not pass filter')) return new JobError('too_long', detail);
  if (stoppedAtLimit(`${printed}\n${stderr}`)) return new JobError('source_too_large', detail);
  const known = classifyYtDlp(stderr);
  return known ? new JobError(known, detail) : new JobError('processing_failed', detail, true);
}

/** The sharpest video format a page offered (by its short side), from yt-dlp's info. */
export function offeredQuality(
  info: Record<string, unknown>,
): { width: number; height: number } | null {
  const formats = Array.isArray(info['formats']) ? (info['formats'] as unknown[]) : [];
  let best: { width: number; height: number } | null = null;
  for (const format of formats) {
    if (!format || typeof format !== 'object') continue;
    const each = format as Record<string, unknown>;
    if (each['vcodec'] === 'none' || typeof each['vcodec'] !== 'string') continue;
    const width = whole(each['width']);
    const height = whole(each['height']);
    if (!width || !height) continue;
    if (!best || Math.min(width, height) > Math.min(best.width, best.height)) {
      best = { width, height };
    }
  }
  return best;
}

/**
 * Whether yt-dlp said the platform kept formats back (signed out, YouTube may serve only some, or
 * want a proof-of-origin token for the rest; Bilibili keeps its sharper ones for accounts, its
 * sharpest for paying ones): what the workspace's cookies may get past.
 */
export function heldBack(said: string): boolean {
  return /formats? (?:have|has) been skipped|missing a url|forcing sabr|po token|po_token|format\(s\) .+ are missing/i.test(
    said,
  );
}

/**
 * Downloads a linked video into storage as its source's original (SRC-2, ADR 0021): the best up
 * to the workspace's plan's cap, 4K or 1080p, that fits what a download keeps (the plan's files,
 * ADR 0054; else 4 GB): by the sizes its page lists, at once (formatsFor); else smaller each time
 * yt-dlp stops it at the limit. H.264 and AAC preferred where the size is the same, video and
 * audio merged into one MP4. It runs on the fetcher, the one runner that
 * may reach the internet. Cookies (the workspace's: on a second try past a sign-in check, or
 * when asked to download again) are a private file in the job's directory, which goes with it.
 * What the platform says is returned with the file: its details, the sharpest picture it
 * offered, and whether it held formats back.
 */
export async function fetchVideo(
  job: FetchJob,
  dir: string,
  /** How much has come, each time it's written (a node shows it in its log). */
  onFraction?: (fraction: number) => void,
): Promise<FetchResult> {
  const limit = Math.min(job.maxBytes ?? MAX_FETCH_BYTES, MAX_FETCH_BYTES);
  const argsFor = (cap: number) => {
    const args = [
      // `--print` makes yt-dlp quiet, and quiet it skips a video without saying why: stopped at
      // the size limit, or turned away by the filter. Said, the next size down can be tried.
      '--no-quiet',
      '--no-playlist',
      '--no-mtime',
      '--no-cache-dir',
      '--socket-timeout',
      '30',
      '--retries',
      '5',
      '--fragment-retries',
      '10',
      '-f',
      formatsFor(cap, limit),
      '-S',
      `res:${cap},vcodec:avc,acodec:m4a`,
      '--merge-output-format',
      'mp4',
      '--max-filesize',
      String(limit),
      '--match-filter',
      `!is_live & duration <=? ${MAX_FETCH_DURATION_MS / 1000}`,
      '--paths',
      dir,
      '--output',
      'video.%(ext)s',
      '--newline',
      '--progress',
      '--progress-template',
      `download:${PROGRESS_MARK} %(progress.status)s %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(info.filesize_approx)s`,
      '--print',
      'after_move:%(.{filepath,title,description,webpage_url_domain,duration,channel,channel_id,upload_date,width,height})j',
      // The page's details as soon as it's read (the sheet says them while the video downloads),
      // and its picture, as a JPEG the platforms it goes to next take.
      '--write-info-json',
      '--write-thumbnail',
      '--convert-thumbnails',
      'jpg',
      // Sites the downloader knows, not any page: the generic extractor would read whatever it's
      // pointed at.
      '--use-extractors',
      'default,-generic',
      // YouTube's player challenges are solved in JavaScript, by a runtime the machine has (node,
      // in subs.rocks's image and the node's); without one, YouTube may serve less.
      ...(config.ytDlpJsRuntime
        ? ['--js-runtimes', config.ytDlpJsRuntime, '--remote-components', 'ejs:github']
        : []),
    ];
    if (cookies) args.push('--cookies', cookies);
    args.push('--', job.url);
    return args;
  };
  let cookies: string | null = null;
  if (job.cookies) {
    cookies = join(dir, 'cookies.txt');
    await writeFile(cookies, job.cookies, { mode: 0o600 });
  } else if (job.cookiesFile) {
    // A node's: read like the job's other files, only while the job is its own. Gone meanwhile
    // (removed from the workspace's settings), it downloads signed out.
    const file = join(dir, 'cookies.txt');
    await writeFile(file, '', { mode: 0o600 });
    cookies = await getFile(job.cookiesFile.key, file).then(
      () => file,
      () => null,
    );
  }

  // The page's details, once yt-dlp has written them beside the download (before it starts).
  let details: FetchedDetails | null = null;
  let looking = false;
  let pending: Promise<void> = Promise.resolve();
  let progress = new DownloadProgress();
  let reported = 0;
  const lookForDetails = () => {
    if (details || looking) return;
    looking = true;
    void readFile(join(dir, 'video.info.json'), 'utf8')
      .then((json) => {
        details = detailsOf(JSON.parse(json) as Record<string, unknown>);
        report(true);
      })
      .catch(() => {})
      .finally(() => {
        looking = false;
      });
  };
  const report = (force = false) => {
    lookForDetails();
    const now = Date.now();
    if (!force && now - reported < PROGRESS_EVERY_MS) return;
    reported = now;
    const value = { fraction: progress.fraction(), at: now, details };
    // Best effort, one at a time: a lost update is replaced by the next.
    onFraction?.(value.fraction);
    pending = pending.then(() => putJson(job.progress.key, value).catch(() => {}));
  };

  /** One run of yt-dlp: what it printed (but progress), and the tail of what it said on stderr. */
  const download = (args: string[]) =>
    new Promise<{ printed: string[]; stderr: string }>((done, fail) => {
      const printed: string[] = [];
      const child = spawn(config.ytDlp, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: dir,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });
      let errors = '';
      let buffer = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (progress.take(line)) report();
          else if (line.trim() !== '') printed.push(line.trim());
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errors = (errors + chunk.toString('utf8')).slice(-16 * 1024);
      });
      child.on('error', (error) =>
        fail(new JobError('processing_failed', `yt-dlp didn't start: ${error.message}`, false)),
      );
      child.on('close', (code) => {
        if (buffer.trim() !== '' && !progress.take(buffer)) printed.push(buffer.trim());
        if (code === 0) done({ printed, stderr: errors });
        else {
          const known = classifyYtDlp(errors);
          fail(
            known
              ? new JobError(known, errors.slice(-2000))
              : new JobError(
                  'processing_failed',
                  errors.slice(-2000) || `yt-dlp exited with ${code}`,
                  true,
                ),
          );
        }
      });
    });

  const fileOf = (printed: readonly string[]) =>
    printed
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((each) => each !== null && typeof each['filepath'] === 'string');

  // The page's details as yt-dlp wrote them before it downloaded: what it chose, and what it had.
  const readPage = () =>
    readFile(join(dir, 'video.info.json'), 'utf8')
      .then((json) => JSON.parse(json) as Record<string, unknown>)
      .catch(() => ({}) as Record<string, unknown>);

  let info: Record<string, unknown> | undefined;
  let outcome = { printed: [] as string[], stderr: '' };
  let said = '';
  for (const cap of capsFor(job.quality)) {
    progress = new DownloadProgress();
    outcome = await download(argsFor(cap));
    await pending;
    said = `${outcome.printed.join('\n')}\n${outcome.stderr}`;
    info = fileOf(outcome.printed) ?? undefined;
    // Larger than a download keeps at this size: the next size down, unless the page listed it
    // as too large, when no smaller size it lists fits either.
    if (info || !stoppedAtLimit(said) || listedOver(await readPage(), limit)) break;
  }
  if (!info) throw nothingDownloaded(outcome.printed.join('\n'), outcome.stderr);
  const path = resolve(dir, String(info['filepath']));
  if (!path.startsWith(`${resolve(dir)}/`)) {
    throw new JobError('processing_failed', 'the download landed outside its directory');
  }
  const page = await readPage();
  const extension = basename(path).split('.').pop()?.toLowerCase() ?? '';
  const output = await putFile(path, job.output.key, VIDEO_MIME[extension] ?? 'video/mp4');
  const told = detailsOf(info);
  await putJson(job.progress.key, { fraction: 1, at: Date.now(), details: told }).catch(() => {});
  const seconds = typeof info['duration'] === 'number' ? info['duration'] : null;
  return {
    output,
    thumbnail: job.thumbnail ? await keepThumbnail(job.thumbnail, dir) : null,
    info: {
      ...told,
      durationMs: seconds === null ? null : Math.round(seconds * 1000),
      channel: text(info['channel']),
      channelId: text(info['channel_id']),
      publishedAt: momentOf(info) ?? dayOf(info['upload_date']),
      publishedExact: momentOf(info) !== null,
      width: whole(info['width']),
      height: whole(info['height']),
      offered: offeredQuality(page),
      heldBack: heldBack(said),
      signedIn: cookies !== null,
    },
  };
}

/**
 * The platform's picture, kept beside the video: the JPEG as it came, and a `FETCH_THUMBNAIL_WIDTH` WebP
 * of it for lists. Best effort: a page without one, or a picture that won't convert, is none.
 */
async function keepThumbnail(
  refs: NonNullable<FetchJob['thumbnail']>,
  dir: string,
): Promise<FetchResult['thumbnail']> {
  const picture = join(dir, 'video.jpg');
  try {
    await access(picture);
    const preview = join(dir, 'thumbnail-preview.webp');
    await run('ffmpeg', [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      picture,
      '-vf',
      `scale=${FETCH_THUMBNAIL_WIDTH}:-2:flags=lanczos`,
      '-frames:v',
      '1',
      '-c:v',
      'libwebp',
      '-quality',
      '80',
      '-y',
      preview,
    ]);
    return {
      original: await putFile(picture, refs.original.key, 'image/jpeg'),
      preview: await putFile(preview, refs.preview.key, 'image/webp'),
    };
  } catch {
    return null;
  }
}
