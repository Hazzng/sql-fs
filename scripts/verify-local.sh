#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

command -v docker >/dev/null
if docker compose version >/dev/null 2>&1; then
	compose_command=(docker compose)
else
	docker-compose version >/dev/null
	compose_command=(docker-compose)
fi
docker info >/dev/null
test -x clients/python/.venv/bin/python || { echo 'Run pnpm setup:dev first.' >&2; exit 1; }

run_id="verify-$(date +%s)-$$"
evidence="$PWD/scripts/verify/.run/$run_id"
mkdir -p "$evidence"
compose=("${compose_command[@]}" --env-file /dev/null -p "sqlfs-$run_id" -f docker-compose.verify.yml)
cleanup() {
	result=$?
	trap - EXIT
	"${compose[@]}" logs --no-color > "$evidence/services.log" 2>&1 || true
	"${compose[@]}" down --volumes --remove-orphans || result=1
	echo "Verification evidence: $evidence"
	exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${compose[@]}" up -d --wait --wait-timeout 120
postgres_address=$("${compose[@]}" port postgres 5432)
redis_address=$("${compose[@]}" port redis 6379)
redis_data_address=$("${compose[@]}" port redis-data 6379)

verify_env=(env -i "PATH=$PATH" "HOME=$HOME"
	"DATABASE_URL=postgres://sqlfs_app:sqlfs_app@$postgres_address/sqlfs"
	"REDIS_URL=redis://$redis_address" "REDIS_DATA_URL=redis://$redis_data_address"
	"AUTH_SECRET=local-verification-secret-at-least-32-bytes"
	"VERIFY_ENV_FILE=none" "VERIFY_EVIDENCE_DIR=$evidence"
	"VERIFY_PYTHON=$PWD/clients/python/.venv/bin/python")

pnpm build
"${verify_env[@]}" node scripts/verify/contracts.mjs
"${verify_env[@]}" pnpm test:integration --reporter=default --reporter=json --outputFile="$evidence/integration.json"
node --input-type=module - "$evidence/integration.json" <<'JS'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.ok(report.numPassedTests > 0, "Integration tests must execute");
assert.equal(report.numFailedTests, 0, "Integration tests must pass");
assert.equal(report.numPendingTests, 0, "Integration tests must not silently skip");
JS
"${verify_env[@]}" node scripts/verify/sdk-clients.mjs
