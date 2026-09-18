---
"sql-fs-api": patch
---

Fail a `file_read` explicitly when `MAX_MCP_READ_RESPONSE_BYTES` is configured below the size of a response envelope.

The page budget can then fit no content at all: the reply exceeded the cap anyway and carried a `nextByteOffset` equal to the offset requested, so a client resuming from it would loop forever without advancing. It now returns `RESPONSE_BUDGET_TOO_SMALL` naming the setting.
