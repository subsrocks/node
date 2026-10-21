# subs.rocks node

Render your [subs.rocks](https://subs.rocks) videos on machines of your own: a workstation with a fast graphics card, an edit bay that's idle at night, a server in a rack. The node connects to your workspace and waits for renders; each one it makes costs nothing: no render minutes, no credits.

It's the same render engine subs.rocks runs on its own machines, so a render made here is the file subs.rocks would make: the same subtitles, drawn by the same libass with the same fonts, at the preset's settings.

Machines of your own come with the **Team** and **Studio** plans.

## Quick start

In subs.rocks, open **Settings › Your machines** and choose **Add a machine**. It gives you a command with a token in it, good for an hour on as many machines as you run it on.

### Docker (Linux, Windows, macOS)

```sh
docker run -d --name subs-node --restart unless-stopped \
  -v subs-node:/data \
  -e SUBS_TOKEN=sr_reg_… \
  ghcr.io/subsrocks/node:1
```

The token is used once, to join; the `subs-node` volume keeps the machine's place in the workspace after that, so it comes back after a restart or an update without a new token. `docker logs -f subs-node` shows what it's doing.

**With an NVIDIA graphics card**, add `--gpus all`: renders encode on the card, several times sooner (H.264 and H.265, and AV1 on cards that have it; ProRes always on the processor). The machine needs NVIDIA's driver and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html). With Docker Compose, see [`compose.yaml`](./compose.yaml).

### The program (Linux, macOS)

```sh
curl -fsSL https://github.com/subsrocks/node/releases/latest/download/install.sh | sh
subs-node start --token sr_reg_…
```

The installer puts `subs-node` in `~/.local/bin`, checked against the release's `SHA256SUMS`. The program needs **ffmpeg 7 or newer, built with libass**, on the machine: `brew install ffmpeg` on a Mac, your package manager's on Linux (Debian 13 and Ubuntu 25.04 have 7). `subs-node doctor` checks the machine and says what's missing. To keep it running, use your system's service manager (a systemd unit, a launchd agent) with `subs-node start`.

Windows: use Docker Desktop.

## What it does

```
subs.rocks node 1.0.0
✓ ffmpeg 7.1.1 · H.264 (GPU) · H.265 (GPU) · AV1 · ProRes
✓ AMD Ryzen 9 7950X · 32 threads · 64 GB · NVIDIA GeForce RTX 4090
✓ Joined the workspace as “Edit bay”
✓ Connected to subs.rocks as “Edit bay”
• Waiting for renders
• Rendering 12:04 at 3840×2160 → H.265 on the GPU
  Rendering ████████████░░░░░░░░░░░░ 48% · 3 min left
✓ Rendered in 6 min · 1.2 GB
```

- It finds out once, at start, what the machine can do: its ffmpeg, an encoder for each codec, and NVIDIA GPUs (each GPU encoder, and decoding on the GPU, tried on a few frames).
- It holds one connection to subs.rocks and takes **one render at a time**. Add several machines and the workspace's renders spread across them: the best one that's free takes each (one that encodes it on a graphics card first, then the one with the most threads).
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
| `--name <name>` | `SUBS_NAME` | What the workspace calls it; this machine's host name if not given |
| `--gpu auto\|off` | `SUBS_GPU` | Encode on an NVIDIA GPU when there is one (`auto`, the default) |
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
| `ffmpeg didn't run`, `can't draw subtitles: it needs libass` | Install ffmpeg 7 with libass, or use the Docker image, which has it |
| `ffmpeg can't decode on the GPU (CUDA)` | The NVIDIA driver or Container Toolkit isn't set up; renders encode on the processor meanwhile |
| `That registration token is wrong or has expired` | Tokens last an hour: make a new one with **Add a machine** |
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
```

`src/job.ts` and `src/protocol.ts` are what a render is and how a node and subs.rocks talk; `src/engine` makes renders, `src/agent` is `subs-node`.

This repository is published from subs.rocks's own, where its code is changed and tested with the rest of the product; it's here to read, build and run. Issues are welcome; for changes, open an issue first.

## Security

See [SECURITY.md](./SECURITY.md) to report a vulnerability.

## License

[Apache License 2.0](./LICENSE). The image includes ffmpeg and other Debian packages under their own licenses.
