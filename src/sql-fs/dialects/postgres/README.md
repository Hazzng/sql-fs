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

Writer-lock statements precede fenced CTEs so their snapshots follow any lock wait. Each mutation still references and gates on the epoch CTE. Both mvComposite statements and its two version advances remain together. Sandbox bootstrap inserts remain part of sandbox lifecycle rather than ordinary mkdir operations.

GC uses the transaction and isolation selected by its caller. It does not create a nested transaction. The same applies to every namespace, sandbox, and ingest operation.
