#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)
cd "$repo"
here="$repo/.claude/skills/verify/scripts"
runs="$repo/scripts/verify/.run"
pointer="$runs/current-stack"
secret=local-verification-secret-at-least-32-bytes

die() { echo "stack: $*" >&2; exit 1; }

set_compose() {
	read -r -a compose <<<"$COMPOSE"
	compose+=(--env-file /dev/null -p "$PROJECT" -f infra/docker-compose.verify.yml)
}

load_state() {
	local dir=${STACK_DIR:-}
	if [[ -z "$dir" ]]; then
		[[ -f "$pointer" ]] || die "no stack is up; run: $0 up"
		dir=$(cat "$pointer")
	fi
	[[ -f "$dir/state.env" ]] || die "missing $dir/state.env"
	# shellcheck disable=SC1091
	source "$dir/state.env"
	set_compose
}

deps_current() { cmp -s pnpm-lock.yaml node_modules/.pnpm/lock.yaml; }

ready() { curl -fsS "$BASE/readyz" 2>/dev/null | grep -q '"status":"ok"'; }

maybe_build() { [[ "${1:-}" == "--no-build" ]] || pnpm build >&2; }

server_alive() {
	[[ -n "${PID:-}" ]] && kill -0 "$PID" 2>/dev/null && ps -p "$PID" -o command= | grep -q "dist/api/server.js"
}

exec_in_stack_env() {
	exec env -i "PATH=$PATH" "HOME=$HOME" "DATABASE_URL=$DATABASE_URL" "REDIS_URL=$REDIS_URL" \
		"REDIS_DATA_URL=$REDIS_DATA_URL" "AUTH_SECRET=$AUTH_SECRET" "$@"
}

override_names() {
	local -a overrides=()
	read -r -a overrides <<<"${SERVER_ENV:-}"
	local kv
	for kv in ${overrides[@]+"${overrides[@]}"}; do printf '%s ' "${kv%%=*}"; done
}

start_server() {
	local -a overrides=()
	read -r -a overrides <<<"${SERVER_ENV:-}"
	(exec_in_stack_env "PORT=$PORT" ${overrides[@]+"${overrides[@]}"} node dist/api/server.js >>"$DIR/server.log" 2>&1) &
	PID=$!
	write_state
	local deadline=$((SECONDS + 60))
	until ready; do
		if ! kill -0 "$PID" 2>/dev/null; then tail -40 "$DIR/server.log" >&2; die "server exited before ready"; fi
		((SECONDS < deadline)) || { tail -40 "$DIR/server.log" >&2; die "server not ready in 60s"; }
		sleep 0.3
	done
}

write_state() {
	local built_head started_at
	built_head=$(git rev-parse --short HEAD)
	started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	(
		umask 077
		printf '%s=%q\n' DIR "$DIR" PROJECT "$PROJECT" COMPOSE "$COMPOSE" DATABASE_URL "$DATABASE_URL" \
			REDIS_URL "$REDIS_URL" REDIS_DATA_URL "$REDIS_DATA_URL" AUTH_SECRET "$AUTH_SECRET" PORT "$PORT" BASE "$BASE" \
			PID "$PID" SERVER_ENV "${SERVER_ENV:-}" BUILT_HEAD "$built_head" STARTED_AT "$started_at" >"$DIR/state.env"
	)
}

register_for_teardown() {
	DATABASE_URL="" REDIS_URL="" REDIS_DATA_URL="" AUTH_SECRET=$secret PORT="" BASE="" PID=""
	write_state
	echo "$DIR" >"$pointer"
}

stop_server() {
	server_alive || return 0
	kill -TERM "$PID"
	for _ in $(seq 1 100); do kill -0 "$PID" 2>/dev/null || return 0; sleep 0.1; done
	kill -KILL "$PID" 2>/dev/null || true
}

mint() {
	AUTH_SECRET=$AUTH_SECRET node dist/api/cli/token.js --sub "${1:-verify-agent}" ${2:+--tenant "$2"} --expires 24h
}

cmd_up() {
	[[ -f "$pointer" ]] && die "a stack is recorded at $(cat "$pointer"); reuse it ($0 doctor) or run: $0 down"
	command -v docker >/dev/null && docker info >/dev/null 2>&1 || die "Docker daemon is not running"
	[[ -d node_modules ]] || die "run pnpm setup:dev first"
	deps_current || die "node_modules does not match pnpm-lock.yaml; run: pnpm install --frozen-lockfile"
	local id="stack-$(date +%s)-$$"
	DIR="$runs/$id"
	PROJECT="sqlfs-$id"
	if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"; else COMPOSE="docker-compose"; fi
	mkdir -p "$runs"
	mkdir -m 700 "$DIR"
	set_compose
	register_for_teardown
	"${compose[@]}" up -d --wait --wait-timeout 120 >&2
	DATABASE_URL="postgres://sqlfs_app:sqlfs_app@$("${compose[@]}" port postgres 5432)/sqlfs"
	REDIS_URL="redis://$("${compose[@]}" port redis 6379)"
	REDIS_DATA_URL="redis://$("${compose[@]}" port redis-data 6379)"
	maybe_build "${1:-}"
	PORT=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
	BASE="http://127.0.0.1:$PORT"
	start_server
	echo "stack up: $BASE (pid $PID)"
	echo "evidence: $DIR"
}

cmd_restart() {
	local requested=${SERVER_ENV-__keep__}
	load_state
	[[ "$requested" == __keep__ ]] || SERVER_ENV=$requested
	maybe_build "${1:-}"
	stop_server
	echo "--- restart $(date -u +%Y-%m-%dT%H:%M:%SZ) overrides: $(override_names)" >>"$DIR/server.log"
	start_server
	echo "restarted: $BASE (pid $PID)"
}

cmd_doctor() {
	load_state
	local bad=0
	ok() { echo "ok    $*"; }
	fail() { echo "FAIL  $*"; bad=1; }
	warn() { echo "warn  $*"; }
	local states
	states=$("${compose[@]}" ps --format '{{.Service}}={{.Health}}' 2>/dev/null | sort | tr '\n' ' ')
	[[ "$states" == "postgres=healthy redis-data=healthy redis=healthy " ]] && ok "services: $states" || fail "services: ${states:-none}"
	server_alive && ok "server pid $PID runs dist/api/server.js" || fail "server pid ${PID:-?} not running (see $DIR/server.log)"
	if command -v lsof >/dev/null; then
		local owner
		owner=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1) || true
		[[ "$owner" == "$PID" ]] && ok "port $PORT owned by pid $PID" || fail "port $PORT listener is '${owner:-none}', expected $PID"
	fi
	ready && ok "GET /readyz ok" || fail "GET /readyz not ok"
	local code
	code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(mint doctor)" "$BASE/v1/sandboxes") || true
	[[ "$code" == 200 ]] && ok "minted token accepted (GET /v1/sandboxes 200)" || fail "GET /v1/sandboxes returned $code"
	deps_current && ok "node_modules matches pnpm-lock.yaml" ||
		fail "node_modules does not match pnpm-lock.yaml -> run: pnpm install --frozen-lockfile && $0 restart"
	local newer
	newer=$(find src \( -name '*.ts' -o -name '*.sql' \) -newer dist/api/server.js -not -path '*/tests/*' 2>/dev/null | head -3)
	if [[ -n "$newer" ]]; then
		fail "dist is stale; source changed after build: $(echo "$newer" | tr '\n' ' ') -> run: $0 restart"
	elif [[ dist/api/server.js -nt "$DIR/state.env" ]]; then
		warn "dist rebuilt after the server started; run: $0 restart --no-build"
	else
		ok "dist is current for src (server started $STARTED_AT, HEAD $BUILT_HEAD, now $(git rev-parse --short HEAD))"
	fi
	[[ -n "${SERVER_ENV:-}" ]] && echo "info  server env overrides (values hidden): $(override_names)"
	echo "base  $BASE"
	echo "dir   $DIR"
	return "$bad"
}

cmd_token() {
	load_state
	mint "$@"
}

cmd_api() {
	load_state
	(($# >= 2)) || die "usage: $0 api METHOD PATH [curl args...]   (env: AS=sub|none, TENANT=, EXPECT=status)"
	local method=$1 path=$2 as=${AS:-verify-agent}
	shift 2
	local -a auth=()
	[[ "$as" == none ]] || auth=(-H "Authorization: Bearer $(mint "$as" "${TENANT:-}")")
	local body status
	body=$(mktemp)
	status=$(curl -sS -X "$method" -o "$body" -w '%{http_code}' ${auth[@]+"${auth[@]}"} "$@" "$BASE$path")
	STACK_SECRET=$AUTH_SECRET node "$here/record.mjs" "$DIR/transcript.jsonl" "$method" "$path" "$status" "$as" "$body" "$@"
	cat "$body"
	[[ -s "$body" && "$(tail -c1 "$body" | od -An -c | tr -d ' ')" != '\n' ]] && echo
	rm -f "$body"
	echo "HTTP $status  $method $path" >&2
	local expect=${EXPECT:-2xx}
	if [[ "$expect" == 2xx ]]; then [[ "$status" == 2* ]] || die "expected 2xx, got $status"
	else [[ "$status" == "$expect" ]] || die "expected $expect, got $status"; fi
}

cmd_mcp() {
	load_state
	(($# >= 1)) || die "usage: $0 mcp list | $0 mcp TOOL '{json args}'   (env: AS=sub, EXPECT=error)"
	STACK_BASE=$BASE STACK_TOKEN=$(mint "${AS:-verify-agent}" "${TENANT:-}") STACK_AS=${AS:-verify-agent} STACK_TRANSCRIPT=$DIR/transcript.jsonl \
		STACK_SECRET=$AUTH_SECRET node "$here/mcp.mjs" "$@"
}

cmd_psql() {
	load_state
	(($# == 1)) || die "usage: $0 psql 'SQL'   (runs as the postgres superuser; bypasses RLS for inspection)"
	"${compose[@]}" exec -T postgres psql -U postgres -d sqlfs -v ON_ERROR_STOP=1 -c "$1"
}

suite_names() {
	echo integration
	grep -l "new LocalApiRun(" scripts/verify/*.mjs | grep -v '\.test\.mjs$' | xargs -n1 basename | sed 's/\.mjs$//'
}

cmd_suite() {
	load_state
	(($# >= 1)) || die "usage: $0 suite NAME [args]   (NAME: integration or a suite entry point in scripts/verify/)"
	local name=$1
	shift
	suite_names | grep -qx "$name" || die "$name is not a suite entry point (have: $(suite_names | tr '\n' ' '))"
	local -a suite_env=("VERIFY_ENV_FILE=none" "VERIFY_EVIDENCE_DIR=$DIR/suites" "VERIFY_PYTHON=$repo/clients/python/.venv/bin/python")
	mkdir -p "$DIR/suites"
	if [[ "$name" == integration ]]; then
		local report
		report="$DIR/suites/integration-$(date +%s).json"
		(exec_in_stack_env "${suite_env[@]}" pnpm test:integration --reporter=default --reporter=json --outputFile="$report" "$@")
		node scripts/verify/assert-integration-report.mjs "$report"
	else
		(exec_in_stack_env "${suite_env[@]}" node "scripts/verify/$name.mjs" "$@")
	fi
}

cmd_down() {
	load_state
	stop_server
	"${compose[@]}" logs --no-color >"$DIR/services.log" 2>&1 || true
	"${compose[@]}" down --volumes --remove-orphans >&2
	[[ -f "$pointer" && "$(cat "$pointer")" == "$DIR" ]] && rm -f "$pointer"
	echo "stack down; evidence kept at $DIR"
}

cmd=${1:-}
shift || true
case "$cmd" in
up | restart | doctor | token | api | mcp | psql | suite | down) "cmd_$cmd" "$@" ;;
env) load_state && cat "$DIR/state.env" ;;
*) die "usage: $0 {up [--no-build]|doctor|token [sub] [tenant]|api METHOD PATH ...|mcp TOOL JSON|psql SQL|suite NAME|restart [--no-build]|env|down}" ;;
esac
