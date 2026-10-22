# Changelog

What changed in each release of the node, for whoever runs one. A release is published as `ghcr.io/subsrocks/node:<version>` and as programs on GitHub Releases.

## 1.1.1

- Says where to get a token as subs.rocks now names the page: **Settings › Render machines**.

## 1.1.0

- Renders encode on the machine's video hardware, each kind tried at start in every way a render can ask of it: Apple's media engines on a Mac (H.264, H.265, and ProRes on chips with ProRes engines; an Intel Mac's H.264 and H.265), NVIDIA graphics cards, and Intel and AMD graphics on Linux (VA-API; in Docker, `--device /dev/dri`). subs.rocks sends a render to the hardware only when it was seen to make what the render asks; the rest encode on the processor.
- A long render on a machine with threads to spare is made in pieces at once (about one for every four threads, as many as memory holds; two at once on video hardware), joined and checked frame for frame. On 16 threads, four pieces at once made 1.6 to 3.6 times one encoder's frames.
- Encoders are told how many threads to use, by the machine's, or a container's `--cpus` limit, which they don't see on their own.
- The macOS program brings its own ffmpeg, built from the sources Debian builds the image's from, with the same libass and fonts: renders on a Mac draw exactly as they do in the image, with no Homebrew, on Apple silicon and Intel Macs. Each release attaches its sources.
- The image has VA-API's drivers, and joins the groups that own the graphics it's given.
- A machine is named for the computer: a Mac's own name, `$(hostname)` in the command Settings gives for Docker, and `Docker` rather than a container's id.

## 1.0.1

- The install script works in macOS's `sh`, where it stopped at `asset…: unbound variable`, and checks the machine once it's installed.
- On a Mac, the node finds Homebrew's `ffmpeg-full` (Homebrew's ffmpeg with libass, kept off the `PATH`) on its own; `--ffmpeg` (`SUBS_FFMPEG`) names any other.
- `subs-node doctor` and `start` say when libass picks fonts with the system's font system, as on a Mac, where text a template's fonts can't draw comes out in the machine's own fonts.
- CI installs and runs the program on Linux and macOS, x64 and arm64, before each release, and each release once it's out.

## 1.0.0

- The first release: `subs-node` joins a subs.rocks workspace with a token from **Settings › Your machines**, takes its renders one at a time, and makes them with the engine subs.rocks runs on its own machines, on the processor or an NVIDIA graphics card.
- The image for amd64 and arm64, and the program for Linux and macOS (x64 and arm64), with an install script.
