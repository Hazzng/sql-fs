---
"sql-fs-api": patch
---

Record applied Postgres migrations and their SHA-256 checksums in a transactionally committed ledger per tenant database. Replica startup skips unchanged migrations instead of repeating table DDL while other replicas serve requests. Reject changes to recorded migration files and roll back pending DDL and history together on failure.
