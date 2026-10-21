import { describe, expect, it } from 'vitest';
import { FontReport } from '../src/engine/render.ts';

/** Lines as ffmpeg 7.1 prints libass 0.17's messages. */
const LINES = [
  "[Parsed_ass_2 @ 0xe33588] Loading font file 'fonts/SourceSans3-Bold.woff2'",
  '[Parsed_ass_2 @ 0xe33588] fontselect: (Source Sans 3, 700, 0) -> SourceSans3-Bold, 0, SourceSans3-Bold',
  '[Parsed_ass_2 @ 0xe33588] Glyph 0x5B57 not found, selecting one more font for (Source Sans 3, 700, 0)',
  '[Parsed_ass_2 @ 0xe33588] fontselect: (Source Sans 3, 700, 0) -> NotoSansSC-Bold, 0, NotoSansSC-Bold',
  '[Parsed_ass_2 @ 0xe33588] fontselect: (Tahoma, 400, 0) -> /tmp/job/fonts/library-0, 0, (none)',
  '[Parsed_ass_2 @ 0xe33588] fontselect: (文泉驿微米黑, 400, 0) -> /tmp/job/fonts/library-1, 0, WenQuanYiMicroHei',
  '[Parsed_ass_2 @ 0xe33588] Glyph 0x13000 not found, selecting one more font for (Source Sans 3, 700, 0)',
  '[Parsed_ass_2 @ 0xe33588] fontselect: failed to find any fallback with glyph 0x13000 for font: (Source Sans 3, 700, 0)',
  '[Parsed_ass_2 @ 0xe33588] fontselect: failed to find any fallback with glyph 0x13000 for font: (Source Sans 3, 700, 0)',
].join('\n');

describe('font report', () => {
  it('names the faces libass picked and the characters it had no font for', () => {
    const report = new FontReport();
    report.push(Buffer.from(LINES, 'utf8'));
    expect(report.finish()).toEqual({
      faces: ['SourceSans3-Bold', 'NotoSansSC-Bold', 'library-0', 'WenQuanYiMicroHei'],
      missingGlyphs: ['𓀀'],
    });
  });

  it('reads lines split across stderr chunks, even mid-character', () => {
    const whole = new FontReport();
    whole.push(Buffer.from(LINES, 'utf8'));
    const split = new FontReport();
    const bytes = Buffer.from(LINES, 'utf8');
    for (let at = 0; at < bytes.length; at += 37) split.push(bytes.subarray(at, at + 37));
    expect(split.finish()).toEqual(whole.finish());
  });
});
