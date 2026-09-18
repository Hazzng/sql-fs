---
"sql-fs-api": patch
---

Ignore a relative `PWD` when recording a session's working directory instead of rooting it.

`session.cwd` was normalized with a helper that prefixed a missing leading slash, so a script doing `export PWD=foo` stored `/foo` — a path with no reason to exist — and the `startsWith("/")` guard after it could never fail. A relative value is now dropped and the last known-good cwd kept, and the normalization helper no longer answers the "is this root-relative or cwd-relative?" question on its callers' behalf: the MCP tools root their argument themselves, which is their documented contract.
