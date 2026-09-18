#!/usr/bin/env bash
# Provision the harness: two Redis instances, two databases, migrations, three replicas.
# Idempotent — safe to re-run. Requires docker, psql, and a built dist/ (it will build).

set -euo pipefail
source "$(dirname "$0")/env.sh"
mkdir -p "$LT_RUN"

echo "==> building"
(cd "$LT_DIR/../.." && pnpm build >/dev/null)

echo "==> redis"
docker start lt-redis-shared >/dev/null 2>&1 || \
  docker run -d --name lt-redis-shared -p 6379:6379 redis:7-alpine >/dev/null
docker start lt-redis-fault >/dev/null 2>&1 || \
  docker run -d --name lt-redis-fault -p 6380:6379 redis:7-alpine >/dev/null
for i in $(seq 1 30); do
  redis-cli -p 6379 ping >/dev/null 2>&1 && redis-cli -p 6380 ping >/dev/null 2>&1 && break
  sleep 0.5
done
echo "    shared=6379 fault=6380"

echo "==> databases"
for db in "$LT_DB_SHARED" "$LT_DB_FAULT"; do
  psql "$(lt_pg_url postgres)" -qc "DROP DATABASE IF EXISTS $db;" >/dev/null
  psql "$(lt_pg_url postgres)" -qc "CREATE DATABASE $db;" >/dev/null
  # Migrations must run via tsx: runMigrations uses top-level await.
  cat > "$LT_RUN/mig_$db.mts" <<TS
import { runMigrations } from "$LT_DIR/../../src/api/migrations.js";
await runMigrations({ tenantIds: ["default"], getConnectionString: () => "$(lt_pg_url "$db")" });
TS
  (cd "$LT_DIR/../.." && npx tsx "$LT_RUN/mig_$db.mts" >/dev/null)
  echo "    $db migrated"
done

start_replica() { # name port db redis
  local name=$1 port=$2 db=$3 redis=$4
  if [ -f "$LT_RUN/pid_$name" ] && kill -0 "$(cat "$LT_RUN/pid_$name")" 2>/dev/null; then
    echo "    $name already running (pid $(cat "$LT_RUN/pid_$name"))"; return
  fi
  ( cd "$LT_DIR/../.."
    FS_BACKEND=postgres \
    DATABASE_URL="$(lt_pg_url "$db")" \
    REDIS_URL="$redis" \
    AUTH_SECRET="$LT_AUTH_SECRET" \
    PORT="$port" \
    ${LT_EXTRA_ENV:-} \
      nohup node --expose-gc --inspect=0 dist/api/server.js > "$LT_RUN/$name.log" 2>&1 &
    echo $! > "$LT_RUN/pid_$name" )
  echo "    $name on :$port"
}

echo "==> replicas"
start_replica a     "$LT_REPLICA_A"     "$LT_DB_SHARED" "$LT_REDIS_SHARED"
start_replica b     "$LT_REPLICA_B"     "$LT_DB_SHARED" "$LT_REDIS_SHARED"
start_replica fault "$LT_REPLICA_FAULT" "$LT_DB_FAULT"  "$LT_REDIS_FAULT"

echo "==> waiting for health"
for port in "$LT_REPLICA_A" "$LT_REPLICA_B" "$LT_REPLICA_FAULT"; do
  ok=""
  for i in $(seq 1 40); do
    if curl -fsS -m 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then ok=1; break; fi
    sleep 0.5
  done
  [ -n "$ok" ] && echo "    :$port ok" || { echo "    :$port FAILED — see $LT_RUN/*.log"; exit 1; }
done

echo "==> token"
(cd "$LT_DIR/../.." && AUTH_SECRET="$LT_AUTH_SECRET" node "$LT_DIR/lib/token.mjs" "$LT_OWNER" > "$LT_RUN/token")
echo "    $LT_RUN/token"

cat <<MSG

Ready.
  replica A (shared db+redis) : http://127.0.0.1:$LT_REPLICA_A
  replica B (shared db+redis) : http://127.0.0.1:$LT_REPLICA_B
  replica FAULT (isolated)    : http://127.0.0.1:$LT_REPLICA_FAULT
  logs                        : $LT_RUN/{a,b,fault}.log

Run a scenario:
  node scripts/loadtest/scenarios/load.mjs
  node scripts/loadtest/scenarios/concurrency.mjs
  node scripts/loadtest/scenarios/replica-steal.mjs
  node scripts/loadtest/scenarios/redis-storm.mjs

Tear down:  scripts/loadtest/down.sh
MSG
