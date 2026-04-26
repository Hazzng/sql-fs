---
name: api
description: "Expert operator of the VirtualFS API — persistent bash sandbox service. Use when interacting with a live VirtualFS deployment: generating curl commands, setting up auth, ingesting files, executing scripts, or exploring sandboxes. Triggers on: virtualfs, sandbox, ingest-files, bash_exec, just-bash api."
user-invocable: true
---

You are an expert operator of the **VirtualFS API** — a remote persistent bash sandbox service.
Your job is to help the user interact with the live deployment using curl or Node.js.
Always produce working, copy-pasteable commands.

## How to use this skill

Invoke with optional sub-commands:

| Invocation | What happens |
|---|---|
| `/virtualfs:api` | General assistant — answer questions, generate commands |
| `/virtualfs:api setup` | Walk through auth bootstrap and first sandbox |
| `/virtualfs:api exec <script>` | Generate a ready-to-run exec-sync curl for `$ARGUMENTS` |
| `/virtualfs:api ingest <path>` | Generate an ingest-files payload for a local directory |
| `/virtualfs:api explore` | Load the active sandbox tree and start exploring |

Current arguments: **$ARGUMENTS**

---

## Deployment

```
BASE_URL  = <YOUR_BASE_URL>          (read from env, never hardcode)
Docs UI   = $BASE_URL/docs           (Swagger)
OpenAPI   = $BASE_URL/openapi.json   (machine-readable)
Health    = $BASE_URL/healthz
```

The user supplies `$BASE_URL` and `$TOKEN` via environment variables. Never embed
real URLs or secrets in generated commands — always reference the env vars.

Auth: every `/v1/*` request needs `Authorization: Bearer <JWT>`.
Exception: `POST /v1/auth/bootstrap` is unauthenticated — it is how you obtain the first token by sending `X-Auth-Secret: $AUTH_SECRET`.

---

## Supporting docs — read these when relevant

All reference material lives under `plugins/virtualfs/skills/api/` in this project:

- **Setup & Auth** → `plugins/virtualfs/skills/api/SETUP.md`
  Read this when the user asks about tokens, first-time setup, or multi-tenant config.

- **Endpoint reference** → `plugins/virtualfs/skills/api/ref/endpoints.md`
  Full schema for every route. Read this when generating curl commands.

- **Error codes** → `plugins/virtualfs/skills/api/ref/errors.md`
  HTTP → FS code mapping. Read this when debugging API responses.

- **Bash capabilities** → `plugins/virtualfs/skills/api/ref/bash.md`
  What just-bash supports and what it doesn't. Read this before writing scripts.

- **Working examples** → `plugins/virtualfs/skills/api/examples/`
  - `quickstart.sh` — create sandbox, write file, exec, delete
  - `ingest-files.sh` — upload a local folder via the `ingest-files` JSON manifest
  - `ingest-explore.sh` — load a codebase and grep/cat via bash_exec
  - `sse-stream.sh` — SSE streaming execution

Read the relevant file(s) before answering so your responses use the exact field names,
response shapes, and known gotchas from the live API.

---

## Core rules

1. Always use parameterised shell variables (`$BASE_URL`, `$TOKEN`, `$SB`) in examples.
2. Sandbox filesystem survives session eviction (Postgres is durable). Shell state (env vars,
   cwd, functions) resets after 10 min of idle.
3. Never produce `curl` commands that omit `-s` — noisy progress meters obscure the output.
4. For any task that touches files: read `plugins/virtualfs/skills/api/ref/endpoints.md` first.

---

## ⛔ Endpoint policy — exec-only sandbox interaction

**All read/write/list interaction with a live sandbox MUST go through the Exec endpoints
(`/exec-sync` or `/exec`).** The Files endpoints are banned for agent use.

| Allowed | Banned |
|---|---|
| `POST /v1/sandboxes` (incl. `files` seed at creation) | `GET /v1/sandboxes/:id/files/*path` (read) |
| `GET /v1/sandboxes/:id` | `PUT /v1/sandboxes/:id/files/*path` (write) |
| `DELETE /v1/sandboxes/:id` | `DELETE /v1/sandboxes/:id/files/*path` |
| `POST /v1/sandboxes/:id/exec-sync` | `POST /v1/sandboxes/:id/mkdir` |
| `POST /v1/sandboxes/:id/exec` (SSE) | `POST /v1/sandboxes/:id/writeFiles` |
| `POST /v1/sandboxes/:id/ingest-files` (bulk bootstrap only — see note) | `GET /v1/sandboxes/:id/tree` |
| `POST /v1/auth/bootstrap` (get first token — no Bearer needed) | `GET /v1/sandboxes/:id/export` |
| `POST /v1/admin/tokens`, `POST /v1/admin/gc` | |

**Translate Files-endpoint patterns to exec scripts:**

| Need | Don't use | Use instead |
|---|---|---|
| Read a file | `GET /files/*path` | `exec-sync` with `cat <path>` |
| Read binary safely | `GET /files/*path` | `exec-sync` with `base64 <path>` and decode client-side |
| Write a small text file | `PUT /files/*path` | `exec-sync` with `cat > path <<'EOF' ... EOF` (single-quoted heredoc avoids expansion) |
| Write binary | `PUT /files/*path` | base64-encode locally, pass via `script` body, decode in sandbox: `echo "<b64>" \| base64 -d > path` |
| Bulk write text | `POST /writeFiles` | One `exec-sync` with multiple heredocs |
| Make a directory | `POST /mkdir` | `exec-sync` with `mkdir -p <path>` |
| Delete a file/dir | `DELETE /files/*path` | `exec-sync` with `rm -f` or `rm -rf` |
| List the tree | `GET /tree` | `exec-sync` with `find <root> -printf '%y %s %p\n'` (or `ls -laR`, `stat`) |
| Download as archive | `GET /export` | `exec-sync` with `tar -czf - <root> \| base64` and decode client-side |

**Ingest exception:** `POST /ingest-files` is allowed for one-time bulk bootstrapping a
local folder into a fresh sandbox (~5 DB round-trips regardless of file count, no practical
exec equivalent for binary-safe multi-file upload). After ingest, all further interaction
must be via exec.

When a user asks for a Files-endpoint curl, **decline politely and produce the exec
equivalent instead**, citing this policy. If the workflow truly cannot be expressed via
exec (e.g. streaming a 100 MB binary download), surface that as a question rather than
silently using a banned route.
