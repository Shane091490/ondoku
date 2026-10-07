#!/bin/sh
# The voices folder is a bind mount that Docker may have created as root (and files can be left owned by root); hand
# anything not owned by the unprivileged user back to it, then drop to that user.
set -e
if [ "$(id -u)" = "0" ]; then
  find "$VOICES_DIR" ! -user 1000 -exec chown 1000:1000 {} +
  exec setpriv --reuid=1000 --regid=1000 --clear-groups "$@"
fi
exec "$@"
