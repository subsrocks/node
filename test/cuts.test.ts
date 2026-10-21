import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cutFilters, renderAudioFilter } from '../src/engine/render.ts';
import type { RenderJob } from '../src/job.ts';

const ffmpeg = process.env['FFMPEG'] ?? 'ffmpeg';

describe('cut-outs in a render', () => {
  it('drop what’s inside them and move what follows up by the time taken out', () => {
    const cuts = [
      { startMs: 2_000, endMs: 3_500 },
      { startMs: 5_000, endMs: 6_000 },
    ];
    expect(cutFilters(cuts, 'video')).toEqual([
      "select='not(gte(t,2.000)*lt(t,3.500)+gte(t,5.000)*lt(t,6.000))'",
      "setpts='PTS-(clip(T-2.000,0,1.500)+clip(T-5.000,0,1.000))/TB'",
    ]);
    expect(cutFilters([], 'video')).toEqual([]);
    expect(renderAudioFilter({ startPtsMs: 40, cuts } as RenderJob)).toBe(
      "asetpts=PTS-0.040/TB,aselect='not(gte(t,2.000)*lt(t,3.500)+gte(t,5.000)*lt(t,6.000))',asetpts='PTS-(clip(T-2.000,0,1.500)+clip(T-5.000,0,1.000))/TB',aresample=async=1:first_pts=0",
    );
    // Without cut-outs, the sound is as it always was.
    expect(renderAudioFilter({ startPtsMs: 0 } as RenderJob)).toBe(
      'asetpts=PTS-0.000/TB,aresample=async=0',
    );
  });

  describe('through ffmpeg', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cuts-test-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('leaves a video as long as what’s kept, its sound with it', () => {
      const source = join(dir, 'source.mp4');
      execFileSync(ffmpeg, [
        ...['-hide_banner', '-loglevel', 'error', '-y'],
        ...['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=6'],
        ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6'],
        ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source],
      ]);
      const encode = (name: string, job: RenderJob) => {
        const out = join(dir, name);
        execFileSync(ffmpeg, [
          ...['-hide_banner', '-loglevel', 'error', '-y', '-i', source],
          ...['-vf', ['setpts=PTS-0.000/TB', ...cutFilters(job.cuts ?? [], 'video')].join(',')],
          ...['-af', renderAudioFilter(job)],
          ...['-c:v', 'libx264', '-c:a', 'aac', out],
        ]);
        const probe = (entries: string, stream: 'v' | 'a', count = false) =>
          Number(
            execFileSync(
              'ffprobe',
              [
                ...[
                  '-v',
                  'error',
                  '-select_streams',
                  `${stream}:0`,
                  ...(count ? ['-count_frames'] : []),
                ],
                ...['-show_entries', `stream=${entries}`, '-of', 'csv=p=0', out],
              ],
              { encoding: 'utf8' },
            ).trim(),
          );
        return {
          video: probe('duration', 'v'),
          audio: probe('duration', 'a'),
          frames: probe('nb_read_frames', 'v', true),
        };
      };
      const whole = encode('whole.mp4', { startPtsMs: 0 } as RenderJob);
      const cut = encode('cut.mp4', {
        startPtsMs: 0,
        cuts: [{ startMs: 1_000, endMs: 3_000 }],
      } as RenderJob);
      // Two seconds shorter, video and sound alike: exactly the 50 frames inside the cut are gone.
      expect(cut.video).toBeCloseTo(whole.video - 2, 1);
      expect(cut.audio).toBeCloseTo(whole.audio - 2, 1);
      expect(cut.frames).toBe(whole.frames - 50);
    });
  });
});
