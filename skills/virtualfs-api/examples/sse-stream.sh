#!/usr/bin/env bash
# VirtualFS API — SSE streaming execution
#
# Demonstrates the POST /exec endpoint that streams stdout/stderr as
# Server-Sent Events in real time. Useful for long-running scripts.
#
# Usage: BASE_URL=... TOKEN=... [SB=<sandbox-id>] bash sse-stream.sh

set -euo pipefail

BASE_URL="${BASE_URL:?BASE_URL env var required}"
TOKEN="${TOKEN:?TOKEN env var required}"

CLEANUP=false

cleanup_sandbox() {
  if [[ "$CLEANUP" == "true" && -n "${SB:-}" ]]; then
    curl -fsS -X DELETE "$BASE_URL/v1/sandboxes/$SB" \
      -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
    echo "Cleanup: deleted sandbox $SB"
  fi
}
trap cleanup_sandbox EXIT

# ── Create a sandbox if SB is not set ─────────────────────────────────────────
if [[ -z "${SB:-}" ]]; then
  echo "Creating sandbox..."
  SB=$(curl -fsS -X POST "$BASE_URL/v1/sandboxes" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{}' | jq -er '.id')
  if [[ -z "$SB" || "$SB" == "null" ]]; then
    echo "Failed to create sandbox: SB='$SB'" >&2
    exit 1
  fi
  echo "Sandbox: $SB"
  CLEANUP=true
fi

echo ""
echo "=== SSE Streaming Example ==="
echo "Sandbox: $SB"
echo ""

# ── Example 1: Simple loop with progress ──────────────────────────────────────
echo "--- Counting with progress ---"
curl -N -fsS -X POST "$BASE_URL/v1/sandboxes/$SB/exec" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "script": "for i in 1 2 3 4 5; do echo Step $i of 5; done"
  }'
echo ""
echo ""

# ── Example 2: Parse SSE events with awk ──────────────────────────────────────
echo "--- Parsed SSE events ---"
curl -N -fsS -X POST "$BASE_URL/v1/sandboxes/$SB/exec" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "script": "echo stdout_line && echo error_line >&2 && exit 42"
  }' | awk '
    /^event:/ { event = $2 }
    /^data:/  {
      data = substr($0, 7)
      if (event == "stdout") print "[STDOUT] " data
      if (event == "stderr") print "[STDERR] " data
      if (event == "exit")   print "[EXIT]   " data
    }
  '
echo ""

# ── Example 3: Long-running with custom timeout ───────────────────────────────
echo "--- Long script with 60s timeout ---"
curl -N -fsS -X POST "$BASE_URL/v1/sandboxes/$SB/exec" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "script": "echo Starting && wc -l /home/user/src/*.ts 2>/dev/null | tail -1 && echo Done",
    "timeoutMs": 60000
  }'
echo ""
echo ""

# ── Example 4: Capture exit code from SSE stream ──────────────────────────────
echo "--- Capture exit code ---"
EXIT_CODE=$(curl -N -fsS -X POST "$BASE_URL/v1/sandboxes/$SB/exec" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"script": "exit 7"}' \
  | grep '^data:' | tail -1 | sed 's/^data: //' | jq -er '.exitCode')
echo "Exit code was: $EXIT_CODE"
echo ""

# ── SSE format reference ───────────────────────────────────────────────────────
cat <<'EOF'
=== SSE Event Format ===
Each event is:
  event: <type>
  data: <json>
  (blank line)

Types:
  stdout  → {"t":"stdout","data":"..."}
  stderr  → {"t":"stderr","data":"..."}
  exit    → {"t":"exit","exitCode":0,"durationMs":42}
  exit*   → {"t":"exit","exitCode":-1,"error":"timeout","durationMs":...}

Client disconnect (Ctrl+C) cancels the running script immediately.
EOF
echo ""
# Cleanup runs via EXIT trap
