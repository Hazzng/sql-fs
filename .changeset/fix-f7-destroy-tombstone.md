---
"sql-fs-api": minor
---

fix(session): destroy now reaches warm sessions on other replicas (F7).

Destroying a sandbox on one replica previously left warm sessions on other
replicas serving ghost state: a written session would reload a deleted tree
into an empty pathCache (surfacing as a non-zero exit + garbage stderr inside an
HTTP 200 exec), and a never-written session would never reload at all because
the deleted version key read as 0 and matched its `lastSeenVersion === 0`.

Two layered fixes:

- Primary (Redis-independent): `SqlFs.reload()` now detects a zero-row
  `loadAllPaths` — which for a live sandbox always returns at least its root dir
  — and throws a typed `ESANDBOXGONE` instead of installing an empty pathCache.
  The session manager catches it, tears the stale warm session down (drops it
  from the pool and disconnects the per-session Postgres pool), and surfaces a
  clean `ENOENT` → 404.
- Secondary (tombstone): `destroy` now writes a distinct `DESTROYED` sentinel to
  the version key (with the version-key TTL) instead of deleting it.
  `ensureFreshCache` recognises the sentinel before the numeric parse and tears
  the session down — covering the never-written variant. Re-creating a
  tombstoned sandbox clears the sentinel and starts cleanly at version 0.
