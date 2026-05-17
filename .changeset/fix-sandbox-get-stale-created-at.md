---
"virtualfs-api": patch
---

Fix GET /v1/sandboxes/:id returning stale createdAt and transient 404 after session eviction. The route now falls back to the database when the session is not in the in-memory pool, and createdAt is sourced from the DB RETURNING clause on creation and restored from DB meta on rehydration so all three endpoints (POST, GET, LIST) agree on the same timestamp.
