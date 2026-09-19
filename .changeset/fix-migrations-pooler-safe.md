---
"sql-fs-api": patch
---

Make the startup migration runner safe under transaction-mode connection pooling, and stop documenting a direct-connection knob the server never used.

`runMigrations` serialized multi-replica boot with a **session-scoped** `pg_advisory_lock` taken outside any transaction, then ran each migration file in its own transaction, then unlocked. That shape assumes the lock, the DDL and the unlock all land on the same backend, which a transaction pooler invalidates — it reassigns the server connection per transaction, so `max: 1` on the client pool buys nothing. Measured against the Neon pooler (PgBouncer, transaction mode): with a holder still holding the lock, a second booter acquired it in **267-335 ms** across three runs instead of waiting. Mutual exclusion — the entire reason the lock exists (audit M4) — was not holding, and nothing errored to say so.

The whole run is now a single transaction whose first statement is `pg_advisory_xact_lock`. A transaction-scoped lock is held by the transaction, so a pooler cannot separate it from the work it guards, and commit/rollback releases it — there is no unlock left to leak onto a pooled backend. Under the same measurement the second booter now waits **1855-1906 ms**, i.e. until the holder commits.

Two consequences worth knowing. Migrations are now **atomic**: a failure in any file rolls back every earlier file in that run, where the per-file loop left them committed. And every migration file must stay transaction-safe — no `CREATE INDEX CONCURRENTLY`, no `VACUUM`, no `REINDEX`. All seven current files were verified to qualify (the two `BEGIN`s in `0001` are PL/pgSQL function bodies, not transaction control). A future migration needing a non-transactional statement will have to restructure the runner rather than drop the statement in.

`DATABASE_DIRECT_URL` was injected by `aca.yaml` from a provisioned secret to run DDL off the pooler, but no server code has ever read it — the runner resolves its connection through `loadTenantConfig()`, which reads only `TENANT_DATABASES` / `DATABASE_URL`. Since the runner is now pooler-safe, the deployment no longer needs a direct connection at all: the `aca.yaml` env entry and its secret are removed. The variable itself is kept, because `drizzle.config.ts` genuinely reads it for `pnpm db:generate` — the `CLAUDE.md` row is corrected from "Postgres (migrations) / direct connection for DDL" to what is actually true, matching the README.

Verified on a real transaction pooler for the lock behaviour above, and by an integration test that asserts a failing run commits nothing (it fails against the old runner, which leaves `dirents`, `inodes` and `sandboxes` behind). Not verified: the leaked-lock aftermath the issue measured on `edoburu/pgbouncer` — on Neon the stale unlock returned `true` and no advisory lock survived the run, so that specific symptom did not reproduce here.
