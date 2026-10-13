---
"sql-fs-api": minor
---

Change a sandbox's runtime flags after creation, and fix several exec problems.

- `PATCH /v1/sandboxes/:id` and the MCP tool `sandbox_update` turn `network`, `python` or `javascript` on or off for an existing sandbox. The update waits for a running exec. When a flag changes, the next exec on every replica rebuilds its shell with the new flags; files are untouched.
- A filesystem error that escapes a script now returns `500 EEXEC_FS` with `retryable: false`, not the `404 ENOENT` a missing sandbox gets. The server logs it as `exec_fs_error`, and logs every other 5xx as `http_error`.
- Redirects no longer corrupt non-ASCII bytes: `cat a > b` used to turn `é` (`c3 a9`) into `c3 83 c2 a9`.
- Reading a large file inside a script is faster: `cat` of a 5 MB file went from 1,020 ms to 35 ms over HTTP against Postgres. The exec file-size limit still applies.
- Each `>` redirect costs one commit operation instead of two. A 2,000-redirect loop went from 23.7 s to 17.1 s.
