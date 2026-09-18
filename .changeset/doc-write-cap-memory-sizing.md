---
"sql-fs-api": patch
---

Record how the single-file write cap translates into container sizing.

Blob bytes are held in `external` memory rather than the V8 heap, so `--max-old-space-size` does not bound them and a cgroup OOM-kills the process instead. Measured on Linux (glibc, one replica, otherwise idle), a single write costs roughly 7x the file size above steady state, and steady state for an idle replica was around 300-400 MB — so at the 50 MiB default a single legal write needs headroom on the order of 700 MB, and a 512 MiB container was killed by one request while 768 MiB survived.

Treat those as one measurement rather than a specification: the multiplier is the transferable part, the absolute numbers depend on replica baseline, concurrency, and how many large reads are warm at once. Size from `baseline + 7 x MAX_FILE_WRITE_BYTES x concurrent large writes`, and note that raising `MAX_FILE_WRITE_BYTES` above the contentCache cap adds a further ~2x retention per pool connection (the server now warns at startup when it is).
