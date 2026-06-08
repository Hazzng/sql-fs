# SQL-FS API — Endpoint Reference

Live spec: `$BASE_URL/openapi.json` · Swagger UI: `$BASE_URL/docs`

All routes require `Authorization: Bearer <JWT>` unless noted.

> ## ⛔ Agent endpoint policy
> Agents must interact with sandboxes **exclusively via the Exec endpoints**
> (`POST /exec-sync` and `POST /exec`). Every route under "File Operations" below is
> **banned** for agent use. Use exec equivalents (`cat`, `echo`, `mkdir -p`, `rm -rf`,
> `find`, `tar`) instead. See `SKILL.md` for the translation table.
>
> Allowed non-exec routes: sandbox lifecycle (`POST/GET/DELETE /v1/sandboxes`),
> `POST /ingest-files` (bulk bootstrap only), `POST /v1/auth/bootstrap`, `POST /v1/auth/bootstrap, POST /v1/auth/admin`.

---

## Auth

### POST /v1/auth/bootstrap — Mint JWT from AUTH_SECRET (no Bearer required)

Unauthenticated endpoint. Exchanges `AUTH_SECRET` (sent in `X-Auth-Secret`) for a signed JWT.
Use this when a client only has `AUTH_SECRET` and no pre-existing token.

```bash
export TOKEN=$(curl -fsS -X POST "$BASE_URL/v1/auth/bootstrap" \
  -H "X-Auth-Secret: $AUTH_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sub":"admin","expiresIn":"30d"}' | jq -er '.token')
```

Request body:
```json
{
  "sub":       "string (required) — token subject / owner identity",
  "tenant":    "string (optional) — tenant id; must match [A-Za-z0-9_.-]+",
  "expiresIn": "24h | 30d | 1y | never  (default: 30d)"
}
```

Response `201`:
```json
{ "token": "<jwt>", "sub": "admin", "tenant": null, "expiresAt": "2026-05-26T..." }
```

Error responses:
- `403 FORBIDDEN` — `X-Auth-Secret` missing or doesn't match server `AUTH_SECRET`
- `500 AUTH_NOT_CONFIGURED` — server has no `AUTH_SECRET` env var set
- `400 INVALID_INPUT` — body validation failed (missing `sub`, unknown tenant, invalid `expiresIn`)
- `429 RATE_LIMITED` — too many requests from this IP (default 5 / 60s, configurable via `BOOTSTRAP_RATE_LIMIT_*`). Response includes a `Retry-After` header (seconds).

Audit log shape (`auth_bootstrap_issued`):
```json
{"event":"auth_bootstrap_issued","ip":"1.2.3.4","ua":"curl/...","sub":"admin","tenant":null,"expiresIn":"30d","expiresAt":"2026-05-26T..."}
```

---

## Admin

### POST /v1/auth/admin — Create JWT

Requires both `Authorization: Bearer <admin-token>` AND `X-Admin-Secret: <ADMIN_SECRET>`
headers. The admin secret is a separate env-var from `AUTH_SECRET` and gates this
endpoint independently of JWT auth.

```bash
curl -fsS -X POST "$BASE_URL/v1/auth/admin" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sub": "agent-1", "expiresIn": "30d"}' | jq
```

Request body:
```json
{
  "sub":       "string (required) — token subject / owner identity",
  "tenant":    "string (optional) — tenant id; must match [A-Za-z0-9_.-]+",
  "expiresIn": "24h | 30d | 1y | never  (default: 30d)"
}
```

Response `201`:
```json
{ "token": "<jwt>", "sub": "agent-1", "tenant": null, "expiresAt": "2026-05-02T..." }
```

Issued tokens carry a `jti` (JWT ID) claim — a server-generated UUID that is also written
to the `admin_token_issued` audit log so a leaked token can be correlated back to its
issuance. The token string itself is **never** logged.

Error responses:
- `403 FORBIDDEN` — `X-Admin-Secret` missing or doesn't match server `ADMIN_SECRET`
- `500 ADMIN_NOT_CONFIGURED` — server has no `ADMIN_SECRET` env var set
- `500 AUTH_NOT_CONFIGURED` — server has no `AUTH_SECRET` env var set (cannot sign tokens)
- `400 INVALID_INPUT` — body validation failed (bad `sub`, unknown tenant, invalid `expiresIn`). Only checked **after** `X-Admin-Secret` validates; wrong secret returns 403, never 400.
- `429 RATE_LIMITED` — too many requests (default 5 / 60s per IP and per Bearer `sub`; either key tripping returns 429). Configurable via `ADMIN_RATE_LIMIT_*`. Response includes a `Retry-After` header (seconds).

Audit log shapes:
```json
{"event":"admin_token_issued","ts":"2026-04-28T...","caller":"admin","callerTenant":"default","sub":"agent-1","tenant":null,"expiresIn":"30d","expiresAt":"2026-05-28T...","jti":"<uuid>","ip":"1.2.3.4","ua":"curl/..."}
{"event":"admin_token_denied","ts":"...","caller":"admin","ip":"1.2.3.4","ua":"...","reason":"mismatch"}
{"event":"admin_token_misconfigured","ts":"...","caller":"admin","ip":"1.2.3.4","ua":"...","reason":"auth_secret_unset"}
{"event":"auth_rate_limited","ts":"...","scope":"admin","keys":["admin:ip:1.2.3.4","admin:sub:admin"],"trippedKey":"admin:ip:1.2.3.4","ip":"1.2.3.4","sub":"admin","path":"/v1/auth/admin"}
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
| `python` | boolean | false | Enable CPython WASM — registers `python3` (and `python` alias), stdlib only, isolated per call |
| `javascript` | boolean | false | Enable QuickJS WASM (`js-exec`/`node`) |
| `network` | boolean | false | Enable outbound `fetch()` from `js-exec` (see note below) |
| `files` | `Record<absPath, string>` | — | Seed files (absolute path → plain text) |
| `env` | `Record<string, string>` | — | Default env vars for all exec calls |

Response `201`:
```json
{
  "id": "550e8400-...",
  "owner": "admin",
  "createdAt": "2026-04-25T...",
  "python": false,
  "javascript": false,
  "network": false
}
```

**Important:** `python`/`javascript`/`network` must be set at creation. They cannot be changed later.

**`network: true` — outbound fetch() from js-exec**

When `network: true` is set (requires `javascript: true`), `fetch()` inside
`js-exec` scripts can reach external HTTP endpoints. The js-exec timeout
extends to 60 s automatically. The Bash shell itself remains air-gapped — no
`curl`, `wget`, DNS, or raw socket access — only `fetch()` inside `js-exec`
gains outbound HTTP. Defaults to `false` (secure-by-default, no egress).

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

> ⛔ **Banned for agent use.** Documented for reference only. Agents must use
> `exec-sync`/`exec` equivalents (see SKILL.md translation table). The routes below
> remain on the server for non-agent operators (CI tooling, admin scripts).

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
| `debug` | boolean | no | false | — |
| `readOnly` | boolean | no | false | — |

`readOnly`: when `true`, the script runs without acquiring the exclusive sandbox write-lock, allowing concurrent reads from multiple callers. Any mutating filesystem op in the script is rejected by the server with HTTP 422 `EREADONLY_VIOLATION` after the script returns. Use for pure read operations (grep, cat, find, wc, stat).

Response `200`:
```json
{ "stdout": "hello\n...", "stderr": "", "exitCode": 0 }
```

On timeout → `408 { "error": "timeout", "code": "EXEC_TIMEOUT" }`.
On read-only violation → `422 { "error": "read_only_violation", "code": "EREADONLY_VIOLATION", "details": [...] }`.

**Shell state persists** across exec-sync calls on the same sandbox (same warm Bash instance):
env vars set with `export`, cwd changes with `cd`, shell functions — all survive between calls.
State resets only after the session is evicted (10 min idle).

### POST /v1/sandboxes/:id/exec-sync-batch — Buffered batch execution

Run up to **50 scripts in one HTTP request**. Scripts run sequentially (write mode) or in parallel (read-only mode). Returns results for all scripts even if some time out.

```bash
curl -s -X POST "$BASE_URL/v1/sandboxes/$SB/exec-sync-batch" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "scripts": [
      {"id": "tree", "script": "find /home/user -type f | head -20"},
      {"id": "count", "script": "find /home/user -type f | wc -l"}
    ],
    "timeoutMs": 30000,
    "readOnly": true
  }' | jq
```

Request body:

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `scripts` | `Array<{id: string, script: string}>` | yes | — | |
| `timeoutMs` | integer | no | 30 000 | Outer ceiling for the whole batch |
| `perScriptTimeoutMs` | integer | no | — | Per-script independent budget; `timeoutMs` still caps the total |
| `readOnly` | boolean | no | false | |

**`perScriptTimeoutMs`**: when set, each script gets its own timeout instead of sharing `timeoutMs`. A slow script that hits its per-script limit returns `exitCode: -1, error: "timeout"` and the batch continues with the next script. `timeoutMs` still acts as the absolute outer ceiling. Useful for capability probes (`python3 -c 'import foo'` × N) where one slow import would otherwise exhaust the shared budget.

`readOnly`: same semantics as exec-sync — scripts run in parallel under a shared read-lock. Any mutating op returns `422 EREADONLY_VIOLATION`.

Response `200`:
```json
{
  "results": [
    {"id": "tree", "stdout": "...", "stderr": "", "exitCode": 0, "durationMs": 42},
    {"id": "count", "stdout": "12\n", "stderr": "", "exitCode": 0, "durationMs": 8}
  ]
}
```

Scripts that time out carry `exitCode: -1` and `error: "timeout"`. Without `perScriptTimeoutMs`, the `timeoutMs` budget is shared across all scripts combined.

### POST /v1/sandboxes/:id/exec — SSE streaming execution

```bash
curl -N -s -X POST "$BASE_URL/v1/sandboxes/$SB/exec" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"script": "for i in 1 2 3; do echo $i; done", "readOnly": false}'
```

Request body fields: `script` (required), `cwd`, `env`, `timeoutMs`, `debug`, `readOnly` — same semantics as exec-sync.

SSE events emitted:

| Event | Data shape | When |
|---|---|---|
| `stdout` | `{"t":"stdout","data":"..."}` | Per chunk of stdout |
| `stderr` | `{"t":"stderr","data":"..."}` | Per chunk of stderr |
| `exit` | `{"t":"exit","exitCode":0,"durationMs":42}` | Script finished |
| `exit` (timeout) | `{"t":"exit","exitCode":-1,"error":"timeout","durationMs":...}` | Timed out |
| `error` | `{"error":"read_only_violation","code":"EREADONLY_VIOLATION","details":[...]}` | Read-only violation or server error |

Client disconnect cancels the script via `AbortController`.

---

## Ingest

### POST /v1/sandboxes/:id/ingest-files — JSON manifest upload

The only ingest route. Takes **base64-encoded** content and **relative** paths under
a `basePath`. Walks the manifest with the dialect's bulk multi-row INSERT, so the
whole batch costs ~5 DB round-trips regardless of file count.

```bash
# Build payload from local files (recursive). Skips symlinks, uses a
# null-prototype object so keys like "__proto__" survive, normalizes manifest
# keys to POSIX separators so the payload works the same on Windows hosts.
node -e "
const fs = require('fs'), path = require('path');
const root = process.argv[1], base = process.argv[2];
const out = Object.create(null);
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    const rel = path.relative(root, p).split(path.sep).join('/');
    out[rel] = fs.readFileSync(p).toString('base64');
  }
})(root);
process.stdout.write(JSON.stringify({ basePath: base, files: out }));
" ./src /home/user/src \
| curl -s -X POST "$BASE_URL/v1/sandboxes/$SB/ingest-files" \
       -H "Authorization: Bearer $TOKEN" \
       -H "Content-Type: application/json" \
       --data-binary @- | jq
# → {"status":"ok","fileCount":37}
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

**Performance:** ~150 files / ~1 MB JSON typically completes in <100 ms server-side.
The previous "≤25 files per batch" rule no longer applies — the dialect now uses a
single bulk INSERT. Practical caps are HTTP body size and the 240 s ACA gateway window.

**Size limits:** the only ceiling is the request body — `MAX_REQUEST_BODY_BYTES`
(default 256 MB). Since base64 inflates content ~33%, that's ~190 MB of raw bytes
per call, across all files. Multi-MB files ingest fine and store byte-exact (a
single 128 MB file has been verified end-to-end). Individual files are buffered +
base64-decoded in memory, so very large files are memory- and time-heavy — prefer
splitting big payloads across several calls. (Clients such as the Python SDK also
enforce their own per-file ceiling — default 64 MB — *before* sending.)

> Fixed in this release: base64 validation previously overflowed V8's regex stack
> on strings beyond ~1 MB, so files larger than ~750 KB returned
> `500 INTERNAL_ERROR` during validation. Large-file ingest now succeeds.

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
