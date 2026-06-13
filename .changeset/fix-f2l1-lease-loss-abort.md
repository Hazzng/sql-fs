---
"sql-fs-api": minor
---

fix(lock): abort the exec on definitive lease loss before commit (F2-L1)

The distributed exec lock wrappers ran the critical section to completion and only
then checked the loss flag, so a writer whose lease lapsed mid-script still
committed its script-tx and bumped the version before throwing `ELOCKLOST` — a
write that durably happened surfaced as an error, causing retrying agents to
double-apply.

The lock now wires its DEFINITIVE-loss signal (lease expiry / ownership taken —
not transient renew blips) into an `AbortController` that is plumbed through to
`bash.exec`. On a definitive loss the in-flight exec is aborted, its script-tx
rolls back BEFORE any commit (no `INCR`), and the client receives a clean,
retryable `ELOCKLOST` (now mapped to 503). Because just-bash treats an aborted
run as a resolved result rather than a rejection, the runtime explicitly rolls
back and re-raises `LockLostError` when the lock-lost signal fired, instead of
committing the partial script. A plain timeout abort still commits (unchanged,
audit L7) — only the dedicated lock-lost signal triggers rollback.

This is Layer 1 of the F2 fix; the complete epoch/version fence is tracked
separately (#131).
