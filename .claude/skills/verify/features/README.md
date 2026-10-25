# sql-fs verification map

This directory is the maintained source for verifying what sql-fs clients can observe. Read this index, then use the matching feature file as the recipe. When a change adds or alters a client-visible path, update its feature file in the same change.

## Baseline preconditions

- `S=.claude/skills/verify/scripts/stack.sh`
- `$S up` has completed and `$S doctor` exits 0 with no `FAIL` lines.
- Run all commands from the repo root.
- Never drive a server or database that this checkout's `$S up` did not start.

## Driving conventions

- `.claude/skills/verify/scripts/journeys.sh <feature>` runs a feature's journey with assertions. Keep it in step with these files.
- Create the journey's own sandbox and capture its ID: `ID=$($S api POST /v1/sandboxes --json '{"name":"verify"}' | jq -r .id)`.
- The default caller is `verify-agent`. Use `AS=intruder` for a second owner and `AS=none` for no token.
- Assert with `EXPECT=<status>` (the helper exits non-zero on mismatch) and inspect the body with `jq`.
- Prove a mutation with a second, independent read: a REST read, a bash `cat`, an MCP `file_read`, or `$S psql`.
- Delete the sandbox at the end with `$S api DELETE /v1/sandboxes/$ID`. Evidence stays in the run directory.

## Proof and skip reporting

- Cite `transcript.jsonl` lines or suite `proof.json` paths for every claim.
- Report an unreachable journey with the command and the unmet precondition.
- Proving one entry point (REST) does not prove another (MCP, SDK). List which ones you drove.

## Feature entry contract

Each feature file has an H1, one paragraph of client-visible behavior, then exactly four H2s: `Sub-features`, `How to get to it (user POV)`, `Driving it with stack.sh`, and `Gotchas`.

## Features

- [Auth](./auth.md) covers bearer tokens, bootstrap with `X-Auth-Secret`, and unauthenticated rejection.
- [Sandboxes](./sandboxes.md) covers create with seed files, get, list, runtime update, owner isolation, and delete.
- [Bash execution](./exec.md) covers `exec-sync`, SSE `exec`, batches, read-only mode, and cooperative timeouts.
- [Files](./files.md) covers raw read and write, edit, bulk write, mkdir, tree, and delete.
- [Ingest](./ingest.md) covers base64 manifest upload and archive export through bash.
- [MCP](./mcp.md) covers tool listing, file and bash tools, and cross-transport visibility.

## Covered only by suites

These have no hand-driven journey yet. Run the suite through `$S suite <name>`, or as part of `pnpm verify:architecture`.

- SDKs (TypeScript and Python, live): `sdk-clients`
- Multi-tenant routing and isolation: `tenants`
- Worker crash, lease loss, and unknown-outcome errors: `worker-failures`
- SSE stream finalization: `sse-finalization`
- Request and input budgets: `input-budgets`
- Queued upload cancellation and durable absence: `ingress-queue`
- Output caps: `output-cap`
- Graceful shutdown with open MCP streams: `shutdown`
- Full HTTP/MCP contract against `/openapi.json`: `contracts`
