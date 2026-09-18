#!/usr/bin/env bash
# Stop every replica, remove the Redis containers, drop the databases.
set -euo pipefail
source "$(dirname "$0")/env.sh"

for name in a b fault; do
  if [ -f "$LT_RUN/pid_$name" ]; then
    kill "$(cat "$LT_RUN/pid_$name")" 2>/dev/null && echo "stopped $name"
    rm -f "$LT_RUN/pid_$name"
  fi
done
# Anything the pidfiles missed.
pkill -f "dist/api/server.js" 2>/dev/null && echo "stopped stragglers" || true

docker rm -f lt-redis-shared lt-redis-fault >/dev/null 2>&1 && echo "removed redis containers" || true

for db in "$LT_DB_SHARED" "$LT_DB_FAULT"; do
  psql "$(lt_pg_url postgres)" -qc "DROP DATABASE IF EXISTS $db;" >/dev/null 2>&1 && echo "dropped $db" || true
done
rm -rf "$LT_RUN"
echo "done"
