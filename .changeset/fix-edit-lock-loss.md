---
"sql-fs-api": patch
---

Roll back a `PATCH` edit or bulk write when the distributed exec lock is definitively lost mid-request, instead of committing it and then reporting `ELOCKLOST`.

`ELOCKLOST` is mapped to a retryable 503 on the promise that nothing committed — the exec path keeps that promise by aborting its script-tx scope before `endScope` (F2-L1), but the two write routes that open a scope of their own did not. `SessionScopedFs.run` commits as soon as its callback returns, and `withDistributedLock` only raises `LockLostError` afterwards, so a lease lost during a long read-modify-write left the edit durable while the client was told it was not written — and free to race the replica that took over the expired lease.

Both routes now go through `runInScriptTx`, which makes the same lost-signal check inside the scope, so the rollback happens before the commit and the 503 stays true.
