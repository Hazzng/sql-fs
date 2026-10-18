#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

profile=${1:-standard}
if (( $# > 1 )) || [[ "$profile" != standard && "$profile" != architecture ]]; then
	echo 'Usage: bash scripts/verify-local.sh [standard|architecture]' >&2
	exit 2
fi

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
compose=("${compose_command[@]}" --env-file /dev/null -p "sqlfs-$run_id" -f infra/docker-compose.verify.yml)
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
pnpm --dir clients/typescript build
"${verify_env[@]}" node scripts/verify/contracts.mjs
"${verify_env[@]}" node scripts/verify/output-cap.mjs
"${verify_env[@]}" node scripts/verify/shutdown.mjs
"${verify_env[@]}" pnpm test:integration --reporter=default --reporter=json --outputFile="$evidence/integration.json"
node scripts/verify/assert-integration-report.mjs "$evidence/integration.json"
"${verify_env[@]}" node scripts/verify/sdk-clients.mjs

if [[ "$profile" == architecture ]]; then
	for suite in worker-failures sse-finalization input-budgets ingress-queue tenants; do
		"${verify_env[@]}" node "scripts/verify/$suite.mjs"
	done
fi
