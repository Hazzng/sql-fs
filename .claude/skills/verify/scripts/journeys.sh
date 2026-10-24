#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)
cd "$repo"
S=.claude/skills/verify/scripts/stack.sh
command -v jq >/dev/null || { echo "journeys.sh needs jq on PATH" >&2; exit 2; }
doctor=$($S doctor) || { echo "$doctor"; exit 1; }
eval "$($S env)"

passed=0
eq() {
	(($# == 3)) || { echo "  FAIL eq got $# args (quoting bug): $*" >&2; exit 1; }
	if [[ "$1" == "$2" ]]; then passed=$((passed + 1)); echo "  ok   $3"
	else printf '  FAIL %s\n       expected: %q\n       actual:   %q\n' "$3" "$2" "$1" >&2; exit 1; fi
}
has() { [[ "$1" == *"$2"* ]] && eq yes yes "$3" || eq "$1" "*$2*" "$3"; }
api() { $S api "$@" 2>/dev/null; }
mcp() { $S mcp "$@" 2>/dev/null; }
absent() { EXPECT=404 api GET "$1" >/dev/null && echo absent; }
sql_value() { $S psql "$1" | sed -n 3p | tr -d ' '; }
new_sandbox() { api POST /v1/sandboxes --json '{"name":"verify"}' | jq -r .id; }
drop() { api DELETE "/v1/sandboxes/$1" >/dev/null; }

journey_auth() {
	eq "$(EXPECT=401 AS=none api GET /v1/sandboxes | jq -r .code)" AUTH_REQUIRED "no token -> 401 AUTH_REQUIRED"
	eq "$(EXPECT=403 AS=none api POST /v1/auth/bootstrap -H 'X-Auth-Secret: wrong' --json '{"sub":"boot"}' | jq -r .code)" FORBIDDEN "wrong secret -> 403"
	local token
	token=$(EXPECT=201 AS=none api POST /v1/auth/bootstrap -H "X-Auth-Secret: $AUTH_SECRET" --json '{"sub":"boot","expiresIn":"24h"}' | jq -r .token)
	eq "$(tr -cd . <<<"$token" | wc -c | tr -d ' ')" 2 "bootstrap issues a JWT"
	eq "$(EXPECT=200 AS=none api GET /v1/sandboxes -H "Authorization: Bearer $token" | jq -c .)" '{"sandboxes":[]}' "issued token is accepted"
}

journey_sandboxes() {
	local id
	id=$(EXPECT=201 api POST /v1/sandboxes --json '{"name":"verify","files":{"/home/user/seed.txt":"seed\n"}}' | jq -r .id)
	eq "$(api GET "/v1/sandboxes/$id/files/home/user/seed.txt")" seed "seed file persisted"
	eq "$(api GET "/v1/sandboxes/$id" | jq -c '{owner,name}')" '{"owner":"verify-agent","name":"verify"}' "metadata owner and name"
	eq "$(api GET /v1/sandboxes | jq --arg id "$id" '[.sandboxes[].id] | index($id) != null')" true "list contains sandbox"
	eq "$(api PATCH "/v1/sandboxes/$id" --json '{"python":true}' | jq -c '{python,javascript,network}')" '{"python":true,"javascript":false,"network":false}' "runtime update"
	eq "$(EXPECT=403 AS=intruder api GET "/v1/sandboxes/$id" | jq -r .code)" FORBIDDEN "other owner -> 403"
	eq "$(AS=intruder api GET /v1/sandboxes | jq '.sandboxes | length')" 0 "other owner lists nothing"
	has "$($S psql "select owner, python from sandboxes where id = '$id'")" "verify-agent | t" "row stored with owner and python"
	EXPECT=204 api DELETE "/v1/sandboxes/$id" >/dev/null
	eq "$(absent "/v1/sandboxes/$id")" absent "deleted sandbox -> 404"
	eq "$(sql_value "select count(*) from dirents where sandbox_id = '$id'")" 0 "no dirents remain"
}

journey_exec() {
	local id out
	id=$(new_sandbox)
	eq "$(api POST "/v1/sandboxes/$id/exec-sync" --json '{"script":"echo hi > /home/user/a.txt; cat /home/user/a.txt"}' | jq -c '{exitCode,stdout}')" '{"exitCode":0,"stdout":"hi\n"}' "exec-sync stdout and exit"
	eq "$(api GET "/v1/sandboxes/$id/files/home/user/a.txt")" hi "exec write persisted"
	eq "$(EXPECT=422 api POST "/v1/sandboxes/$id/exec-sync" --json '{"script":"echo x > /home/user/ro.txt","readOnly":true}' | jq -r .code)" EREADONLY_VIOLATION "read-only rejects mutation"
	eq "$(absent "/v1/sandboxes/$id/files/home/user/ro.txt")" absent "read-only left no file"
	out=$(api POST "/v1/sandboxes/$id/exec" --json '{"script":"printf stream-proof"}')
	has "$out" '"data":"stream-proof"' "SSE stdout event"
	eq "$(grep -c '^event: exit' <<<"$out")" 1 "exactly one SSE exit"
	has "$out" '"exitCode":0' "SSE exit code 0"
	eq "$(api POST "/v1/sandboxes/$id/exec-sync-batch" --json '{"scripts":[{"id":"a","script":"echo one"},{"id":"b","script":"echo two"}]}' | jq -c '[.results[]|[.id,.exitCode,.stdout]]')" '[["a",0,"one\n"],["b",0,"two\n"]]' "batch results"
	eq "$(EXPECT=408 api POST "/v1/sandboxes/$id/exec-sync" --json '{"script":"echo p > /home/user/p.txt; sleep 2; echo s > /home/user/s.txt","timeoutMs":100}' | jq -r .code)" EXEC_TIMEOUT "timeout -> 408"
	eq "$(api GET "/v1/sandboxes/$id/files/home/user/p.txt")" p "timeout kept prefix"
	eq "$(absent "/v1/sandboxes/$id/files/home/user/s.txt")" absent "timeout dropped suffix"
	trap 'SERVER_ENV="" $S restart --no-build >/dev/null' EXIT
	SERVER_ENV="SQL_FS_WORKERS_ENABLED=false" $S restart --no-build >/dev/null
	eq "$(api POST "/v1/sandboxes/$id/exec-sync" --json '{"script":"cat /home/user/a.txt"}' | jq -c '{exitCode,stdout}')" '{"exitCode":0,"stdout":"hi\n"}' "workers disabled: same result"
	SERVER_ENV="" $S restart --no-build >/dev/null
	trap - EXIT
	drop "$id"
}

journey_files() {
	local id
	id=$(new_sandbox)
	EXPECT=204 api POST "/v1/sandboxes/$id/mkdir" --json '{"path":"/home/user/v","recursive":true}' >/dev/null
	EXPECT=204 api PUT "/v1/sandboxes/$id/files/home/user/v/note.txt" --data-binary $'before\n' -H 'Content-Type: application/octet-stream' >/dev/null
	eq "$(api GET "/v1/sandboxes/$id/files/home/user/v/note.txt")" before "raw write read back"
	eq "$(api PATCH "/v1/sandboxes/$id/files/home/user/v/note.txt" --json '{"oldString":"before","newString":"after"}' | jq .replacements)" 1 "edit replacement count"
	eq "$(api GET "/v1/sandboxes/$id/files/home/user/v/note.txt")" after "edited bytes visible"
	EXPECT=204 api POST "/v1/sandboxes/$id/writeFiles" --json '{"files":{"/home/user/v/one.txt":"one\n","/home/user/v/two.txt":"two\n"}}' >/dev/null
	eq "$(api POST "/v1/sandboxes/$id/exec-sync" --json '{"script":"cat /home/user/v/one.txt /home/user/v/two.txt","readOnly":true}' | jq -r .stdout)" $'one\ntwo' "bulk write visible to bash"
	eq "$(api GET "/v1/sandboxes/$id/tree?prefix=/home/user/v&depth=3" | jq -c '[.[].path] | sort')" '["/home/user/v/note.txt","/home/user/v/one.txt","/home/user/v/two.txt"]' "tree lists files"
	EXPECT=204 api DELETE "/v1/sandboxes/$id/files/home/user/v/note.txt" >/dev/null
	eq "$(EXPECT=404 api GET "/v1/sandboxes/$id/files/home/user/v/note.txt" | jq -r .code)" ENOENT "deleted file -> ENOENT"
	drop "$id"
	$S suite ingress-queue
}

journey_ingest() {
	local id body
	id=$(new_sandbox)
	body="{\"basePath\":\"/home/user/in\",\"files\":{\"g.txt\":\"$(printf 'ingested\n' | base64)\",\"nested/two.txt\":\"$(printf 'two\n' | base64)\"}}"
	eq "$(api POST "/v1/sandboxes/$id/ingest-files" --json "$body" | jq -c .)" '{"status":"ok","fileCount":2}' "ingest reports fileCount"
	eq "$(api GET "/v1/sandboxes/$id/files/home/user/in/g.txt")" ingested "ingested top-level bytes"
	eq "$(api GET "/v1/sandboxes/$id/files/home/user/in/nested/two.txt")" two "ingested nested bytes"
	eq "$(api POST "/v1/sandboxes/$id/exec-sync" --json '{"script":"tar -czf - -C /home/user/in . | base64 -w 0","readOnly":true}' | jq -r .stdout | base64 -d | tar -tzf - | grep -E 'g.txt|two.txt' | sort | tr '\n' ' ')" "./g.txt ./nested/two.txt " "export archive round-trips"
	drop "$id"
}

journey_mcp() {
	local id write exec read
	id=$(new_sandbox)
	write=$(jq -nc --arg id "$id" '{id:$id,path:"/home/user/mcp.txt",content:"mcp-proof\n"}')
	exec=$(jq -nc --arg id "$id" '{id:$id,script:"cat /home/user/mcp.txt",readOnly:true}')
	read=$(jq -nc --arg id "$id" '{id:$id,path:"/home/user/mcp.txt"}')
	eq "$(mcp list | cut -f1 | sort | tr '\n' ' ')" "bash_exec bash_exec_batch file_edit file_read file_write fs_export fs_ingest sandbox_create sandbox_delete sandbox_list sandbox_update " "11 MCP tools"
	eq "$(mcp file_write "$write" | jq -c '{ok,size}')" '{"ok":true,"size":10}' "MCP file_write"
	eq "$(api GET "/v1/sandboxes/$id/files/home/user/mcp.txt")" mcp-proof "MCP write visible via REST"
	eq "$(mcp bash_exec "$exec" | jq -c '{exitCode,stdout}')" '{"exitCode":0,"stdout":"mcp-proof\n"}' "MCP bash reads it"
	eq "$(EXPECT=error AS=intruder mcp file_read "$read")" '{"ok":false,"error":"forbidden"}' "MCP file tool: other owner forbidden"
	eq "$(AS=intruder mcp bash_exec "$exec" | jq -c '{exitCode,stderr}')" '{"exitCode":1,"stderr":"forbidden"}' "MCP bash tool: other owner forbidden"
	drop "$id"
}

all=(auth sandboxes exec files ingest mcp)
for name in "${@:-${all[@]}}"; do
	declare -F "journey_$name" >/dev/null || { echo "unknown journey: $name (have: ${all[*]})" >&2; exit 2; }
	echo "== $name"
	"journey_$name"
done
echo "journeys passed: $passed assertions; transcript: $DIR/transcript.jsonl"
