# Changelog

What changed in each release of the node, for whoever runs one. A release is published as `ghcr.io/subsrocks/node:<version>` and as programs on GitHub Releases.

## 1.0.1

- The install script works in macOS's `sh`, where it stopped at `asset…: unbound variable`, and checks the machine once it's installed.
- On a Mac, the node finds Homebrew's `ffmpeg-full` (Homebrew's ffmpeg with libass, kept off the `PATH`) on its own; `--ffmpeg` (`SUBS_FFMPEG`) names any other.
- `subs-node doctor` and `start` say when libass picks fonts with the system's font system, as on a Mac, where text a template's fonts can't draw comes out in the machine's own fonts.
- CI installs and runs the program on Linux and macOS, x64 and arm64, before each release, and each release once it's out.

## 1.0.0

- The first release: `subs-node` joins a subs.rocks workspace with a token from **Settings › Your machines**, takes its renders one at a time, and makes them with the engine subs.rocks runs on its own machines, on the processor or an NVIDIA graphics card.
- The image for amd64 and arm64, and the program for Linux and macOS (x64 and arm64), with an install script.
