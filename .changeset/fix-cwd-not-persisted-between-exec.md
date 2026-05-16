---
"virtualfs-api": patch
---

fix(session-manager): persist cwd across exec calls

`cd` executed inside a `bash.exec()` call was silently discarded because
just-bash runs each call against a **copy** of the interpreter state;
`bash.getCwd()` never changed. The next `exec` always started from the
initial home directory (`/home/user`), causing agents that relied on `cd`
for path convenience to silently grep or operate on the wrong directory.

Fix: track `session.cwd` on each `Session` object (initialised from
`bash.getCwd()` at creation). Before every `execWithRuntimeThrottle` call
the tracked cwd is forwarded as `opts.cwd` (unless the caller already
supplied an explicit `cwd`). After every **non-readOnly** exec the final
working directory is read from `result.env.PWD` (always populated by
just-bash) and stored back on `session.cwd`, so the next call starts
from the correct directory.

Semantics chosen: cwd is session-scoped and per-sandbox. It resets to
`/home/user` only when the session is evicted (idle timeout or explicit
destroy). readOnly execs use the current `session.cwd` as their starting
directory but do not update it, consistent with the read-only contract.

Note: env variables set via `export` inside a script also do not persist
across exec calls — this is symmetric with the cwd behaviour and is the
correct just-bash design. The issue report's claim that env persists was
incorrect; only cwd needed fixing.

Closes #73.
