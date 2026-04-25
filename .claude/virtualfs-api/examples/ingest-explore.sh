#!/usr/bin/env bash
# VirtualFS API — Codebase ingest + exploration
#
# Loads TypeScript/JavaScript source files from a local directory into a
# sandbox, then runs a series of bash_exec calls to explore the codebase
# just like a coding agent would.
#
# Usage:
#   BASE_URL=... TOKEN=... SRC_DIR=./src bash ingest-explore.sh
#   BASE_URL=... TOKEN=... SRC_DIR=./src MAX_FILES=20 bash ingest-explore.sh

set -euo pipefail

BASE_URL="${BASE_URL:-https://virtualfs-api.redocean-7a422dd7.australiaeast.azurecontainerapps.io}"
TOKEN="${TOKEN:?TOKEN env var required}"
SRC_DIR="${SRC_DIR:?SRC_DIR env var required — path to local source directory}"
MAX_FILES="${MAX_FILES:-25}"    # keep under ACA 240s timeout (~2s/file on Neon)
SANDBOX_BASE_PATH="/home/user/src"

echo "=== VirtualFS Codebase Exploration ==="
echo "Source: $SRC_DIR"
echo "Max files per batch: $MAX_FILES"
echo ""

# ── Helper: run a bash script in the sandbox ──────────────────────────────────
exec_sync() {
  local script="$1"
  curl -s -X POST "$BASE_URL/v1/sandboxes/$SB/exec-sync" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg s "$script" '{script: $s}')" | jq -r '.stdout'
}

# ── 1. Create sandbox ─────────────────────────────────────────────────────────
echo "--- Creating sandbox ---"
SB=$(curl -s -X POST "$BASE_URL/v1/sandboxes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | jq -r '.id')
echo "Sandbox: $SB"
echo ""

# ── 2. Build ingest-files payload (base64, relative paths) ───────────────────
echo "--- Building ingest payload from $SRC_DIR ---"

# Collect .ts and .js files (recursive), cap at MAX_FILES
mapfile -t FILES < <(find "$SRC_DIR" -type f \( -name "*.ts" -o -name "*.js" \) \
  | grep -v node_modules | grep -v dist | head -n "$MAX_FILES")

echo "Files to ingest: ${#FILES[@]}"

# Build JSON payload using Node.js (handles binary-safe base64)
PAYLOAD=$(node -e "
const fs = require('fs');
const path = require('path');
const srcDir = process.argv[1];
const files = process.argv.slice(2);
const result = {};
for (const f of files) {
  const rel = path.relative(srcDir, f);
  result[rel] = fs.readFileSync(f).toString('base64');
}
process.stdout.write(JSON.stringify({ basePath: '$SANDBOX_BASE_PATH', files: result }));
" "$SRC_DIR" "${FILES[@]}")

echo "Payload size: $(echo -n "$PAYLOAD" | wc -c | tr -d ' ') bytes"
echo ""

# ── 3. Ingest ─────────────────────────────────────────────────────────────────
echo "--- Ingesting files (this takes ~2s/file on Neon) ---"
INGEST_RESULT=$(echo "$PAYLOAD" | curl -s -X POST "$BASE_URL/v1/sandboxes/$SB/ingest-files" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @-)
echo "Result: $INGEST_RESULT"
echo ""

# ── 4. Explore — just like a coding agent ────────────────────────────────────
echo "--- File tree ---"
exec_sync "find $SANDBOX_BASE_PATH -type f | sort"
echo ""

echo "--- Line counts ---"
exec_sync "find $SANDBOX_BASE_PATH -name '*.ts' | xargs wc -l 2>/dev/null | sort -rn | head -20"
echo ""

echo "--- Exported classes ---"
exec_sync "grep -rn 'export class' $SANDBOX_BASE_PATH 2>/dev/null"
echo ""

echo "--- Exported functions ---"
exec_sync "grep -rn 'export function\|export async function\|export const.*=' $SANDBOX_BASE_PATH 2>/dev/null | head -30"
echo ""

echo "--- Import graph (what imports what) ---"
exec_sync "grep -rn '^import' $SANDBOX_BASE_PATH 2>/dev/null | sed 's|$SANDBOX_BASE_PATH/||' | head -30"
echo ""

echo "--- TODO / FIXME comments ---"
exec_sync "grep -rn 'TODO\|FIXME\|HACK\|XXX' $SANDBOX_BASE_PATH 2>/dev/null" || true
echo ""

# ── 5. Interactive: run custom commands ───────────────────────────────────────
echo "--- Run your own commands (Ctrl+C to stop) ---"
echo "Sandbox: $SB"
echo "Files at: $SANDBOX_BASE_PATH"
echo ""
echo "Example:"
echo "  curl -s -X POST \"$BASE_URL/v1/sandboxes/$SB/exec-sync\" \\"
echo "    -H \"Authorization: Bearer \$TOKEN\" \\"
echo "    -H \"Content-Type: application/json\" \\"
echo "    -d '{\"script\": \"cat $SANDBOX_BASE_PATH/index.ts\"}' | jq -r '.stdout'"
echo ""

# ── 6. Cleanup prompt ─────────────────────────────────────────────────────────
read -p "Delete sandbox $SB? [y/N] " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  curl -s -X DELETE "$BASE_URL/v1/sandboxes/$SB" -H "Authorization: Bearer $TOKEN"
  echo "Sandbox deleted."
else
  echo "Sandbox kept. Delete later with:"
  echo "  curl -s -X DELETE \"$BASE_URL/v1/sandboxes/$SB\" -H \"Authorization: Bearer \$TOKEN\""
fi
