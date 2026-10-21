#!/bin/sh
# Installs subs-node, the subs.rocks node, from its latest release on GitHub:
#
#   curl -fsSL https://github.com/subsrocks/node/releases/latest/download/install.sh | sh
#
# It downloads the program for this machine (Linux or macOS, x64 or arm64), checks it against the
# release's SHA256SUMS, puts it in ~/.local/bin (SUBS_NODE_DIR to choose another folder), and
# checks the machine can render. SUBS_NODE_VERSION=1.2.3 installs that version instead of the
# latest, and SUBS_NODE_FROM=<url> installs from a folder of a release's files (CI tests the
# programs it builds so). Run it again to update.
#
# Every expansion is braced: macOS's sh reads `$name…` as a longer name than `name`.
set -eu

REPO="https://github.com/subsrocks/node"
DIR="${SUBS_NODE_DIR:-${HOME}/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { printf 'subs-node install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) fail "no program for $(uname -s): run the Docker image instead (see ${REPO})" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no program for $(uname -m): run the Docker image instead (see ${REPO})" ;;
esac

if [ -n "${SUBS_NODE_FROM:-}" ]; then
  base="${SUBS_NODE_FROM%/}"
elif [ -n "${SUBS_NODE_VERSION:-}" ]; then
  base="${REPO}/releases/download/v${SUBS_NODE_VERSION}"
else
  base="${REPO}/releases/latest/download"
fi
asset="subs-node-${os}-${arch}"

if command -v curl >/dev/null 2>&1; then
  get() { curl -fsSL --retry 3 -o "${2}" "${1}"; }
elif command -v wget >/dev/null 2>&1; then
  get() { wget -q -O "${2}" "${1}"; }
else
  fail "needs curl or wget"
fi

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

say "Downloading ${asset}…"
get "${base}/${asset}.tar.gz" "${work}/${asset}.tar.gz" || fail "couldn't download ${base}/${asset}.tar.gz"
get "${base}/SHA256SUMS" "${work}/SHA256SUMS" || fail "couldn't download ${base}/SHA256SUMS"

expected="$(grep " ${asset}.tar.gz\$" "${work}/SHA256SUMS" | cut -d ' ' -f 1)"
[ -n "${expected}" ] || fail "${asset}.tar.gz isn't in the release's SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${work}/${asset}.tar.gz" | cut -d ' ' -f 1)"
else
  actual="$(shasum -a 256 "${work}/${asset}.tar.gz" | cut -d ' ' -f 1)"
fi
[ "${expected}" = "${actual}" ] || fail "the download isn't the release's file (its SHA-256 differs)"

tar -xzf "${work}/${asset}.tar.gz" -C "${work}"
mkdir -p "${DIR}"
mv "${work}/${asset}" "${DIR}/subs-node.new"
chmod 0755 "${DIR}/subs-node.new"
mv "${DIR}/subs-node.new" "${DIR}/subs-node"
say "Installed $("${DIR}/subs-node" version) at ${DIR}/subs-node"

case ":${PATH}:" in
  *":${DIR}:"*) ;;
  *) say "Add ${DIR} to your PATH to run it as subs-node." ;;
esac

# What the machine needs yet, if anything (ffmpeg with libass, most often), and what's next.
say ""
"${DIR}/subs-node" doctor || true
