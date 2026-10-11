---
"sql-fs-api": patch
---

Validate the durable PostgreSQL epoch before every filesystem request and load changed paths with that epoch in one transaction. Readers now return fresh committed data or an availability error after writer process loss. Remove Redis version publication, path snapshots, and publication retries while retaining distributed locks and immutable blob caching.
