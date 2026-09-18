---
"sql-fs-api": patch
---

Fail every remaining operation in a script scope once its transaction's connection is lost, instead of silently committing the rest outside the scope.

`postgres.js` binds a transaction's `sql` to one connection object, and the pool reconnects that same object for the next root-`sql` query — which every write issues first, to write its blob. A write after the connection died therefore ran on a live but transaction-**less** connection and self-committed: a bulk write of 600 files answered HTTP 500 with 599 of them durable, the exact inverse of the atomicity that route promises. Clearing the handle alone was not enough, because the next write would open a fresh transaction that `endScriptScope` would then commit and report as success.

No admin action is needed to reach it. A script scope pins one Postgres backend `idle in transaction` for the whole script, so `idle_in_transaction_session_timeout` — default-on or standard hardening on managed Postgres — plus any script that pauses between writes is sufficient; with the default pool size the process crashed rather than answering at all. The loss is now recorded and sticky for the rest of the scope, so a lost connection can only end in failure, and no query is ever handed to a dead connection.
