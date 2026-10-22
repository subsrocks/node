# subs.rocks node

Render your [subs.rocks](https://subs.rocks) videos on computers of your own, your workspace's **render machines**: a workstation with a fast graphics card, an edit bay that's idle at night, a server in a rack. The node connects to your workspace and waits for renders; each one it makes costs nothing: no render minutes, no credits.

It's the same render engine subs.rocks runs on its own machines, so a render made here has the subtitles subs.rocks would draw: by the same libass, with the same fonts, at the preset's settings. And it uses what the machine has: a Mac's media engines, an NVIDIA, Intel or AMD graphics card, and every thread of a big processor.

Machines of your own come with the **Team** and **Studio** plans.

## Quick start

In subs.rocks, open **Settings › Render machines** and choose **Add a render machine**. It gives you a command with a token in it, good for an hour on as many machines as you run it on.

### The program (macOS, Linux)

```sh
curl -fsSL https://github.com/subsrocks/node/releases/latest/download/install.sh | sh
subs-node start --token sr_reg_…
```

The installer keeps the program in `~/.local/share/subs-node` and the `subs-node` command in `~/.local/bin`, checked against the release's `SHA256SUMS`, then checks the machine and says what it still needs.

- **On a Mac** (Apple silicon or Intel, macOS 13 or newer), the program brings its own ffmpeg, [built here](./scripts/ffmpeg.ts) from the sources Debian builds the image's from, with the same libass and fonts: renders draw exactly as they do in the image, and encode on the Mac's media engines.
- **On Linux**, it needs **ffmpeg 7 or newer, built with libass**, from your package manager (Debian 13 and Ubuntu 25.04 have 7). `--ffmpeg` names another.

To keep it running, use your system's service manager (a launchd agent, a systemd unit) with `subs-node start`. Windows: use Docker Desktop.

### Docker (Linux, Windows, macOS)

```sh
docker run -d --name subs-node --restart unless-stopped \
  -v subs-node:/data \
  -e SUBS_NAME="$(hostname)" \
  -e SUBS_TOKEN=sr_reg_… \
  ghcr.io/subsrocks/node:1
```

The token is used once, to join; the `subs-node` volume keeps the machine's place in the workspace after that, so it comes back after a restart or an update without a new token. `SUBS_NAME` is what the workspace calls it, which a container can't tell. `docker logs -f subs-node` shows what it's doing. With Docker Compose, see [`compose.yaml`](./compose.yaml).

- **With an NVIDIA graphics card**, add `--gpus all`. The machine needs NVIDIA's driver and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
- **With Intel or AMD graphics** (Linux), add `--device /dev/dri`. The image has VA-API's drivers (Mesa's for AMD, Intel's media driver), and joins the groups that own the device, whatever their numbers on the host.
- **On a Mac**, prefer the program: Docker Desktop runs Linux in a virtual machine that can't reach the Mac's media engines, nor any graphics card on Windows.

## How it renders

```
subs.rocks node 1.1.0
✓ ffmpeg 7.1.5 · H.264 (media engine) · H.265 (media engine) · AV1 · ProRes (media engine)
✓ Apple M4 Max · 16 threads · 64 GB
✓ Encodes on Apple M4 Max's media engines
✓ Connected to subs.rocks as “Edit bay”
• Waiting for renders
• Rendering 17:44 at its own size → H.265 on the media engine
• In 4 pieces, 2 at once
  Rendering ████████████░░░░░░░░░░░░ 48% · 3 min left
✓ Rendered in 6 min · 3.9 GB
```

- **It finds out at start what the machine can do:** its ffmpeg, an encoder for each codec, and its video hardware. Each hardware encoder is tried on a few frames in every way a render can ask of it (a constant quality, a capped one, an average or a constant bitrate, 10 bits, ProRes 4444), with the arguments a render uses, and decoding there too. subs.rocks sends a render to the hardware only when it was seen to make all the render asks; the rest encode on the processor.

  | Hardware | Encodes | How it's reached |
  |---|---|---|
  | Apple silicon (VideoToolbox) | H.264, H.265, ProRes on chips with ProRes engines | The program on a Mac |
  | Intel Mac (VideoToolbox) | H.264, H.265 | The program on a Mac |
  | NVIDIA (NVENC) | H.264, H.265, AV1 on cards that have it | `--gpus all`, or the program on Linux |
  | Intel, AMD on Linux (VA-API) | H.264, H.265, AV1 where the chip has it | `--device /dev/dri`, or the program on Linux |

- **It renders in pieces at once where that's sooner.** One encoder keeps only a few threads busy, and one ffmpeg reads, draws the subtitles and converts frames one frame at a time. So a long render on a machine with threads to spare is cut into pieces on its frame grid, about one encoding for every four threads (as many as memory holds), two at once on video hardware, then joined and checked frame for frame, as subs.rocks's own machines join theirs; one that doesn't join is made whole. Measured on 16 threads, four pieces at once made 1.6 to 3.6 times one encoder's frames (x264, x265 and SVT-AV1, 1080p and 4K); on an NVIDIA L4, two made 1.7 to 1.85 times one's.
- **It uses the threads it may.** In a container limited with `--cpus` or `--memory`, it plans by those limits and tells each encoder how many threads to use: encoders size themselves by the host's processors otherwise, and a limited container runs them several times slower.
- It holds one connection to subs.rocks and takes **one render at a time**. Add several machines and the workspace's renders spread across them: the best one that's free takes each (one that encodes it on its hardware first, then the one with the most threads).
- Each render runs in a process of its own. Stopping the render in subs.rocks stops it here, ffmpeg and all.
- If the connection drops (a network blip, a subs.rocks deploy), it connects again and carries on with its render; subs.rocks waits three minutes for it before giving the render to another machine.

## What it sees

A node is a machine you run, so subs.rocks tells it only what a render needs:

- **A render's files, for that render.** The video, the subtitles to burn in and the template's fonts, named by the render's own names (`original`, `subtitles.ass`, `font-0`), and the file it writes (`render.mp4`). It reads and writes them over HTTPS with a token that works only for that render, only while it's this machine's. It can't reach anything else in storage.
- **Nothing else of the workspace.** Not the project's name, the workspace's other videos or its people, nor anything that would let it act as one of them.
- **Its own credential.** It joins with the token once and keeps a credential of its own in its data folder (`node.json`, readable by its user only), which only lets it connect and take renders. Removing the machine in Settings ends it at once.

The built-in fonts come from subs.rocks too (`/fonts/built-in.json`, checked by SHA-256 and kept in the data folder), so it draws what subs.rocks's editor previews.

## Commands

```
subs-node [start]   join a workspace (the first time, with --token) and wait for renders
subs-node doctor    check this machine can render
subs-node status    say which workspace it renders for
subs-node remove    leave the workspace and forget it
subs-node version
```

| Flag | Environment | |
|---|---|---|
| `--token <token>` | `SUBS_TOKEN` | The registration token, to join the first time |
| `--name <name>` | `SUBS_NAME` | What the workspace calls it; a Mac's name, or the host name, if not given |
| `--gpu auto\|off` | `SUBS_GPU` | Encode on the machine's video hardware when it has some (`auto`, the default) |
| `--ffmpeg <path>` | `SUBS_FFMPEG` | The ffmpeg to render with, its ffprobe beside it; if not given, the program's own on a Mac, else the `PATH`'s |
| `--data <dir>` | `SUBS_DATA` | Its credential, fonts and work: `/data` in the image, `~/.subs-node` otherwise |
| `--url <url>` | `SUBS_URL` | Where subs.rocks is (`https://subs.rocks`) |
| `--log pretty\|json` | `SUBS_LOG` | Lines for people, or one JSON object a line for a log collector |
| `--verbose` | `SUBS_VERBOSE=1` | Say more: the engine's own lines too |

Each machine needs its own data folder: two sharing one are one machine, and the second to connect stops the first.

**Stopping.** Ctrl-C finishes the render under way, then stops; press it again to stop at once, and the render goes to another machine. A `SIGTERM` (`docker stop`) gives the render back at once.

## Updating

The node says in its log when a newer version is out, and a machine too old to take today's renders shows **Update needed** in Settings.

- **Docker:** `docker pull ghcr.io/subsrocks/node:1`, then `docker rm -f subs-node` and run the command again (the volume keeps its place; no token needed). Tools that update containers for you work too. The `:1` tag follows every 1.x release.
- **The program:** run the install line again, then start it.

## When something's wrong

| What you see | What to do |
|---|---|
| `ffmpeg didn't run`, `can't draw subtitles: it needs libass` | On Linux, install ffmpeg 7 with libass; on a Mac, run the install line again (the program brings its own); or use the Docker image, which has it |
| `libass here picks fonts with macOS's font system` | An ffmpeg other than the program's (`--ffmpeg`) draws text a template's fonts can't in the Mac's fonts; leave `--ffmpeg` out |
| `Encoding on the CPU. To encode on the graphics card, give the container it` | Add `--gpus all` (NVIDIA) or `--device /dev/dri` (Intel, AMD) to `docker run` |
| `the NVIDIA GPU's encoders didn't work`, `the graphics' video encoders didn't work` | The driver (NVIDIA's, or VA-API's) isn't set up; renders encode on the processor meanwhile |
| `That registration token is wrong or has expired` | Tokens last an hour: make a new one with **Add a render machine** |
| `This machine was removed from its workspace` | Add it again from Settings, with a new token |
| `The workspace's plan doesn't include machines of its own` | It waits, and connects once the workspace is on Team or Studio |
| `subs.rocks needs a newer version of this node` | Update it |

## Building

```sh
pnpm install
pnpm build                       # dist/subs-node.mjs: run it with `node dist/subs-node.mjs`
node scripts/build.ts --sea      # dist/subs-node-<os>-<arch>, a single executable (Node.js 25.5+)
docker build -t subs-node .
pnpm test                        # needs ffmpeg
node scripts/ffmpeg.ts dist/ffmpeg   # on a Mac: the ffmpeg the program brings
```

CI builds the macOS ffmpeg for Apple silicon and Intel (once for each version of its script), runs the tests on Linux (x64 and arm64) and both Macs against the ffmpeg each renders with, and builds, installs and checks the program on each platform it's released for, as a release does; once a release is out, it installs and runs it from where people get it.

`src/job.ts` and `src/protocol.ts` are what a render is and how a node and subs.rocks talk; `src/engine` makes renders, `src/agent` is `subs-node`.

This repository is published from subs.rocks's own, where its code is changed and tested with the rest of the product; it's here to read, build and run. Issues are welcome; for changes, open an issue first.

## Security

See [SECURITY.md](./SECURITY.md) to report a vulnerability.

## License

[Apache License 2.0](./LICENSE). The image includes ffmpeg and other Debian packages under their own licenses. The macOS program includes an ffmpeg built by [`scripts/ffmpeg.ts`](./scripts/ffmpeg.ts), under the GPL (version 2 or later, as x264 and x265 make it); each release attaches the sources it's built from (`ffmpeg-sources.tar`).
