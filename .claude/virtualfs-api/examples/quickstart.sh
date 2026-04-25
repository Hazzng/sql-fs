#!/usr/bin/env bash
# VirtualFS API — Quickstart
# Complete lifecycle: create → write → exec → read → delete
# Usage: BASE_URL=... TOKEN=... bash quickstart.sh

set -euo pipefail

BASE_URL="${BASE_URL:-https://virtualfs-api.redocean-7a422dd7.australiaeast.azurecontainerapps.io}"
TOKEN="${TOKEN:?TOKEN env var required}"

echo "=== VirtualFS Quickstart ==="
echo "Base URL: $BASE_URL"
echo ""

# 1. Health check
echo "--- Health check ---"
curl -s "$BASE_URL/healthz" | jq
echo ""

# 2. Create sandbox
echo "--- Creating sandbox ---"
SB=$(curl -s -X POST "$BASE_URL/v1/sandboxes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | jq -r '.id')
echo "Sandbox ID: $SB"
echo ""

# 3. Write a file
echo "--- Writing /home/user/hello.txt ---"
curl -s -X PUT "$BASE_URL/v1/sandboxes/$SB/files/home/user/hello.txt" \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary "Hello from VirtualFS!"
echo "(204 = success)"
echo ""

# 4. Execute bash
echo "--- Executing bash ---"
curl -s -X POST "$BASE_URL/v1/sandboxes/$SB/exec-sync" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"script": "echo Hello && cat /home/user/hello.txt && echo && uname -a"}' | jq
echo ""

# 5. Bulk write multiple files
echo "--- Bulk writing files ---"
curl -s -X POST "$BASE_URL/v1/sandboxes/$SB/writeFiles" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "files": {
      "/home/user/a.txt": "file A content",
      "/home/user/b.txt": "file B content",
      "/home/user/sub/c.txt": "nested file C"
    }
  }'
echo "(204 = success)"
echo ""

# 6. List file tree
echo "--- File tree ---"
curl -s "$BASE_URL/v1/sandboxes/$SB/tree?prefix=/home/user" \
  -H "Authorization: Bearer $TOKEN" | jq '[.[] | {path, kind, size}]'
echo ""

# 7. Run grep across files
echo "--- Search across files ---"
curl -s -X POST "$BASE_URL/v1/sandboxes/$SB/exec-sync" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"script": "grep -r \"file\" /home/user/ 2>/dev/null"}' | jq -r '.stdout'
echo ""

# 8. Shell state persists
echo "--- Shell state persistence ---"
curl -s -X POST "$BASE_URL/v1/sandboxes/$SB/exec-sync" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"script": "export MY_STATE=hello"}' > /dev/null

curl -s -X POST "$BASE_URL/v1/sandboxes/$SB/exec-sync" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"script": "echo MY_STATE=$MY_STATE"}' | jq -r '.stdout'
echo ""

# 9. Read a file back
echo "--- Reading file back ---"
curl -s "$BASE_URL/v1/sandboxes/$SB/files/home/user/hello.txt" \
  -H "Authorization: Bearer $TOKEN"
echo ""
echo ""

# 10. Cleanup
echo "--- Deleting sandbox ---"
curl -s -X DELETE "$BASE_URL/v1/sandboxes/$SB" \
  -H "Authorization: Bearer $TOKEN"
echo "Sandbox $SB deleted (204 = success)"
echo ""
echo "=== Done ==="
