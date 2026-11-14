#!/bin/sh
# Cloud volumes (Railway, Fly, Render) are mounted root-owned. Fix ownership once, then drop to the unprivileged user.
set -e
DATA="${TDC_DATA_DIR:-/data}"
mkdir -p "$DATA"
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA"
  chmod 700 "$DATA"
  exec su-exec node "$@"
fi
exec "$@"
