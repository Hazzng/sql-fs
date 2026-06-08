---
"sql-fs-api": minor
---

Add static-header (API-key) auth for the MCP endpoint so external clients that can only send fixed headers — e.g. LibreChat — can connect without minting a per-request JWT. Set `MCP_API_KEY` to accept a pre-shared `Authorization: Bearer <key>`; the sandbox owner (`sub`) is derived from a forwarded identity header (`MCP_IDENTITY_HEADER`, default `x-librechat-user-id`), giving each end-user an isolated sandbox. New env vars: `MCP_API_KEY`, `MCP_IDENTITY_HEADER`, `MCP_DEFAULT_SUB`, `MCP_STATIC_TENANT`. Static auth is additive and off unless `MCP_API_KEY` is set — JWT clients on `/mcp` and all `/v1/*` routes are unchanged.
