---
"sql-fs-api": patch
---

Apply the single-file write limit to each entry of a bulk write.

`POST /writeFiles` checked only the combined size against `MAX_BULK_WRITE_BYTES`, which is larger than the per-file cap — so one oversized entry went through and landed a blob the contentCache cannot hold, the retention cliff `MAX_FILE_WRITE_BYTES` exists to avoid. Each entry is now checked against the same limit the single-file routes use.
