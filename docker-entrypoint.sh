#!/bin/sh
# /data is a bind mount that Docker may have created as root, and files made by "docker compose exec" (which runs as
# root) end up owned by root too. Hand anything not owned by the unprivileged "node" user (uid 1000) back to it.
set -e
if [ "$(id -u)" = "0" ]; then
  find /data ! -user 1000 -exec chown node:node {} +
  exec su-exec node "$@"
fi
exec "$@"
