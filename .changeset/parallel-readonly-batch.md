---
"virtualfs-api": minor
---

Parallel readOnly batch execution. POST /exec-sync-batch and MCP bash_exec_batch now run scripts in parallel when readOnly:true, capped at 16 concurrent. Mixed and write-path batches are unchanged (sequential, exclusive lock). Result order preserved. MCP client disconnect now propagates into in-flight scripts.
