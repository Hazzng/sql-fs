#!/usr/bin/env bash
# VirtualFS API — Upload a local folder via the JSON `ingest-files` route
#
# Walks SRC_DIR recursively, base64-encodes every file, posts one JSON manifest
# to /v1/sandboxes/$SB/ingest-files. The server commits the whole batch with a
# single bulk multi-row INSERT, so 100+ files typically complete in <1s.
#
# Stop-gap until the `pnpm push` CLI helper lands (see issue #16).
#
# Usage:
#   BASE_URL=... TOKEN=... SB=<sandbox-id> SRC_DIR=./src bash ingest-files.sh
#   BASE_URL=... TOKEN=... SB=<sandbox-id> SRC_DIR=./src BASE_PATH=/home/user/src bash ingest-files.sh

set -euo pipefail

BASE_URL="${BASE_URL:?BASE_URL env var required}"
TOKEN="${TOKEN:?TOKEN env var required}"
SB="${SB:?SB (sandbox id) env var required}"
SRC_DIR="${SRC_DIR:?SRC_DIR env var required — path to local directory to upload}"
BASE_PATH="${BASE_PATH:-/home/user/src}"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "SRC_DIR does not exist or is not a directory: $SRC_DIR" >&2
  exit 1
fi

echo "Uploading $SRC_DIR → sandbox $SB at $BASE_PATH"

# Build the JSON manifest with Node (recursive, base64, binary-safe).
# - skips symlinks so readFileSync cannot escape the selected tree
# - uses Object.create(null) so filenames like "__proto__" are preserved
# - normalizes keys to POSIX separators so the manifest is portable across OSes
node -e '
  const fs = require("fs"), path = require("path");
  const dir = process.argv[1], base = process.argv[2];
  const out = Object.create(null);
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const rel = path.relative(dir, p).split(path.sep).join("/");
      out[rel] = fs.readFileSync(p).toString("base64");
    }
  })(dir);
  process.stdout.write(JSON.stringify({ basePath: base, files: out }));
' "$SRC_DIR" "$BASE_PATH" \
| curl -fsS -X POST "$BASE_URL/v1/sandboxes/$SB/ingest-files" \
       -H "Authorization: Bearer $TOKEN" \
       -H "Content-Type: application/json" \
       --data-binary @- \
       -w '\nstatus=%{http_code} time=%{time_total}s\n'
