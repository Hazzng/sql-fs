---
"sql-fs-api": patch
---

Abort the running script when the client of `POST /v1/sandboxes/:id/exec-sync` disconnects, instead of letting it hold the sandbox's exclusive exec lock to the end of its timeout.

`/exec-sync` built an `AbortController` and fed it only a `setTimeout` — `c.req.raw.signal` was never read, so a client that gave up left the script running server-side for up to `MAX_TIMEOUT_MS` (300 s), and every other request on that sandbox queued behind the lock it still held. Measured with a client aborting at 1.0 s of a 6 s script: a follow-up write blocked **5.029 s** on `/exec-sync` versus **0.0018 s** on the SSE `/exec`. Both sibling routes already did this correctly, including the buffered `/exec-sync-batch` 240 lines below in the same file, so there was never a "buffered responses cannot see a disconnect" argument — only an omission.

The fix is `/exec-sync-batch`'s wiring verbatim: an already-aborted pre-check plus an `{ once: true }` abort listener. The pre-check is load-bearing rather than defensive — a client can disconnect while the handler is still waiting to acquire the exec lock, in which case the listener never fires (a unit test covers exactly that branch and fails when only the pre-check is removed).

**Semantics are deliberately abort-only: work the script already committed stays committed.** This is not an oversight and it costs something — a client that disconnects mid-script can be left with a half-applied filesystem it never sees a response for. The alternative costs more: rolling back on disconnect would let a flaky network silently discard committed work, and it would diverge from `/exec`, `/exec-sync-batch` and the timeout path, all three of which commit partial work today. A disconnect is indistinguishable from a timeout to the script. Changing that is a separate decision that has to move all four together. The F2-L1 lock-loss rollback is untouched: it keys off `session.lockLostSignal`, not the composed exec signal, so adding a third input to the composition cannot reach it.

Also folded in: the SSE route's disconnect listener now passes `{ once: true }` — it was never removed.

Verified by three unit tests that hang (and fail) against the previous code. Not verified against a live deployment: the fix is exercised through Hono's `app.request` with an `AbortSignal`, not through `@hono/node-server` closing a real socket, so the end-to-end trigger — `outgoing.on("close")` when `incoming.errored` or `!outgoing.writableFinished` — is taken from the dependency's source rather than reproduced.
