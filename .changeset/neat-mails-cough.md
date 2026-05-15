---
"virtualfs-api": patch
---

Parallel readOnly batch execution. POST /exec-sync-batch and MCP bash_exec_batch now run scripts in parallel when readOnly: true, bounded at 16 concurrent workers. Result order is preserved. Write-path batches are unchanged (sequential, exclusive lock). MCP client disconnects now propagate into in-flight scripts via extra.signal forwarding.
