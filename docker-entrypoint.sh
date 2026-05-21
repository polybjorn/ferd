#!/bin/sh
# Atlas container entrypoint.
#
# Goal: bind-mounted ./data is writable by both the container and the host
# user, with no required configuration on the user's side.
#
# Target uid/gid resolution, in order:
#   1. Explicit PUID/PGID env vars (escape hatch for unusual setups).
#   2. Current owner of /data (typical case: host user ran `mkdir data`,
#      so adopting that uid keeps their ownership intact).
#   3. Default 1000:1000 (only when /data is fresh and root-owned).
#
# The atlas user inside the container is then re-numbered to match, and
# /data is chowned recursively only when there's a mismatch (cheap no-op
# on steady-state restarts).
set -eu

if [ -n "${PUID:-}" ] && [ -n "${PGID:-}" ]; then
  target_uid="$PUID"
  target_gid="$PGID"
else
  data_uid=$(stat -c %u /data 2>/dev/null || echo 0)
  data_gid=$(stat -c %g /data 2>/dev/null || echo 0)
  if [ "$data_uid" -ne 0 ]; then
    target_uid="$data_uid"
    target_gid="$data_gid"
  else
    target_uid=1000
    target_gid=1000
  fi
fi

current_gid=$(id -g atlas)
current_uid=$(id -u atlas)
if [ "$current_gid" != "$target_gid" ]; then
  groupmod -o -g "$target_gid" atlas
fi
if [ "$current_uid" != "$target_uid" ]; then
  usermod -o -u "$target_uid" atlas
fi

if [ "$(stat -c %u /data)" != "$target_uid" ] || [ "$(stat -c %g /data)" != "$target_gid" ]; then
  chown -R "$target_uid:$target_gid" /data
fi

exec /usr/bin/tini -- gosu atlas "$@"
