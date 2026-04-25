# VirtualFS API — Skill Guide

This directory contains everything needed to use the VirtualFS API from Claude Code,
curl, Node.js, or the MCP integration.

## Quick links

| Resource | Path | What it covers |
|---|---|---|
| **Slash command** | `.claude/commands/virtualfs-api.md` | Invoke with `/virtualfs-api` in Claude Code |
| **Setup & Auth** | `SETUP.md` | Token generation, MCP config, env setup |
| **Endpoint reference** | `ref/endpoints.md` | All 12 routes with exact curl shapes |
| **Error codes** | `ref/errors.md` | HTTP → FS code table + debugging patterns |
| **Bash capabilities** | `ref/bash.md` | What just-bash supports / doesn't |
| **Quickstart** | `examples/quickstart.sh` | Full lifecycle in one script |
| **Codebase exploration** | `examples/ingest-explore.sh` | Load source files + grep/cat via bash |
| **SSE streaming** | `examples/sse-stream.sh` | Real-time script output |
| **MCP config** | `examples/mcp-config.json` | Paste into `~/.claude/settings.json` |

## Live deployment

```
BASE_URL  = https://virtualfs-api.redocean-7a422dd7.australiaeast.azurecontainerapps.io
Swagger   = $BASE_URL/docs
OpenAPI   = $BASE_URL/openapi.json
```

## 60-second start

```bash
# From the project root
export AUTH_SECRET="b882d28f4ddeb27d778c1f11e75ad96703ff3830b327dabd5c158e9942237d04"
export BASE_URL="https://virtualfs-api.redocean-7a422dd7.australiaeast.azurecontainerapps.io"
export TOKEN=$(AUTH_SECRET=$AUTH_SECRET pnpm token:create -- --sub admin --expires 30d 2>/dev/null | tail -1)

# Smoke test
BASE_URL=$BASE_URL TOKEN=$TOKEN bash .claude/virtualfs-api/examples/quickstart.sh
```

## How the skill works in Claude Code

Invoke `/virtualfs-api` in any Claude Code session inside this project. Claude will:

1. Load the skill prompt from `.claude/commands/virtualfs-api.md`
2. Read the relevant reference doc(s) from this directory based on the task
3. Produce working, copy-pasteable curl commands using the exact field names and
   response shapes from the live API

Sub-commands:
- `/virtualfs-api setup` — walk through auth and first sandbox
- `/virtualfs-api exec <script>` — generate exec-sync curl for the given script
- `/virtualfs-api ingest <local-path>` — generate ingest-files payload
- `/virtualfs-api explore` — explore the current sandbox tree
- `/virtualfs-api mcp` — show MCP config and tool reference

## Key facts to remember

1. **`ingest-files` vs `ingest`**: use `ingest-files` (base64 JSON) for source files.
   The tar.gz route runs `tar` inside just-bash — 3 Postgres round-trips per file,
   sequentially. At ~300 ms/file on Neon (AUS-East), >20 files hits the ACA 240s timeout.

2. **`writeFiles` vs `ingest-files`**:
   - `writeFiles` → plain text, **absolute** paths, no `basePath`
   - `ingest-files` → **base64** content, **relative** paths under `basePath`

3. **Session rehydration**: sandbox filesystem survives idle eviction (Postgres is durable).
   Shell state (env vars, cwd) resets after 10 min idle.

4. **Path in URL**: omit the leading `/` — `/files/home/user/file.txt` not `/files//home/...`.

5. **Runtime flags**: `python: true` / `javascript: true` must be set at `sandbox_create` time.
