# Implementation Plan: SQL-FS — Persistent Filesystem Backends + HTTP/MCP API

> PRD: [tasks/prd-sql-fs-api.md](./prd-sql-fs-api.md)
> V1 = 97 stories across Phases 1, 2, 3, 5, 6. Phase 4 is documented future roadmap (11 stories, not in V1).
> Each phase ends with a concrete verification step.

---

## Phase 1: Vertical Slice — SqlFs works with Postgres

**Goal:** Replace InMemoryFs with SqlFs backed by Postgres. Run existing just-bash comparison tests against it. If they pass, the filesystem is behaviorally correct.

**Stories:** 46 (US-001 through US-042, plus US-042a through US-042d)

### Step 1.1 — Types, Interface, Errors (Epic 1)

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-001 | SqlDialect interface definition | `src/fs/sql-fs/types.ts` | — |
| US-002 | Shared types (InodeRow, DirentRow, PathCacheEntry) | `src/fs/sql-fs/types.ts` | US-001 |
| US-003 | FS error constructors + SQL error translation | `src/fs/sql-fs/errors.ts` | — |

**Test after:** `pnpm typecheck` passes. No runtime tests yet — these are just types.

### Step 1.2 — Postgres Dialect: Connection & Sandbox (Epic 2)

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-004 | Postgres connection + setSandboxContext | `src/fs/sql-fs/dialects/postgres.ts` | US-001 |
| US-005 | createSandbox + deleteSandbox | `src/fs/sql-fs/dialects/postgres.ts` | US-004 |
| US-006 | createInode, getInode, updateInode, deleteInode | `src/fs/sql-fs/dialects/postgres.ts` | US-004 |
| US-007 | incrementNlink, decrementNlink | `src/fs/sql-fs/dialects/postgres.ts` | US-006 |

**Test after:**
```bash
docker run -d --name pg-test -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:16
pnpm test:run src/fs/sql-fs/dialects/postgres.test.ts
```

### Step 1.3 — Postgres Dialect: Dirent Operations (Epic 3)

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-008 | insertDirent | `src/fs/sql-fs/dialects/postgres.ts` | US-006 |
| US-009 | upsertDirent | `src/fs/sql-fs/dialects/postgres.ts` | US-008 |
| US-010 | deleteDirent | `src/fs/sql-fs/dialects/postgres.ts` | US-008 |
| US-011 | listDirents | `src/fs/sql-fs/dialects/postgres.ts` | US-008 |
| US-012 | moveDirent | `src/fs/sql-fs/dialects/postgres.ts` | US-008 |

**Test after:**
```bash
pnpm test:run src/fs/sql-fs/dialects/postgres.dirent.test.ts
```

### Step 1.4 — Postgres Dialect: Blobs, Bulk, Path Resolution (Epic 4)

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-013 | upsertBlob + getBlob | `src/fs/sql-fs/dialects/postgres.ts` | US-004 |
| US-014 | gcOrphanBlobs | `src/fs/sql-fs/dialects/postgres.ts` | US-013 |
| US-015 | loadAllPaths (recursive CTE) | `src/fs/sql-fs/dialects/postgres.ts` | US-005, US-008 |
| US-016 | loadSubtreeInodes | `src/fs/sql-fs/dialects/postgres.ts` | US-008 |
| US-017 | bulkIngest | `src/fs/sql-fs/dialects/postgres.ts` | US-008, US-013 |
| US-018 | fs_resolve stored procedure | `src/fs/sql-fs/migrations/0001_rls_and_procs.sql` | US-005, US-008 |

**Test after:**
```bash
pnpm test:run src/fs/sql-fs/dialects/postgres.blob.test.ts
pnpm test:run src/fs/sql-fs/dialects/postgres.resolve.test.ts
```

### Step 1.5 — SqlFs Caching Layer (Epics 5 + 6)

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-019 | pathCache init from loadAllPaths | `src/fs/sql-fs/sql-fs.ts` | US-015 |
| US-020 | pathCache update on writes | `src/fs/sql-fs/sql-fs.ts` | US-019 |
| US-021 | pathCache rebuild on mv | `src/fs/sql-fs/sql-fs.ts` | US-019 |
| US-022 | LRU content cache setup | `src/fs/sql-fs/sql-fs.ts` | — |
| US-023 | Content cache hit on readFile | `src/fs/sql-fs/sql-fs.ts` | US-022 |
| US-024 | Content cache invalidation on write/delete | `src/fs/sql-fs/sql-fs.ts` | US-022 |

**Test after:** Unit tests with a mocked dialect — no real DB needed:
```bash
pnpm test:run src/fs/sql-fs/sql-fs.cache.test.ts
```

### Step 1.6 — SqlFs Read Methods (Epic 7)

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-025 | stat + lstat | `src/fs/sql-fs/sql-fs.ts` | US-019 |
| US-026 | exists | `src/fs/sql-fs/sql-fs.ts` | US-019 |
| US-027 | readdir + readdirWithFileTypes | `src/fs/sql-fs/sql-fs.ts` | US-019 |
| US-028 | readFile + readFileBuffer | `src/fs/sql-fs/sql-fs.ts` | US-023 |
| US-029 | readlink | `src/fs/sql-fs/sql-fs.ts` | US-019 |
| US-030 | realpath | `src/fs/sql-fs/sql-fs.ts` | US-018 |

**Test after:**
```bash
pnpm test:run src/fs/sql-fs/sql-fs.read.test.ts
```

### Step 1.7 — SqlFs Write Methods (Epic 8)

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-031 | writeFile | `src/fs/sql-fs/sql-fs.ts` | US-009, US-013, US-020 |
| US-032 | appendFile | `src/fs/sql-fs/sql-fs.ts` | US-031 |
| US-033 | mkdir | `src/fs/sql-fs/sql-fs.ts` | US-008, US-020 |
| US-034 | rm (non-recursive) | `src/fs/sql-fs/sql-fs.ts` | US-010, US-020 |
| US-035 | rm (recursive) | `src/fs/sql-fs/sql-fs.ts` | US-016, US-034 |
| US-036 | mv | `src/fs/sql-fs/sql-fs.ts` | US-012, US-021 |
| US-037 | cp (single file) | `src/fs/sql-fs/sql-fs.ts` | US-006, US-008, US-020 |
| US-038 | cp (recursive directory) | `src/fs/sql-fs/sql-fs.ts` | US-037 |
| US-039 | link (hardlink) | `src/fs/sql-fs/sql-fs.ts` | US-007, US-008 |
| US-040 | symlink (default-deny) | `src/fs/sql-fs/sql-fs.ts` | US-006, US-008 |
| US-041 | chmod + utimes | `src/fs/sql-fs/sql-fs.ts` | US-006, US-020 |
| US-042 | resolvePath (sync, no DB) | `src/fs/sql-fs/sql-fs.ts` | — |

**Test after:**
```bash
pnpm test:run src/fs/sql-fs/sql-fs.write.test.ts
```

### Step 1.8 — Phase 1 Hardening Follow-ups

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-042a | readFile/readFileBuffer symlink semantics | `src/fs/sql-fs/sql-fs.ts` | US-028, US-030, US-040 |
| US-042b | hardlink-safe recursive rm | `src/fs/sql-fs/sql-fs.ts` | US-035, US-039 |
| US-042c | Extract inode kind constants | `src/fs/sql-fs/types.ts`, `src/fs/sql-fs/sql-fs.ts` | US-042 |
| US-042d | Extract parent directory validation helper | `src/fs/sql-fs/sql-fs.ts` | US-020, US-042c |

**Test after:**
```bash
pnpm test:run src/fs/sql-fs/
pnpm test:run src/fs/sql-fs/integration/postgres.test.ts
```

### Phase 1 Verification

```bash
# Requires local Postgres running (from step 1.2)

# 1. Run all SqlFs unit tests
pnpm test:run src/fs/sql-fs/

# 2. THE BIG TEST: run just-bash comparison tests against SqlFs
FS_BACKEND=postgres DATABASE_URL=postgres://postgres:test@localhost/postgres \
  pnpm test:comparison

# 3. Typecheck + lint
pnpm typecheck && pnpm lint:fix && pnpm knip
```

**If comparison tests pass → Phase 1 is complete. The filesystem is behaviorally correct.**

---

## Phase 2: HTTP API — curl it

**Goal:** API server running locally. Create sandbox, write files, execute bash, delete sandbox — all via curl.

**Stories:** 24 (US-053 through US-070, US-074 through US-076, plus US-057b, US-057c, and US-075a)

### Step 2.1 — Factory & Config (Epic 12)

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-053 | createSandboxFs factory | `src/fs/sql-fs/index.ts` | Phase 1 |
| US-054 | Env var configuration | `src/fs/sql-fs/index.ts` | US-053 |
| US-055 | destroySandbox function | `src/fs/sql-fs/index.ts` | US-053 |

### Step 2.2 — Server Bootstrap & Auth (Epic 13)

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-056 | Hono server + healthz/readyz | `src/api/server.ts` | — |
| US-057 | JWT/HMAC auth middleware | `src/api/auth.ts` | US-056 |
| US-057b | Token generation CLI (bootstrap) | `src/api/cli/token.ts` | US-057 |
| US-057c | Token generation admin endpoint | `src/api/routes/admin.ts` | US-057 |
| US-058 | Zod validation middleware | `src/api/validation.ts` | US-056 |

**Auth bootstrap flow:**
1. Deploy API with `AUTH_SECRET` env var
2. Generate initial admin token locally: `AUTH_SECRET=... pnpm token:create -- --sub admin --expires 1y`
3. Use that token to call `POST /v1/admin/tokens` to create tokens for agents
4. Hand agent tokens to clients via env var / MCP config / secrets manager

### Step 2.3 — Sandbox CRUD (Epic 14)

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-059 | POST /v1/sandboxes (create) | `api/src/routes/sandboxes.ts` | US-053, US-057 |
| US-060 | GET /v1/sandboxes/:id (info) | `api/src/routes/sandboxes.ts` | US-059 |
| US-061 | DELETE /v1/sandboxes/:id | `api/src/routes/sandboxes.ts` | US-055, US-059 |

### Step 2.4 — File Operations (Epic 15)

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-062 | GET files (read) | `api/src/routes/files.ts` | US-059 |
| US-063 | PUT files (write) | `api/src/routes/files.ts` | US-059 |
| US-064 | DELETE files | `api/src/routes/files.ts` | US-059 |
| US-065 | POST mkdir | `api/src/routes/files.ts` | US-059 |
| US-066 | POST writeFiles (bulk) | `api/src/routes/files.ts` | US-059 |
| US-067 | GET tree | `api/src/routes/files.ts` | US-059 |

### Step 2.5 — Bash Execution (Epic 16)

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-068 | POST exec-sync (buffered) | `api/src/routes/exec.ts` | US-059 |
| US-069 | POST exec (SSE streaming) | `api/src/routes/exec.ts` | US-068 |
| US-070 | Timeout enforcement | `api/src/routes/exec.ts` | US-068 |

### Step 2.6 — Session Manager (Epic 18)

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-074 | Get or create session | `api/src/session-manager.ts` | US-053 |
| US-075 | Idle eviction | `api/src/session-manager.ts` | US-074 |
| US-075a | pathCache memory budget | `api/src/session-manager.ts`, `src/fs/sql-fs/sql-fs.ts` | US-074 |
| US-076 | Explicit destroy | `api/src/session-manager.ts` | US-055, US-074 |

**Implementation notes:**
- Treat the session manager as `Map<sandboxId, Session>` where `Session` owns the warm `SqlFs`, `pathCache`, `contentCache`, warm `Bash`, `lastUsed`, `inFlight`, mutex, and lifecycle state.
- Enforce **one warm session per `sandboxId` per API process**. `getOrCreate()` must be single-flight so concurrent cache misses for the same sandbox do not create duplicate sessions.
- Expose `withSession(sandboxId, fn)` (or equivalent) and route all file/exec operations through it. Do not hand unguarded shared session objects to route handlers.
- Serialize **all same-sandbox operations** through a per-sandbox async mutex for Phase 2. This keeps warm Bash state and `SqlFs` caches coherent and guarantees later requests observe the cache updates from earlier completed requests.
- Track an estimated `pathCache` byte budget per session and default it to 50MB. Unlike `contentCache`, `pathCache` should not partially evict entries; if the full tree snapshot grows over budget, the session should stop being retained once idle rather than keeping an incomplete path index.
- Idle eviction must skip sessions with `inFlight > 0` or `state === "closing"`. Eviction drops in-memory state only; it must never delete backend data.
- Explicit destroy must mark the session closing, prevent new work from attaching, wait for in-flight work to finish, then remove the session and call `destroySandbox(...)`.
- This provides same-process cache correctness for concurrent requests to the same sandbox. Cross-instance/pod concurrency is still a later concern and requires additional invalidation/coordination beyond Phase 2.

### Phase 2 Verification

```bash
# Start server
FS_BACKEND=postgres DATABASE_URL=... AUTH_SECRET=my-secret-key pnpm dev

# In another terminal:

# Step 1: Generate admin token locally (bootstrap)
TOKEN=$(AUTH_SECRET=my-secret-key pnpm token:create -- --sub admin --expires 30d)
echo "Admin token: $TOKEN"

# Step 2: Use admin token to create an agent token via API
AGENT_TOKEN=$(curl -s -X POST http://localhost:8080/v1/admin/tokens \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sub": "agent-1", "expiresIn": "7d"}' | jq -r '.token')
echo "Agent token: $AGENT_TOKEN"

# Step 3: Use agent token for all sandbox operations
SB=$(curl -s -X POST http://localhost:8080/v1/sandboxes \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" | jq -r '.id')
echo "Sandbox: $SB"

# Write a file
curl -X PUT "http://localhost:8080/v1/sandboxes/$SB/files/home/user/hello.txt" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -d "hello world"

# Read it back
curl "http://localhost:8080/v1/sandboxes/$SB/files/home/user/hello.txt" \
  -H "Authorization: Bearer $AGENT_TOKEN"
# → hello world

# Execute bash
curl -s -X POST "http://localhost:8080/v1/sandboxes/$SB/exec-sync" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"script": "cat /home/user/hello.txt | wc -c"}' | jq
# → { "stdout": "12\n", "stderr": "", "exitCode": 0 }

# SSE streaming
curl -N -X POST "http://localhost:8080/v1/sandboxes/$SB/exec" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"script": "for i in 1 2 3; do echo $i; sleep 0.1; done"}'
# → event: stdout / event: exit

# List files
curl -s "http://localhost:8080/v1/sandboxes/$SB/tree?prefix=/home/user" \
  -H "Authorization: Bearer $AGENT_TOKEN" | jq

# Delete sandbox
curl -X DELETE "http://localhost:8080/v1/sandboxes/$SB" \
  -H "Authorization: Bearer $AGENT_TOKEN"

# Run API tests
pnpm test:run api/src/
```

**If all curl commands return expected results → Phase 2 is complete.**

---

## Phase 3: Ingest/Export + MCP — agents can use it

**Goal:** Full agent workflow: upload a project, run commands, download results. MCP tools work in MCP Inspector.

**Stories:** 9 (US-071 through US-073, US-077 through US-080, US-086, US-087 — US-081 through US-085 removed, covered by bash_exec)

### Step 3.1 — Ingest & Export (Epic 17)

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-071 | POST ingest (tar.gz upload) | `api/src/routes/ingest.ts` | Phase 2 |
| US-072 | POST ingest-files (JSON manifest) | `api/src/routes/ingest.ts` | Phase 2 |
| US-073 | GET export (tar.gz download) | `api/src/routes/ingest.ts` | Phase 2 |

### Step 3.2 — MCP Server (Epic 19)

5 tools total. File/dir operations are intentionally omitted — agents use `bash_exec` shell commands instead (cat, ls, mkdir, rm, mv, cp, etc.). The `bash_exec` description enumerates what just-bash supports and what it does not.

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-077 | MCP server setup + transport | `api/src/mcp/server.ts` | Phase 2 |
| US-078 | sandbox_create tool | `api/src/mcp/tools.ts` | US-077 |
| US-079 | sandbox_delete tool | `api/src/mcp/tools.ts` | US-077 |
| US-080 | bash_exec tool (with just-bash limitations in description) | `api/src/mcp/tools.ts` | US-077 |
| US-086 | fs_ingest tool | `api/src/mcp/tools.ts` | US-077 |
| US-087 | fs_export tool | `api/src/mcp/tools.ts` | US-077 |

**Removed tools (covered by bash_exec):** ~~US-081 file_read~~, ~~US-082 file_write~~, ~~US-083 file_delete~~, ~~US-084 dir_list~~, ~~US-085 dir_make~~

### Phase 3 Verification

```bash
# Ingest a local project
tar czf /tmp/project.tar.gz -C ./my-project .
SB=$(curl -s -X POST http://localhost:8080/v1/sandboxes \
  -H "Authorization: Bearer test" | jq -r '.id')

curl -X POST "http://localhost:8080/v1/sandboxes/$SB/ingest" \
  -H "Authorization: Bearer test" \
  -F "archive=@/tmp/project.tar.gz" \
  -F "basePath=/home/user/project"
# → { "status": "ok", "basePath": "/home/user/project" }

# Run commands against ingested project
curl -s -X POST "http://localhost:8080/v1/sandboxes/$SB/exec-sync" \
  -H "Authorization: Bearer test" \
  -d '{"script": "ls /home/user/project && wc -l /home/user/project/*.ts"}' | jq

# Export modified project
curl "http://localhost:8080/v1/sandboxes/$SB/export?basePath=/home/user/project" \
  -H "Authorization: Bearer test" -o export.tar.gz
tar tzf export.tar.gz  # verify contents

# Test MCP with Inspector
npx @modelcontextprotocol/inspector http://localhost:8080/mcp
# → list tools → call sandbox_create → bash_exec → file_read → sandbox_delete

# Or test MCP in Claude Code settings:
# Add to ~/.claude/settings.json:
# "mcpServers": { "just-bash": { "url": "http://localhost:8080/mcp" } }
# Then in Claude Code: use sandbox_create, bash_exec, etc.
```

**If tar.gz round-trip works + MCP Inspector shows all 10 tools working → Phase 3 is complete.**

---

## Phase 4: Future Roadmap — Additional Backends + Optional Runtimes

> **NOT IN V1.** This phase is documented in advance so the work is well-scoped when we return to it. The user story acceptance criteria in the PRD remain the source of truth — do not re-derive them. V1 ships after Phase 3 + Phase 5 (Container) + Phase 6 (Tests). Phase 4 is additive and unblocks no downstream phase.

**Goal (when revisited):** Additional SQL/FileShare backends are swappable via env var. Python + JavaScript WASM runtimes are opt-in per sandbox, with a process-wide Python semaphore preventing OOM.

**Stories:** 11 (US-043 through US-052, plus US-080a)

### Step 4.1 — MySQL Dialect (Epic 9) *(future)*

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-043 | MySQL connection + sandbox context | `src/fs/sql-fs/dialects/mysql.ts` | US-001 |
| US-044 | MySQL schema differences | `src/fs/sql-fs/migrations/mysql/` | US-043 |
| US-045 | MySQL fs_resolve procedure | `src/fs/sql-fs/migrations/mysql/` | US-043 |
| US-046 | MySQL all remaining CRUD | `src/fs/sql-fs/dialects/mysql.ts` | US-043 |

### Step 4.2 — Azure SQL Dialect (Epic 10) *(future)*

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-047 | Azure SQL connection + context | `src/fs/sql-fs/dialects/azure-sql.ts` | US-001 |
| US-048 | Azure SQL schema differences | `src/fs/sql-fs/migrations/azure-sql/` | US-047 |
| US-049 | Azure SQL fs_resolve procedure | `src/fs/sql-fs/migrations/azure-sql/` | US-047 |
| US-050 | Azure SQL all remaining CRUD | `src/fs/sql-fs/dialects/azure-sql.ts` | US-047 |

### Step 4.3 — Azure FileShare Backend (Epic 11) *(future)*

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-051 | FileShare sandbox dir creation | `src/fs/sql-fs/index.ts` | US-053 |
| US-052 | FileShare sandbox deletion | `src/fs/sql-fs/index.ts` | US-051 |

**Tradeoff reference:** `COMPARISON.md` documents why Postgres was chosen as the V1 default. Revisit when one of: (a) >10MB binary file workloads become common, (b) customer requirement forces Azure-native storage, (c) Azure Files Premium is already provisioned for another reason.

### Step 4.4 — Optional WASM Runtimes + Python Semaphore (US-080a) *(future)*

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-080a | Runtime opt-in + Python semaphore | `src/api/session-manager.ts`, routes, mcp tools | Phase 2 |

**Why deferred:** CPython WASM workers cost ~80MB RAM each (fresh per `python3` invocation, EXIT_RUNTIME). 100 concurrent Python-using sandboxes would peak at ~8GB, past the 2Gi ACA limit. V1 ships without runtimes; Phase 4.4 adds them with a global semaphore cap.

**Full implementation guide lives in the PRD under US-080a** — including `RuntimeOptions` shape, semaphore acquire/release with transfer-on-release to avoid counter races, regex word-boundary detection of `python3`/`python`, all call sites that must migrate to `execWithRuntimeThrottle`, and the exact `new Bash({ python: opts.python || undefined, javascript: opts.javascript || undefined })` pattern (use `|| undefined` because just-bash distinguishes `true` from `undefined`, treating `false` differently).

**Files to change when implementing:**
- `src/api/session-manager.ts` — `RuntimeOptions` interface, `Session.runtimeOptions`, semaphore state (`pythonInFlight`, `pythonWaiters`, `maxConcurrentPython`), private `acquirePythonSlot`/`releasePythonSlot`, public `execWithRuntimeThrottle`, updated `getOrCreate`/`withSession` signatures
- `src/api/routes/sandboxes.ts` — add `python?: boolean, javascript?: boolean` to `createBodySchema`; forward via `withSession(..., { python, javascript })`; include both in 201 response
- `src/api/routes/exec.ts` — migrate `session.bash.exec(...)` → `sessionManager.execWithRuntimeThrottle(session, ...)` in both exec-sync (line ~75) and SSE (line ~150) paths
- `src/api/routes/ingest.ts` — migrate all three `session.bash.exec(...)` sites (tar extract, tar pack, cleanup rm)
- `src/api/mcp/tools.ts` — add `python`/`javascript` params to `sandbox_create`; migrate `bash_exec` handler to `execWithRuntimeThrottle`; add the "Optional runtimes" subsection to the `bash_exec` description (only the runtime section — the rest is already accurate from the V1 description update)
- `CLAUDE.md` — add `MAX_CONCURRENT_PYTHON` to env var table
- `src/api/__tests__/session-manager.test.ts` — add semaphore tests (slot limit, queueing, throw safety, word-boundary regex, cache-hit ignores runtime opts)

### Phase 4 Verification (when revisited)

```bash
# --- 4.1/4.2/4.3: Additional backends ---
docker run -d --name mysql-test -e MYSQL_ROOT_PASSWORD=test -p 3306:3306 mysql:8
FS_BACKEND=mysql DATABASE_URL=mysql://root:test@localhost/test pnpm test:comparison

docker run -d --name mssql-test -e ACCEPT_EULA=Y -e SA_PASSWORD='Test1234!' \
  -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest
FS_BACKEND=azure-sql DATABASE_URL='Server=localhost;...' pnpm test:comparison

FS_BACKEND=azure-fileshare FS_MOUNT_PATH=/tmp/fileshare-test pnpm test:comparison
# All three: comparison tests PASS

# --- 4.4: Python/JS runtimes + semaphore ---
TOKEN=$(AUTH_SECRET=... pnpm token:create -- --sub admin --expires 30d)

# Python-enabled sandbox runs python3
SB=$(curl -s -X POST http://localhost:8080/v1/sandboxes \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"python": true}' | jq -r '.id')
curl -s -X POST "http://localhost:8080/v1/sandboxes/$SB/exec-sync" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"script": "python3 -c \"print(1+1)\""}' | jq
# → { "stdout": "2\n", "stderr": "", "exitCode": 0 }

# Default sandbox rejects python3
SB2=$(curl -s -X POST http://localhost:8080/v1/sandboxes \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" | jq -r '.id')
curl -s -X POST "http://localhost:8080/v1/sandboxes/$SB2/exec-sync" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"script": "python3 -c \"print(1)\""}' | jq
# → non-zero exitCode (command not found)

# Semaphore: create 6 Python sandboxes, kick off a 10s python script in each
# at roughly the same time. With MAX_CONCURRENT_PYTHON=5, exactly one should
# queue (wall-clock evidence: 6th result arrives ~10s after the first five).

pnpm test:run src/api/__tests__/session-manager.test.ts  # semaphore unit tests
pnpm typecheck
```

**Phase 4 is complete when:** comparison tests pass on all 4 backends AND the Python semaphore queues the (N+1)th concurrent Python script AND typecheck/unit tests green.

---

## Phase 5: Container + Deploy

**Goal:** Running on Azure Container Apps with Postgres (Neon or Azure SQL). Health checks pass. GC works.

**Stories:** 12 (US-088 through US-099)

### Step 5.1 — Container (Epic 20)

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-088 | Dockerfile (multi-stage) | `Dockerfile` | Phase 2 |
| US-089 | .dockerignore | `.dockerignore` | — |
| US-090 | ACA deployment YAML | `aca.yaml` | US-088 |
| US-091 | Startup migration runner | `api/src/server.ts` | Phase 2 |

### Step 5.2 — Migrations (Epic 21)

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-092 | Drizzle schema definition | `src/fs/sql-fs/schema.ts` | Phase 1 |
| US-093 | Postgres migration — tables | `src/fs/sql-fs/migrations/` | US-092 |
| US-094 | Postgres migration — RLS + procs | `src/fs/sql-fs/migrations/` | US-093 |
| US-095 | MySQL migration | `src/fs/sql-fs/migrations/mysql/` | US-092 |
| US-096 | Azure SQL migration | `src/fs/sql-fs/migrations/azure-sql/` | US-092 |

### Step 5.3 — Blob GC (Epic 22)

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-097 | GC via dialect method | Each dialect file | US-014 |
| US-098 | GC admin endpoint | `api/src/routes/admin.ts` | US-097 |
| US-099 | GC CLI command | `api/src/cli/gc.ts` | US-097 |

### Phase 5 Verification

```bash
# Build container
docker build -t just-bash-api .
docker images just-bash-api --format '{{.Size}}'
# → should be under 300MB

# Run container locally
docker run -p 8080:8080 \
  -e FS_BACKEND=postgres \
  -e DATABASE_URL=postgres://... \
  -e DATABASE_DIRECT_URL=postgres://... \
  -e AUTH_SECRET=test \
  just-bash-api

# Verify health
curl http://localhost:8080/healthz   # → {"status":"ok"}
curl http://localhost:8080/readyz    # → {"status":"ok"}

# Same curl smoke tests from Phase 2
SB=$(curl -s -X POST http://localhost:8080/v1/sandboxes \
  -H "Authorization: Bearer test" | jq -r '.id')
curl -s -X POST "http://localhost:8080/v1/sandboxes/$SB/exec-sync" \
  -H "Authorization: Bearer test" \
  -d '{"script": "echo hello from container"}' | jq
curl -X DELETE "http://localhost:8080/v1/sandboxes/$SB" \
  -H "Authorization: Bearer test"

# GC
curl -X POST http://localhost:8080/v1/admin/gc \
  -H "Authorization: Bearer admin-token" | jq
# → { "deleted": 0 }

# Deploy to ACA
az containerapp create --yaml aca.yaml
curl https://your-app.azurecontainerapps.io/healthz
```

**If container builds under 300MB, starts, passes health checks, and curl smoke test works → Phase 5 is complete.**

---

## Phase 6: Integration Test Suite

**Goal:** Full confidence. Automated tests covering all backends and API surfaces.

**Stories:** 6 (US-100 through US-105)

| Story | Title | File | Depends on |
|-------|-------|------|------------|
| US-100 | SqlFs integration — Postgres | `src/fs/sql-fs/integration/postgres.test.ts` | Phase 1 |
| US-101 | SqlFs integration — MySQL | `src/fs/sql-fs/integration/mysql.test.ts` | Phase 4 |
| US-102 | SqlFs integration — Azure SQL | `src/fs/sql-fs/integration/azure-sql.test.ts` | Phase 4 |
| US-103 | Comparison tests with SqlFs | `src/fs/sql-fs/integration/comparison.test.ts` | Phase 1 |
| US-104 | HTTP API e2e test | `api/src/__tests__/e2e.test.ts` | Phase 2 |
| US-105 | MCP tools e2e test | `api/src/__tests__/mcp.test.ts` | Phase 3 |

### Phase 6 Verification

```bash
# All integration tests (skips unavailable DBs)
pnpm test:run src/fs/sql-fs/integration/

# API + MCP e2e (uses in-memory backend, no DB needed)
pnpm test:run api/src/__tests__/

# Full comparison test suite on default backend
pnpm test:comparison

# Everything green
pnpm typecheck && pnpm lint:fix && pnpm knip
```

**If all tests pass → Phase 6 is complete. Ship it.**

---

## Summary

| Phase | Goal | Stories | Cumulative | Status | Verification |
|-------|------|---------|------------|--------|--------------|
| 1 | SqlFs + Postgres | 46 | 46 | V1 | `pnpm test:comparison` passes with SqlFs |
| 2 | HTTP API + Auth | 24 | 70 | V1 | token:create → admin/tokens → curl sandbox lifecycle |
| 3 | Ingest/Export + MCP | 9 | 79 | V1 | tar.gz round-trip + MCP Inspector (5 tools) |
| 4 | MySQL + Azure SQL + FileShare + WASM runtimes | 11 | — | **Future Roadmap** | see Phase 4 verification |
| 5 | Container + Deploy | 12 | 91 | V1 | running on ACA, healthz works |
| 6 | Integration tests | 6 | 97 | V1 | full test suite green |

V1 scope = Phases 1, 2, 3, 5, 6 (97 stories). Phase 4 is documented but deferred.

## Dependency Graph (phases)

```
Phase 1 (SqlFs + Postgres)
   |
   v
Phase 2 (HTTP API)
   |
   v
Phase 3 (MCP + Ingest)
   |
   v
Phase 5 (Container + Deploy)
   |
   v
Phase 6 (Integration Tests)  ← V1 ships here


Phase 4 (Future Roadmap — additional backends + WASM runtimes)
   • depends on Phase 1 (backends) and Phase 2 (runtimes)
   • additive — does not block any other phase
   • can be picked up any time after V1 ships
```

## Quick Reference: File Layout

```
src/fs/sql-fs/
  index.ts                  <- createSandboxFs factory + destroySandbox
  sql-fs.ts                 <- SqlFs class (IFileSystem + caching)
  types.ts                  <- SqlDialect interface + shared types
  schema.ts                 <- Drizzle schema
  errors.ts                 <- FS error constructors + translation
  dialects/
    postgres.ts             <- PostgresDialect
    postgres.test.ts
    mysql.ts                <- MySqlDialect
    mysql.test.ts
    azure-sql.ts            <- AzureSqlDialect
    azure-sql.test.ts
  migrations/
    0000_create_tables.sql
    0001_rls_and_procs.sql
    mysql/
    azure-sql/
  integration/
    postgres.test.ts
    mysql.test.ts
    azure-sql.test.ts
    comparison.test.ts
api/
  package.json
  drizzle.config.ts
  src/
    server.ts               <- Hono app + migration runner
    auth.ts                 <- Bearer token middleware
    validation.ts           <- Zod middleware
    session-manager.ts      <- Warm Bash instance pool
    errors.ts               <- HTTP error responses
    routes/
      sandboxes.ts          <- CRUD endpoints
      files.ts              <- File operation endpoints
      exec.ts               <- Bash execution endpoints
      ingest.ts             <- Ingest/export endpoints
      admin.ts              <- GC endpoint
    mcp/
      server.ts             <- MCP server
      tools.ts              <- Tool schemas + handlers
    cli/
      gc.ts                 <- GC CLI command
    __tests__/
      e2e.test.ts
      mcp.test.ts
Dockerfile
.dockerignore
aca.yaml
