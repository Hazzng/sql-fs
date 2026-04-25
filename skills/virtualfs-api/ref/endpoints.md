# VirtualFS API — Endpoint Reference

Live spec: `$BASE_URL/openapi.json` · Swagger UI: `$BASE_URL/docs`

All routes require `Authorization: Bearer <JWT>` unless noted.

---

## Admin

### POST /v1/admin/tokens — Create JWT

```bash
curl -s -X POST "$BASE_URL/v1/admin/tokens" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sub": "agent-1", "expiresIn": "7d"}' | jq
```

Request body:
```json
{
  "sub": "string (required) — token subject / owner identity",
  "expiresIn": "24h | 7d | 30d | 1y | never  (default: 30d)"
}
```

Response `201`:
```json
{ "token": "<jwt>", "sub": "agent-1", "expiresAt": "2026-05-02T..." }
```

---

## Sandbox Lifecycle

### POST /v1/sandboxes — Create sandbox

```bash
SB=$(curl -s -X POST "$BASE_URL/v1/sandboxes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "python": false,
    "javascript": false,
    "files": { "/home/user/hello.txt": "hello world" },
    "env":   { "NODE_ENV": "test" }
  }' | jq -r '.id')
```

All body fields are **optional**:

| Field | Type | Default | Description |
|---|---|---|---|
| `python` | boolean | false | Enable CPython WASM (`python3`/`python`) |
| `javascript` | boolean | false | Enable QuickJS WASM (`js-exec`/`node`) |
| `files` | `Record<absPath, string>` | — | Seed files (absolute path → plain text) |
| `env` | `Record<string, string>` | — | Default env vars for all exec calls |

Response `201`:
```json
{
  "id": "550e8400-...",
  "owner": "admin",
  "createdAt": "2026-04-25T...",
  "python": false,
  "javascript": false
}
```

**Important:** `python`/`javascript` must be set at creation. They cannot be changed later.

### GET /v1/sandboxes/:id — Get sandbox info

```bash
curl -s "$BASE_URL/v1/sandboxes/$SB" -H "Authorization: Bearer $TOKEN" | jq
```

Response `200`:
```json
{
  "id": "...", "owner": "admin", "createdAt": "...", "lastUsedAt": "...",
  "python": false, "javascript": false
}
```

### DELETE /v1/sandboxes/:id — Delete sandbox

```bash
curl -s -X DELETE "$BASE_URL/v1/sandboxes/$SB" -H "Authorization: Bearer $TOKEN"
# → 204 No Content
```

Permanently deletes the sandbox row, all inodes, dirents, and orphaned blobs.

---

## File Operations

> **Path encoding note:** omit the leading `/` after `/files/` in the URL.
> `/v1/sandboxes/$SB/files/home/user/hello.txt` — not `/home/user/hello.txt`.

### GET /v1/sandboxes/:id/files/*path — Read file

```bash
curl -s "$BASE_URL/v1/sandboxes/$SB/files/home/user/hello.txt" \
  -H "Authorization: Bearer $TOKEN"
# → raw bytes (text or binary)
```

Response headers include `X-FS-Stat: {"kind":1,"mode":420,"size":11,"mtime":"..."}`.

To save to local file: add `-o local-copy.txt`.

### PUT /v1/sandboxes/:id/files/*path — Write file

```bash
# Plain text
curl -s -X PUT "$BASE_URL/v1/sandboxes/$SB/files/home/user/hello.txt" \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary "hello world"

# Binary / local file
curl -s -X PUT "$BASE_URL/v1/sandboxes/$SB/files/home/user/image.png" \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary @/local/path/image.png
```

Response: `204 No Content`. Parent directories are created automatically.

### DELETE /v1/sandboxes/:id/files/*path — Delete file or directory

```bash
# Single file
curl -s -X DELETE "$BASE_URL/v1/sandboxes/$SB/files/home/user/hello.txt" \
  -H "Authorization: Bearer $TOKEN"

# Directory (must use recursive=true or it returns 409 ENOTEMPTY)
curl -s -X DELETE "$BASE_URL/v1/sandboxes/$SB/files/home/user/project?recursive=true" \
  -H "Authorization: Bearer $TOKEN"
```

Response: `204 No Content`.

### POST /v1/sandboxes/:id/mkdir — Create directory

```bash
curl -s -X POST "$BASE_URL/v1/sandboxes/$SB/mkdir" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path": "/home/user/project/src", "recursive": true}'
# → 204 No Content
```

| Field | Type | Required | Default |
|---|---|---|---|
| `path` | string | yes | — |
| `recursive` | boolean | no | false |

### POST /v1/sandboxes/:id/writeFiles — Bulk write (plain text, absolute paths)

```bash
curl -s -X POST "$BASE_URL/v1/sandboxes/$SB/writeFiles" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "files": {
      "/home/user/a.txt": "hello",
      "/home/user/b.txt": "world"
    }
  }'
# → 204 No Content
```

Values are **plain UTF-8 strings** (not base64). Keys are **absolute** paths.
Parent directories are created automatically. Best for small sets of text files.

### GET /v1/sandboxes/:id/tree — List file tree

```bash
# Full tree
curl -s "$BASE_URL/v1/sandboxes/$SB/tree" \
  -H "Authorization: Bearer $TOKEN" | jq

# Filtered by prefix
curl -s "$BASE_URL/v1/sandboxes/$SB/tree?prefix=/home/user" \
  -H "Authorization: Bearer $TOKEN" | jq '.[] | .path'
```

Response: array of `TreeEntry`:
```json
[
  { "path": "/home/user/hello.txt", "kind": "file", "size": 11, "mode": 420, "mtime": "..." },
  { "path": "/home/user",           "kind": "dir",  "size": 0,  "mode": 493, "mtime": "..." }
]
```

`kind` values: `"file"`, `"dir"`, `"symlink"`.

---

## Bash Execution

### POST /v1/sandboxes/:id/exec-sync — Buffered execution (use this for most cases)

```bash
curl -s -X POST "$BASE_URL/v1/sandboxes/$SB/exec-sync" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "script": "echo hello && ls /home/user",
    "cwd": "/home/user",
    "env": { "MY_VAR": "value" },
    "timeoutMs": 30000
  }' | jq
```

Request body:

| Field | Type | Required | Default | Max |
|---|---|---|---|---|
| `script` | string | yes | — | — |
| `cwd` | string | no | session cwd | — |
| `env` | `Record<string, string>` | no | — | — |
| `timeoutMs` | integer | no | 30 000 | 300 000 |

Response `200`:
```json
{ "stdout": "hello\n...", "stderr": "", "exitCode": 0 }
```

On timeout → `408 { "error": "timeout", "code": "EXEC_TIMEOUT" }`.

**Shell state persists** across exec-sync calls on the same sandbox (same warm Bash instance):
env vars set with `export`, cwd changes with `cd`, shell functions — all survive between calls.
State resets only after the session is evicted (10 min idle).

### POST /v1/sandboxes/:id/exec — SSE streaming execution

```bash
curl -N -s -X POST "$BASE_URL/v1/sandboxes/$SB/exec" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"script": "for i in 1 2 3; do echo $i; done"}'
```

SSE events emitted:

| Event | Data shape | When |
|---|---|---|
| `stdout` | `{"t":"stdout","data":"..."}` | Per chunk of stdout |
| `stderr` | `{"t":"stderr","data":"..."}` | Per chunk of stderr |
| `exit` | `{"t":"exit","exitCode":0,"durationMs":42}` | Script finished |
| `exit` (timeout) | `{"t":"exit","exitCode":-1,"error":"timeout","durationMs":...}` | Timed out |

Client disconnect cancels the script via `AbortController`.

---

## Ingest / Export

### POST /v1/sandboxes/:id/ingest-files — JSON manifest upload (PREFERRED)

Takes **base64-encoded** content and **relative** paths under a `basePath`.

```bash
# Build payload from local files
node -e "
const fs = require('fs'), path = require('path');
const srcDir = './src';
const files = {};
for (const f of fs.readdirSync(srcDir)) {
  files[f] = fs.readFileSync(path.join(srcDir, f)).toString('base64');
}
process.stdout.write(JSON.stringify({ basePath: '/home/user/src', files }));
" | curl -s -X POST "$BASE_URL/v1/sandboxes/$SB/ingest-files" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- | jq
# → {"status":"ok","fileCount":12}
```

Request body:
```json
{
  "basePath": "/home/user/project",
  "files": {
    "src/index.ts":   "<base64>",
    "src/types.ts":   "<base64>",
    "README.md":      "<base64>"
  }
}
```

**Performance:** ~2 s/file (3 Postgres round-trips per file: blob upsert, inode upsert, dirent
insert). Keep batches ≤ 25 files per request to stay under ACA's 240 s stream timeout.
For larger codebases, split into multiple calls by directory.

### POST /v1/sandboxes/:id/ingest — tar.gz upload

```bash
tar czf /tmp/project.tar.gz -C /path/to/project .
curl -s -X POST "$BASE_URL/v1/sandboxes/$SB/ingest" \
  -H "Authorization: Bearer $TOKEN" \
  -F "archive=@/tmp/project.tar.gz" \
  -F "basePath=/home/user/project" | jq
# → {"status":"ok","basePath":"/home/user/project"}
```

**Warning:** extraction runs `tar -xzf` inside just-bash. Each file costs ~3 DB round-trips
sequentially. For >20 files the ACA 240 s stream timeout will be hit. Use `ingest-files` instead.

### GET /v1/sandboxes/:id/export — Download as tar.gz

```bash
curl -s "$BASE_URL/v1/sandboxes/$SB/export?basePath=/home/user/project" \
  -H "Authorization: Bearer $TOKEN" \
  -o export.tar.gz

tar tzf export.tar.gz   # list contents
tar xzf export.tar.gz   # extract
```

`basePath` query param defaults to `/home/user`.

---

## Admin Maintenance

### POST /v1/admin/gc — Garbage collect orphaned blobs

```bash
curl -s -X POST "$BASE_URL/v1/admin/gc" \
  -H "Authorization: Bearer $TOKEN" | jq
# → {"deleted":0}
```

Deletes blobs whose `sha256` is no longer referenced by any inode (i.e. after sandbox deletion).
Safe to call at any time.

---

## Health (no auth required)

```bash
curl -s "$BASE_URL/healthz"   # → {"status":"ok"}
curl -s "$BASE_URL/readyz"    # → {"status":"ok"}
```
