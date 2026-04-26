#!/usr/bin/env bash
# VirtualFS API — Quickstart (exec-only)
#
# Demonstrates the agent endpoint policy: all sandbox interaction goes through
# /exec-sync. The Files endpoints (PUT/GET /files, /writeFiles, /mkdir, /tree,
# /export) are banned — every read/write/list below uses bash via exec-sync.
#
# Usage: BASE_URL=... TOKEN=... bash quickstart.sh

set -euo pipefail

BASE_URL="${BASE_URL:?BASE_URL env var required (e.g. https://your-app.azurecontainerapps.io)}"
TOKEN="${TOKEN:?TOKEN env var required}"

SB=""
cleanup_sandbox() {
  if [[ -n "$SB" ]]; then
    curl -fsS -X DELETE "$BASE_URL/v1/sandboxes/$SB" \
      -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
    echo "Cleanup: deleted sandbox $SB"
  fi
}
trap cleanup_sandbox EXIT

exec_sync() {
  local script="$1"
  curl -fsS -X POST "$BASE_URL/v1/sandboxes/$SB/exec-sync" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg s "$script" '{script: $s}')"
}

echo "=== VirtualFS Quickstart (exec-only) ==="
echo "Base URL: $BASE_URL"
echo ""

# 1. Health check
echo "--- Health check ---"
curl -fsS "$BASE_URL/healthz" | jq
echo ""

# 2. Create sandbox — seed the initial file via the `files` field at creation
#    time. After creation, all further file ops go through exec.
echo "--- Creating sandbox (with seeded /home/user/hello.txt) ---"
SB=$(curl -fsS -X POST "$BASE_URL/v1/sandboxes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "files": { "/home/user/hello.txt": "Hello from VirtualFS!" }
  }' | jq -er '.id')
echo "Sandbox ID: $SB"
echo ""

# 3. Read the seeded file via exec (replaces GET /files/*path)
echo "--- Reading /home/user/hello.txt via exec ---"
exec_sync 'cat /home/user/hello.txt' | jq -r '.stdout'
echo ""

# 4. Write multiple files via a single exec heredoc batch
#    (replaces POST /writeFiles and PUT /files/*path)
echo "--- Bulk-writing files via exec heredocs ---"
exec_sync '
mkdir -p /home/user/sub
cat > /home/user/a.txt <<'\''EOF'\''
file A content
EOF
cat > /home/user/b.txt <<'\''EOF'\''
file B content
EOF
cat > /home/user/sub/c.txt <<'\''EOF'\''
nested file C
EOF
echo "wrote 3 files"
' | jq -r '.stdout'
echo ""

# 5. List the file tree via exec (replaces GET /tree)
echo "--- File tree via exec (find) ---"
exec_sync "find /home/user -mindepth 1 -printf '%y %s %p\n' | sort" | jq -r '.stdout'
echo ""

# 6. Search across files (this was always exec-native)
echo "--- Search across files ---"
exec_sync 'grep -rn "file" /home/user/ 2>/dev/null' | jq -r '.stdout'
echo ""

# 7. Shell state persists across exec-sync calls on the same warm session
echo "--- Shell state persistence ---"
exec_sync 'export MY_STATE=hello' >/dev/null
exec_sync 'echo MY_STATE=$MY_STATE' | jq -r '.stdout'
echo ""

# 8. Delete a file via exec (replaces DELETE /files/*path)
echo "--- Deleting /home/user/sub via exec (rm -rf) ---"
exec_sync 'rm -rf /home/user/sub && echo deleted' | jq -r '.stdout'
echo ""

# Cleanup runs via EXIT trap
echo "=== Done ==="
