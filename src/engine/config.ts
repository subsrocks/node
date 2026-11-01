/**
 * The engine's settings, from the environment it runs in: where its storage host is, where it
 * works, its tools and the built-in fonts. The defaults are subs.rocks's media container's; a node
 * sets them for each job it runs (`agent/runner.ts`).
 */
export const config = {
  /** Where reads and writes go: the Worker-served `media.internal` host in subs.rocks's container. */
  ioOrigin: (process.env['MEDIA_IO_ORIGIN'] ?? 'http://media.internal').replace(/\/$/, ''),
  /** Sent with every read and write (`?token=`): a node's job token; the container needs none. */
  ioToken: process.env['MEDIA_IO_TOKEN'] ?? null,
  workDir: process.env['WORK_DIR'] ?? '/tmp/jobs',
  ffmpeg: process.env['FFMPEG'] ?? 'ffmpeg',
  ffprobe: process.env['FFPROBE'] ?? 'ffprobe',
  /** The built-in fonts renders draw with when a template doesn't bring its own. */
  fontsDir: process.env['FONTS_DIR'] ?? '/app/fonts',
  /** The downloader linked videos come by (ADR 0092: on a node too). */
  ytDlp: process.env['YTDLP'] ?? 'yt-dlp',
  /**
   * The JavaScript runtime yt-dlp solves YouTube's challenges with (`node` in the images); empty,
   * none (a machine without one).
   */
  ytDlpJsRuntime: process.env['YTDLP_JS_RUNTIME'] ?? 'node',
};
