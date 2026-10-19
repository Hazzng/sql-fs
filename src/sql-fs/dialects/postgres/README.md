# Postgres ownership

[PostgresDialect](../postgres.ts) implements the public SqlDialect API and owns the connection string, pool configuration, root pool, connect/disconnect, and transaction creation. It passes a dynamic root accessor to the blob owner. No other module creates a pool or begins a transaction.

| Owner | Database state and operations |
| --- | --- |
| [PostgresBlobs](blobs.ts) | Immutable CAS bytes, Redis backfill, root commits, caller-transaction upserts and reads, bounded prewarm queries, and caller-controlled orphan GC. |
| [PostgresSandbox](sandbox.ts) | Live sandbox rows, durable lifecycle epochs, metadata/runtime changes, RLS context, writer locking, fencing fragments, retirement, and bootstrap directories. |
| [PostgresNamespace](namespace.ts) | Inode/dirent reads and mutations, link counts, whole composite operations, tree loading, and stored-procedure path resolution. It imports sandbox fence policy and consumes only blob backfill. |
| [bulkIngest](ingest.ts) | One transaction-local plan for ancestors, overwrite detection, hashes, inserted rows, hardlink decrements, and returned cache entries. It consumes only the blob batch-commit operation. |

Group contracts in [types.ts](types.ts) derive from SqlDialect. Postgres-specific optional capabilities are required in their implementing group. The existing updateSandboxRuntime method remains a concrete Postgres extension.

The root blob commit and batch commit remain independent single statements outside the caller's namespace transaction. Ingest invokes its blob commit after directory and overwrite checks, before inserting file inodes. Cache backfill remains asynchronous.

Writer-lock statements precede fenced CTEs so READ COMMITTED statement snapshots follow any lock wait. REPEATABLE READ retains an established transaction snapshot. Fenced CTE mutations reference and gate their writes on the epoch CTE; lower-level mutations run directly in the caller transaction. Both mvComposite statements and its two version advances remain together. Sandbox bootstrap inserts remain part of sandbox lifecycle rather than ordinary mkdir operations.

## Fencing

| To change | Edit | Verify with |
| --- | --- | --- |
| How a namespace or ingest write accepts an epoch, advances the version, and publishes the transaction-local epoch | The private `fenceCtes` policy in [sandbox.ts](sandbox.ts). Lifecycle methods in the same file, such as retirement, context locking, and runtime updates, advance or publish directly. | [fence-policy](../../tests/integration/fence-policy.integration.test.ts), [fencing](../../tests/integration/fencing.integration.test.ts), and [epoch coverage](../../tests/integration/epoch-fence-coverage.integration.test.ts) integration suites |
| A namespace operation | Its complete statement in [namespace.ts](namespace.ts) | The same suites, plus [move overwrite](../../tests/integration/mvcomposite-overwrite.integration.test.ts) for moves |

`fenceAndAdvance` and `compositeFenceAndAdvance` return lazy SQL fragments that callers place in their own `WITH` clause. Keep them synchronous. An async builder would await the fragment, and awaiting a postgres.js query executes it. `fenceAndAdvance` projects `s.version` for callers that already set context, which covers lower-level namespace mutations and ingest. `compositeFenceAndAdvance` also sets `app.sandbox_id` and takes the reentrant advisory lock inline. Composite callers still run `takeWriterLock` first.

Run the integration suites on the disposable verify stack, whose `sqlfs_app` role is neither superuser nor BYPASSRLS. A rejected write that rolls back looks the same as one that never ran, so the fence-policy and epoch coverage suites include cases that catch `ESTALE` and commit before checking state.

The fence-policy suite pins the advisory-lock wait verdicts under READ COMMITTED and an established REPEATABLE READ snapshot; its `it.each` table lists them.

`pnpm check:architecture` rejects `app.sandbox_epoch` references and `sandboxes.version` increments in tagged SQL in namespace.ts and ingest.ts. It also rejects `unsafe` and `file` raw SQL access in those two consumers. The check does not parse arbitrary SQL strings or track computed names, reflection, or capabilities hidden behind noncallable types. Sandbox lifecycle operations remain owned by sandbox.ts.

GC uses the transaction and isolation selected by its caller. It does not create a nested transaction. Namespace and sandbox operations use the caller transaction. Ingest keeps namespace writes there, but commits its blob batch independently through the root pool.
