---
"sql-fs-api": patch
---

Stop an abort that races the script-tx opening from killing the process.

`#openScriptTx` publishes the abort handle before the only `await endPromise` is reached, so an abort arriving while the transaction's first statement is still in flight rejected a promise with no listener — fatal under Node's default `--unhandled-rejections=throw`. Connected directly to Postgres that window is microseconds wide; behind a connection pooler it is as wide as the pool's queue wait, where an exec timing out while queued crash-loops the replica. The rejection is now absorbed by a derived chain, which leaves the real handler's rollback untouched.
