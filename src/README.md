# Source ownership

The HTTP routes and MCP tools adapt requests into SessionManager operations. SessionManager selects the tenant backend, protects the session lifetime, and coordinates execution. SqlFs adapts filesystem calls into cache and persistence operations. PostgresDialect supplies the database operations and owns the pool.

| Concern | Entry point | Owner map | Behavioral tests |
| --- | --- | --- | --- |
| Session execution and lifetime | [SessionManager](api/session-manager.ts) | [Session owners](api/session-manager/README.md) | `api/tests/unit/session-manager.*.test.ts` |
| Worker routing, command dispatch, and recovery | `api/worker-owner/` | [Worker owners](api/worker-owner/README.md) | `api/tests/unit/worker-*.test.ts`, `api/tests/integration/worker-owner*.test.ts` |
| Filesystem coherence, contents, scripts, and namespace operations | [SqlFs](sql-fs/sql-fs.ts) | [Filesystem owners](sql-fs/state/README.md) | `sql-fs/tests/` |
| PostgreSQL blobs, sandbox authority, and namespace SQL | [PostgresDialect](sql-fs/dialects/postgres.ts) | [Postgres owners](sql-fs/dialects/postgres/README.md) | `sql-fs/tests/integration/`, PostgreSQL unit tests |
| Script completion policy | `sql-fs/script-scope.ts` | [Script completion](sql-fs/script-scope.ts) | `api/tests/unit/worker-script-scope.test.ts`, `api/tests/session-manager.script-tx.test.ts` |
| Shared lease-loss context | `execution/owner-cancellation.ts` | [Owner cancellation](execution/owner-cancellation.ts) | Scope and durable-generation tests |

## State ownership

RuntimeAdmission owns language queues and counters. TenantBackends owns tenant connections and factories. SessionCatalog owns residents, creation coalescing, local locks, metadata, accounting, eviction, and shutdown. SessionManager coordinates distributed leases and worker requests through those owners.

CoherentView owns the installed path and epoch image, freshness cohorts, dirty and poison flags, and atomic cache publication. Its private FileContents owns the content LRU and asynchronous fills. ScriptPersistence owns the scope lifetime, transaction outcome, mutation journal, and provisional inode IDs. NamespaceOperations owns overlapping-path reservations and dispatches complete filesystem algorithms.

PostgresDialect owns connect, disconnect, the root pool, and transaction creation. Its blob, sandbox, namespace, and ingest modules operate on the supplied transaction or dynamic root accessor. They do not start independent transactions.

## Dependency direction

Storage owners import neutral filesystem contracts and storage helpers. They do not import API modules or their facade. The facade supplies request policy through narrow callbacks. Namespace algorithms receive only the owner and dialect operations they use.

Persistence reports committed publication facts after the transaction verdict. CoherentView applies those facts to both caches. A failed flush reloads committed state or poisons the view. The script is never automatically replayed after an unknown execution outcome.

The authority epoch remains a live observation at each existing database comparison point. Scope-generation checks and namespace-reservation checks have different lifetimes. Their tests cover pending operations during abort, replacement, and a new scope.

## Change locations

A new filesystem mutation belongs beside its complete namespace algorithm, with replay and publication behavior kept together. A new database operation belongs in the matching PostgreSQL owner and the SqlDialect contract. A new session lifetime transition belongs in SessionCatalog. A new runtime quota belongs in RuntimeAdmission.

Worker commands use the typed protocol and handler registry described in the worker ownership map. Request validation and execution budgets stay at their existing API or SqlFs boundary. The owner maps describe the narrow ports and the tests that protect each boundary.
