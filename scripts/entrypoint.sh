#!/bin/sh
# The image's entrypoint: runs subs-node as its own user, `subs`, in the groups that own the
# graphics the container was given (`--device /dev/dri`), whose numbers differ from host to host,
# so it can encode on Intel's and AMD's graphics; NVIDIA's (`--gpus all`) need no group. Started as
# another user (`--user`), it runs as that one.
set -eu

if [ "$(id -u)" != 0 ]; then
  exec node /app/subs-node.mjs "$@"
fi

groups=""
for device in /dev/dri/renderD* /dev/dri/card*; do
  [ -e "${device}" ] || continue
  gid="$(stat -c %g "${device}")"
  case ",${groups}," in
    *",${gid},"*) ;;
    *) groups="${groups:+${groups},}${gid}" ;;
  esac
done
# A data folder from a host, or an older image, is made the node's to write.
chown subs:subs /data 2>/dev/null || true

export HOME=/data
if [ -n "${groups}" ]; then
  exec setpriv --reuid=subs --regid=subs --groups="${groups}" node /app/subs-node.mjs "$@"
fi
exec setpriv --reuid=subs --regid=subs --clear-groups node /app/subs-node.mjs "$@"
