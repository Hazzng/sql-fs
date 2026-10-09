---
"sql-fs-api": patch
---

Serve `/dev/null` as a virtual device in SqlFs. `cmd > /dev/null`, `>> /dev/null`, `&> /dev/null` and `< /dev/null` used to fail the whole exec with a 404 and roll back the script, because just-bash writes through to `/dev/null` and never creates `/dev` on SqlFs (vercel-labs/just-bash#558). Writes are now discarded and reads are empty, without touching the database.
