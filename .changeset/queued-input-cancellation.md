---
"sql-fs-api": patch
---

Read accepted queued HTTP and MCP request bodies within the existing byte budgets so client disconnects can remove waiting requests before route execution. Preserve streaming, response and retained-work ownership, and unread immediate queue-full refusal. Add independent global and tenant ingress queue limits, including zero waiting, while keeping the current queue sizes and 250 ms wait by default.

Expose ingress capacity, outcome counters and admitted queue wait histograms through metrics.
