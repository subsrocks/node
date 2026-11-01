import { describe, expect, it } from 'vitest';
import {
  capsFor,
  classifyYtDlp,
  DownloadProgress,
  dayOf,
  detailsOf,
  formatsFor,
  heldBack,
  listedOver,
  momentOf,
  nothingDownloaded,
  offeredQuality,
  parseProgress,
  stoppedAtLimit,
} from '../src/engine/fetch.ts';

describe('the fetch job', () => {
  it('reads yt-dlp’s refusals as what the project page explains', () => {
    expect(classifyYtDlp("ERROR: [youtube] x: Sign in to confirm you're not a bot.")).toBe(
      'source_blocked',
    );
    expect(classifyYtDlp('WARNING: ... PO Token required')).toBe('source_blocked');
    expect(classifyYtDlp('ERROR: Sign in to confirm your age')).toBe('source_age_restricted');
    expect(classifyYtDlp('ERROR: [youtube] x: Video unavailable')).toBe('source_unavailable');
    expect(classifyYtDlp('ERROR: Private video. Sign in if you’ve been granted access')).toBe(
      'source_unavailable',
    );
    expect(classifyYtDlp('ERROR: Join this channel to get access to members-only content')).toBe(
      'source_unavailable',
    );
    expect(classifyYtDlp('File is larger than max-filesize')).toBe('source_too_large');
    // Bilibili's: a video for accounts, and one for paying ones.
    expect(
      classifyYtDlp(
        'ERROR: [BiliBili] 1x: This video is only available for registered users. Use --cookies-from-browser or --cookies for the authentication.',
      ),
    ).toBe('source_blocked');
    expect(classifyYtDlp('ERROR: [BiliBili] 1x: This video is for premium members only')).toBe(
      'source_unavailable',
    );
    expect(classifyYtDlp('ERROR: Unsupported URL: https://example.com/page')).toBe(
      'source_unsupported',
    );
    // Turned away as data centers are, by Bilibili's risk control, in each of yt-dlp's words.
    expect(
      classifyYtDlp(
        'ERROR: [BiliBili] 1esuU6XE6G: Unable to download webpage: HTTP Error 412: Precondition Failed (caused by <HTTPError 412: Precondition Failed>)',
      ),
    ).toBe('source_refused');
    expect(
      classifyYtDlp(
        'ERROR: [BiliBili] 1esuU6XE6G: Request is blocked by server (412), please wait and try later.',
      ),
    ).toBe('source_refused');
    expect(
      classifyYtDlp(
        'ERROR: [BiliBili] 1esuU6XE6G: You have exceeded the rate limit. Try again later',
      ),
    ).toBe('source_refused');
    // Anything else is tried again: another site's rate limit, a server's error.
    expect(classifyYtDlp('ERROR: [vimeo] 1: You have exceeded the rate limit')).toBeNull();
    expect(classifyYtDlp('ERROR: unable to download video data: HTTP Error 503')).toBeNull();
  });

  it('reads a page’s details: its title, description (cut to what’s kept) and site', () => {
    expect(
      detailsOf({
        title: 'A video',
        description: 'x'.repeat(6000),
        webpage_url_domain: 'www.bilibili.com',
      }),
    ).toEqual({ title: 'A video', description: 'x'.repeat(5000), site: 'bilibili.com' });
    expect(detailsOf({ title: '', description: null })).toEqual({
      title: null,
      description: null,
      site: null,
    });
  });

  it('reads its progress lines, missing numbers and all', () => {
    expect(parseProgress('subs-progress downloading 1024 4096 NA 8192')).toEqual({
      status: 'downloading',
      downloaded: 1024,
      total: 4096,
      approx: 8192,
    });
    expect(parseProgress('subs-progress downloading 10 NA 100.5 NA')).toEqual({
      status: 'downloading',
      downloaded: 10,
      total: 100.5,
      approx: null,
    });
    expect(parseProgress('[download] Destination: video.f137.mp4')).toBeNull();
  });

  it('counts a video and its audio as one download, never done before it’s stored', () => {
    const progress = new DownloadProgress();
    progress.take('subs-progress downloading 400 800 NA 1000');
    expect(progress.fraction()).toBeCloseTo(0.4);
    progress.take('subs-progress finished 800 800 NA 1000');
    progress.take('subs-progress downloading 100 200 NA 1000');
    expect(progress.fraction()).toBeCloseTo(0.9);
    progress.take('subs-progress finished 200 200 NA 1000');
    expect(progress.fraction()).toBe(0.99);
    // Without the whole's size, the file's own share.
    const alone = new DownloadProgress();
    alone.take('subs-progress downloading 50 200 NA NA');
    expect(alone.fraction()).toBeCloseTo(0.25);
  });
  it('reads the sharpest picture a page offered, by its short side', () => {
    expect(
      offeredQuality({
        formats: [
          { vcodec: 'none', acodec: 'opus' },
          { vcodec: 'avc1.640028', width: 1920, height: 960 },
          { vcodec: 'vp09.00.51.08', width: 3840, height: 1920 },
          { vcodec: 'av01.0.12M.08', width: 2560, height: 1280 },
          { vcodec: 'images', width: 320, height: 180, format_note: 'storyboard' },
        ],
      }),
    ).toEqual({ width: 3840, height: 1920 });
    // A vertical video's short side is its width.
    expect(
      offeredQuality({
        formats: [
          { vcodec: 'avc1', width: 1080, height: 1920 },
          { vcodec: 'vp9', width: 720, height: 1280 },
        ],
      }),
    ).toEqual({ width: 1080, height: 1920 });
    expect(offeredQuality({})).toBeNull();
  });

  it('hears the platform holding formats back from a signed-out download', () => {
    expect(
      heldBack(
        'WARNING: [youtube] 3iRUwVzRDZQ: Some web client https formats have been skipped as they are missing a url. YouTube is forcing SABR streaming for this client.',
      ),
    ).toBe(true);
    expect(heldBack('WARNING: [youtube] abc: tv client formats require a PO Token')).toBe(true);
    expect(
      heldBack(
        '[BiliBili] 1x: Format(s) 1080P 高清, 720P 准高清 are missing; you have to become a premium member to download them. Use --cookies-from-browser or --cookies for the authentication.',
      ),
    ).toBe(true);
    expect(heldBack('[download] Destination: video.f399.mp4')).toBe(false);
  });

  it('tries the sizes the workspace’s plan allows, sharpest first, down to 480p', () => {
    expect(capsFor(2160)).toEqual([2160, 1080, 720, 480]);
    expect(capsFor(1080)).toEqual([1080, 720, 480]);
    // Queued before plans bounded it: as it was, up to 4K.
    expect(capsFor(undefined)).toEqual([2160, 1080, 720, 480]);
    // Under every size: the smallest still.
    expect(capsFor(360)).toEqual([480]);
  });

  it('asks for the sharpest that fits by the sizes a page lists, from 480p to the cap', () => {
    expect(formatsFor(1080, 1_000_000_000)).toBe(
      'bv*[filesize<?1000000000][aspect_ratio>=?1][height<=?1080][height>=?480]+ba[filesize<?1000000000]' +
        '/bv*[filesize<?1000000000][aspect_ratio<?1][width<=?1080][width>=?480]+ba[filesize<?1000000000]' +
        '/bv*+ba/b',
    );
  });

  it('stops stepping down once the page listed what it chose as too large', () => {
    const page = {
      format_id: '299+140',
      formats: [
        { format_id: '140', vcodec: 'none', filesize: 30_000_000 },
        { format_id: '299', vcodec: 'avc1.64002a', filesize: 1_800_000_000 },
        { format_id: '136', vcodec: 'avc1.4d401f', filesize: 700_000_000 },
      ],
    };
    expect(listedOver(page, 1_000_000_000)).toBe(true);
    expect(listedOver(page, 2_000_000_000)).toBe(false);
    // A size it didn't list: a smaller one may fit.
    expect(listedOver({ format_id: '0', formats: [{ format_id: '0', vcodec: 'h264' }] }, 1)).toBe(
      false,
    );
    expect(listedOver({}, 1)).toBe(false);
  });

  it('says why a download that ended well brought nothing', () => {
    const code = (printed: string, stderr = '') => nothingDownloaded(printed, stderr).code;
    // Stopped at the limit, out of quiet mode: too large, even at the smallest size.
    expect(stoppedAtLimit('[download] File is larger than max-filesize (2 bytes > 1 bytes).')).toBe(
      true,
    );
    expect(code('[download] File is larger than max-filesize (2 bytes > 1 bytes). Aborting.')).toBe(
      'source_too_large',
    );
    // Turned away by the filter, its title in the line not read as a reason.
    expect(
      code('[download] Private video reacts does not pass filter (!is_live & duration <=? 21600)'),
    ).toBe('too_long');
    expect(code('', 'WARNING: [youtube] x: Sign in to confirm you’re not a bot')).toBe(
      'source_blocked',
    );
    // Nothing said: a failure, tried again, not a video too long.
    const silent = nothingDownloaded('', '');
    expect(silent.code).toBe('processing_failed');
    expect(silent.retryable).toBe(true);
  });

  it('knows when a video went public to the second, and only the day when that’s all it’s told', () => {
    // A premiere's release, over the upload it was made public from.
    expect(momentOf({ timestamp: 1_791_590_400, release_timestamp: 1_791_604_800 })).toBe(
      1_791_604_800_000,
    );
    expect(momentOf({ timestamp: 1_791_590_401 })).toBe(1_791_590_401_000);
    expect(momentOf({ upload_date: '20261010' })).toBeNull();
    expect(momentOf({ timestamp: 0 })).toBeNull();
    expect(dayOf('20261010')).toBe(Date.UTC(2026, 9, 10));
    expect(dayOf('2026-10-10')).toBeNull();
  });
});
