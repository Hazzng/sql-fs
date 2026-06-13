---
"sql-fs-api": minor
---

Boot-assert that the session idle window (`SESSION_IDLE_MS` / `MCP_SESSION_IDLE_MS`) stays at or below half the Redis version-key TTL when Redis is enabled, failing fast on misconfiguration that would break cache coherence (audit F9b).
