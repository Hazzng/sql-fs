# SqlFs ownership

[`SqlFs`](../sql-fs.ts) adapts the public filesystem interface. It validates paths, handles virtual devices and encodings, enforces execution input/file budgets and read-only scopes, translates owner lease loss, and reloads or poisons the view after failed scope settlement.

| Owner | State and behavior |
| --- | --- |
| [`ScriptPersistence`](script-persistence.ts) | Script and physical transaction lifetimes, sticky faults, writer fencing, mutation journal, provisional IDs and replay. Reads a live readonly epoch authority at the original lock/query completion points. Returns publication receipts without importing cache owners. |
| [`CoherentView`](coherent-view.ts) | Path tree, committed epoch, freshness cohorts, byte accounting, dirty/poison state, and synchronous publication across paths and content. Privately constructs [`FileContents`](file-contents.ts). |
| [`FileContents`](file-contents.ts) | Content LRU, content generation, prewarm task and queued follow-up, lazy fetch and stale-fill rejection. Background prewarm cannot condemn an active script scope. |
| [`NamespaceOperations`](namespace-operations.ts) | Overlapping-path reservations. Captures the scope counter and active state before waiting, then checks both before dispatching an operation. |

The namespace modules contain complete stateless algorithms: [file writes and append](namespace/file-writes.ts), [directory/tree creation/copy/removal](namespace/directory-tree.ts), [links/moves/metadata](namespace/links-moves.ts), and [ingest](namespace/ingest.ts). Their query/view/persistence/policy ports derive only the operations each group uses. Execution policy remains in the adapter.

Metadata publication follows successful database commit outside a script scope. Non-buffered scopes publish transaction-local metadata before their held transaction commits. Buffered scopes publish provisional metadata until finalization; the view applies the returned inode remap to both caches and rejects unbound IDs before publishing the epoch. Failed settlement reloads through the public adapter method; failed reload poisons the view. Execution is never replayed automatically.

[`paths.ts`](paths.ts) contains shared pure path rules. [`types.ts`](types.ts) defines mutation, publication, and scope contracts. The existing `_getPathCache()` and `_getContentCache()` adapters remain available for tests; production collaborators use observation and publication methods.

Symbolic links are enabled by default; `allowSymlinks: false` disables creation. Resolution follows relative targets from the link directory and stops after 40 hops. Aliases share cached file bytes; path-cache estimates include target strings. File writes replace a final symlink, and namespace mutations through directory aliases remain unsupported.
