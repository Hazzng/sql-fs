---
"sql-fs-api": patch
---

Observe asynchronous worker scope initialization and handle lease-renewal and shutdown callback rejections. Unexpected renewal failures mark the held lease lost while preserving transient Redis retry behavior.
