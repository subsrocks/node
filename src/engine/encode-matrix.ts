import type { RenderSettings } from '../job.ts';

/**
 * One of each encode a preset can ask for: every codec with every rate control it takes, 10-bit,
 * a new frame rate, keyframes, ProRes's profiles and a resampled sound. The encoders check
 * (`scripts/encoders.ts`) makes each in the media image; the tests, natively.
 */
const base: RenderSettings = {
  codec: 'h264',
  size: null,
  fps: null,
  rate: { mode: 'crf', crf: 23, maxKbps: null },
  speed: 'veryfast',
  tenBit: false,
  proresProfile: 'hq',
  keyframeSeconds: null,
  audio: { kbps: 128, sampleRate: null },
};

export const ENCODES: Readonly<Record<string, RenderSettings>> = {
  'h264 crf': base,
  'h264 crf, capped': { ...base, rate: { mode: 'crf', crf: 23, maxKbps: 2000 } },
  'h264 cbr': { ...base, rate: { mode: 'cbr', kbps: 2000 } },
  'h264 vbr': { ...base, rate: { mode: 'vbr', kbps: 2000, maxKbps: 4000 } },
  'h264 23.976 fps, keyframes 2 s, 44.1 kHz': {
    ...base,
    fps: '23.976',
    keyframeSeconds: 2,
    audio: { kbps: 128, sampleRate: 44_100 },
  },
  'hevc crf 10-bit': {
    ...base,
    codec: 'hevc',
    tenBit: true,
    rate: { mode: 'crf', crf: 26, maxKbps: null },
  },
  'hevc cbr': { ...base, codec: 'hevc', rate: { mode: 'cbr', kbps: 2000 } },
  'hevc vbr': { ...base, codec: 'hevc', rate: { mode: 'vbr', kbps: 2000, maxKbps: 4000 } },
  'av1 crf 10-bit': {
    ...base,
    codec: 'av1',
    tenBit: true,
    rate: { mode: 'crf', crf: 32, maxKbps: null },
  },
  'av1 crf, capped': { ...base, codec: 'av1', rate: { mode: 'crf', crf: 32, maxKbps: 2000 } },
  'av1 cbr': { ...base, codec: 'av1', rate: { mode: 'cbr', kbps: 2000 } },
  'av1 vbr': { ...base, codec: 'av1', rate: { mode: 'vbr', kbps: 2000, maxKbps: 4000 } },
  'prores hq': { ...base, codec: 'prores', proresProfile: 'hq' },
  'prores 4444': { ...base, codec: 'prores', proresProfile: '4444' },
  'prores proxy, 48 kHz': {
    ...base,
    codec: 'prores',
    proresProfile: 'proxy',
    audio: { kbps: 128, sampleRate: 48_000 },
  },
};
