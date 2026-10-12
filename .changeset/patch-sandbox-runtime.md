---
"sql-fs-api": minor
---

Add `PATCH /v1/sandboxes/:id` and the MCP tool `sandbox_update` to turn `network`, `python` or `javascript` on or off for an existing sandbox. Before, these flags could only be set at creation. The update waits for a running exec to finish. It advances the sandbox epoch, so the next exec on every replica rebuilds its shell with the new flags; files are untouched. Execs that run when the flags have not changed do no extra metadata read.
