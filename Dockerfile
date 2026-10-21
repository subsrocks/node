# The subs.rocks node: ffmpeg (with libass, x264, x265, SVT-AV1 and NVENC) and Node.js, running
# `subs-node`. Debian trixie's ffmpeg, the one subs.rocks's own render machines run, so a render
# made here draws its subtitles exactly as one made there.
#
#   docker build -t subs-node .
#   docker run -d --name subs-node --restart unless-stopped -v subs-node:/data \
#     -e SUBS_TOKEN=sr_reg_… subs-node
#
# Add `--gpus all` (with NVIDIA's Container Toolkit) to encode on the machine's NVIDIA GPU.
#
# Docker's official images from AWS's public copy of them, not Docker Hub, whose pull limits fail
# builds; same images, same tags.
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-trixie-slim
ARG RUNTIME_IMAGE=public.ecr.aws/docker/library/debian:trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /node
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

FROM ${NODE_IMAGE} AS node

FROM ${RUNTIME_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=build /node/dist/subs-node.mjs /app/subs-node.mjs
COPY LICENSE /app/LICENSE
# Its own user, and the volume it keeps its credential, fonts and work in (owned by that user, so
# a named volume is too).
RUN useradd --system --uid 10001 --home-dir /data subs \
 && mkdir -p /data && chown subs /data \
 && ln -s /app/subs-node.mjs /usr/local/bin/subs-node
USER subs
VOLUME /data
# What the NVIDIA Container Toolkit mounts for `--gpus all`: the driver's encoder and CUDA, and
# nvidia-smi.
ENV SUBS_CONTAINER=1 SUBS_DATA=/data NODE_ENV=production \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
LABEL org.opencontainers.image.title="subs.rocks node" \
      org.opencontainers.image.description="Render subs.rocks videos on machines of your own." \
      org.opencontainers.image.source="https://github.com/subsrocks/node" \
      org.opencontainers.image.licenses="Apache-2.0"
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/subs-node.mjs"]
CMD ["start"]
