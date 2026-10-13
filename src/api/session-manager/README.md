# Session ownership

[SessionManager](../session-manager.ts) remains the public facade. It validates sandbox identifiers and coordinates distributed leases, worker requests, freshness, runtime updates, and read-only execution.

| Owner | State and behavior |
| --- | --- |
| [RuntimeAdmission](runtime-admission.ts) | Both language queues, active counters, timeout/abort cleanup, paired slot acquisition, metrics, and shutdown rejection. One instance caps all executions in a manager. |
| [TenantBackends](tenant-backends.ts) | Tenant connection/configuration and blob-cache initialization, filesystem construction, and durable sandbox metadata operations. |
| [SessionCatalog](session-catalog.ts) | Warm/pending sessions, creation coalescing, local locks, request accounting, cache budgets, owner/name/timestamps, eviction, destruction, and shutdown. |

Borrowers see read-only lifetime and descriptive metadata properties. Catalog operations mutate its private residents. `borrow` checks closing before and after taking local protection, charges the request, and releases that charge on success or failure. Missing-sandbox cleanup waits until that protection is released.

Creation supplies a filesystem and a runtime constructor. The catalog captures the filesystem before invoking the constructor, so a failed runtime build can disconnect it. Publication checks shutdown after asynchronous construction, including worker attachment.

Shutdown sets the catalog shutdown state and stops the reaper, drains workers, marks residents closing, rejects queued runtimes, then drains and disconnects residents against the same deadline. Destroy and reaper mark closing before waiting for the local lock.

The runtime engine owns Bash/script execution and working-directory updates. Worker routing and recovery remain in [worker-owner](../worker-owner/README.md).
