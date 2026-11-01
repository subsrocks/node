# The subs.rocks node: ffmpeg (with libass, x264, x265, SVT-AV1, NVENC and VA-API), yt-dlp (for
# the linked videos subs.rocks's servers can't download) and Node.js, running `subs-node`. Debian trixie's ffmpeg, the one subs.rocks's own render machines run, so a
# render made here draws its subtitles exactly as one made there.
#
#   docker build -t subs-node .
#   docker run -d --name subs-node --restart unless-stopped -v subs-node:/data \
#     -e SUBS_TOKEN=sr_reg_… subs-node
#
# Add `--gpus all` (with NVIDIA's Container Toolkit) to encode on the machine's NVIDIA GPU, or
# `--device /dev/dri` for its Intel or AMD graphics (Linux).
#
# Docker's official images from AWS's public copy of them, not Docker Hub, whose pull limits fail
# builds; same images, same tags. AWS limits what each address pulls too, and CI runners share
# theirs: `--build-arg IMAGES=mirror.gcr.io/library` builds from Google's copy instead.
ARG IMAGES=public.ecr.aws/docker/library
ARG NODE_IMAGE=${IMAGES}/node:24-trixie-slim
ARG RUNTIME_IMAGE=${IMAGES}/debian:trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /node
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

FROM ${NODE_IMAGE} AS node

# yt-dlp's official self-contained build (Python inside), pinned and checked against the release's
# checksums: the release `src/agent/ytdlp.ts` names, which a node outside the image fetches for
# itself (a test keeps the two the same).
FROM ${RUNTIME_IMAGE} AS ytdlp
ARG TARGETARCH
ARG YTDLP_VERSION=2026.08.19
ARG YTDLP_SHA256_AMD64=58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a
ARG YTDLP_SHA256_ARM64=b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) asset=yt-dlp_linux; sum="${YTDLP_SHA256_AMD64}" ;; \
      arm64) asset=yt-dlp_linux_aarch64; sum="${YTDLP_SHA256_ARM64}" ;; \
      *) echo "no yt-dlp build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 -o /yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset}"; \
    echo "${sum}  /yt-dlp" | sha256sum -c -; \
    chmod 0755 /yt-dlp

FROM ${RUNTIME_IMAGE}
ARG TARGETARCH
# VA-API's drivers, for Intel's and AMD's graphics: Mesa's (AMD), and on amd64 Intel's, whose full
# encoders are in Debian's non-free part.
RUN sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini mesa-va-drivers \
    $([ "${TARGETARCH}" = amd64 ] && echo intel-media-va-driver-non-free) \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=ytdlp /yt-dlp /usr/local/bin/yt-dlp
COPY --from=build /node/dist/subs-node.mjs /app/subs-node.mjs
COPY LICENSE /app/LICENSE
COPY scripts/entrypoint.sh /app/entrypoint.sh
# Its own user, and the volume it keeps its credential, fonts and work in (owned by that user, so
# a named volume is too). It starts as root only to join the graphics' groups, then runs as this
# user (scripts/entrypoint.sh).
RUN useradd --system --uid 10001 --home-dir /data subs \
 && mkdir -p /data && chown subs /data \
 && ln -s /app/subs-node.mjs /usr/local/bin/subs-node
VOLUME /data
# What the NVIDIA Container Toolkit mounts for `--gpus all`: the driver's encoder and CUDA, and
# nvidia-smi.
ENV SUBS_CONTAINER=1 SUBS_DATA=/data NODE_ENV=production \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
LABEL org.opencontainers.image.title="subs.rocks node" \
      org.opencontainers.image.description="Render subs.rocks videos on machines of your own." \
      org.opencontainers.image.source="https://github.com/subsrocks/node" \
      org.opencontainers.image.licenses="Apache-2.0"
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["start"]
