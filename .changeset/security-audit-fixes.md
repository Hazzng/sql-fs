---
"sql-fs-api": minor
---

Security & correctness hardening from the sql-fs audit.

**Critical**
- Remove the `py-exec` warm-host-Python command and delete its module entirely. It spawned the host `python3` with the full server environment — a sandbox escape (RCE + secret/credential exfil). Python sandboxes now run only via the isolated WASM `python3` (`python3 -c …` / `python3 script.py`), and the skill/SDK docs were updated accordingly. Rotate `AUTH_SECRET` and DB credentials.

**Authorization & info-leak**
- Ownership checks are now fail-CLOSED: an empty/unknown sandbox owner no longer grants access to every authenticated caller.
- `fs_ingest` authorizes the caller BEFORE reading any host files (no pre-auth host-read / readability oracle).
- MCP tool handlers sanitize errors before returning them (no raw SQL/connection/host-path text); `sandbox_create` is now wrapped too.
- Sandbox ids are validated before being interpolated into Redis lock/version keys.

**Isolation**
- Enable + FORCE Row-Level Security on `inodes`, `dirents`, and `sandboxes` (migration 0005). Trusted context-free server operations (blob GC, listing, create) keep working; client-reachable, context-scoped queries are confined to their sandbox.

**Correctness**
- Reject clobbering a directory (EISDIR), moving onto a non-empty directory (ENOTEMPTY), and writes/moves/copies to `/`.
- `cp` of a symlink preserves the link instead of creating a corrupt file inode; `stat()` follows relative/multi-hop symlinks; `chmod`/`utimes` update all hardlink siblings in cache.
- Durable cross-replica version counter (TTL refreshed on access); no version/snapshot published when a script-tx COMMIT fails.
- `mvComposite` overwrite no longer raises a spurious EEXIST.
- Bulk write (`writeFiles`) is atomic — a mid-batch failure rolls back the whole batch. This required composite writes (`writeFile`/`mkdir`/`mv`/`rm`) to join the open script-tx instead of running in their own auto-committing transaction, which also makes multi-write bash scripts truly atomic on Postgres. Nested initial files create parent dirs.
- Distributed lock heartbeats retry transient renew failures instead of abandoning a still-valid lease.

**Resource bounds & response hardening**
- Global request body-size limit; ingest count/byte caps + bounded host-read concurrency; bounded `/tree` and `fs_export`.
- File-read responses send `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment`, and a locked-down CSP.

**Operational**
- Migration runner takes a Postgres advisory lock to serialize concurrent multi-replica boots.
- SSE exec always emits a terminal event; `ESHUTTINGDOWN` maps to a retryable 503; request logging now runs for `/v1/*` and `/mcp`; assorted lock/stream lifecycle fixes.
