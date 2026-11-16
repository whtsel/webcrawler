#!/bin/sh
# Prepare the votes directory, then drop privileges and start the server.
#
# Hosts mount volumes as root (Fly, Railway, Render disks), while the server
# should not run as root. Starting as root here and handing off with su-exec
# keeps both true, and keeps `docker run -v` working without extra setup.
set -e

DATA_DIR="$(dirname "${BBX_VOTES_FILE:-/data/votes.json}")"
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  exec su-exec node "$@"
fi

exec "$@"
