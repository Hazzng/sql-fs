---
"sql-fs-api": patch
---

Update HTTP and MCP dependencies, override vulnerable transitive pins, and remove unused SQL drivers and Drizzle tooling. Add isolated database/API verification and document unauthorized sandbox-list and file-media responses in OpenAPI.

Preserve primary execution and commit errors when rollback fails. Share script-scope completion across local execution, worker adapters, and file writes, retaining nested scope ownership and lease checks before commit. Observe asynchronous scope initialization and callback rejections; unexpected renewal failures mark the lease lost while preserving transient Redis retries.

Keep reservations within each worker pool and retain captured worker identities and generations during recovery so cleanup preserves replacement workers. Never automatically replay an execution with an unknown outcome.

After exec dispatch, coherence failures that previously returned `ECOHERENCE` now return `EEXEC_OUTCOME_UNKNOWN`. Writes may already have been applied. Inspect sandbox state before proceeding and do not automatically replay the execution. Clients matching `ECOHERENCE` must handle the new code. Recover the promoted coherence error before returning it so the affected worker is terminated and its durable identity is retired.
