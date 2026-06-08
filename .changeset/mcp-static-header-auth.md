---
"sql-fs-api": minor
---

Add static-header (API-key) auth for the MCP endpoint so external clients that can only send fixed headers — e.g. LibreChat — can connect without minting a per-request JWT. Set `MCP_API_KEY` to accept a pre-shared `Authorization: Bearer <key>`; the sandbox owner (`sub`) is derived from a forwarded identity header (`MCP_IDENTITY_HEADER`, default `x-librechat-user-id`), giving each end-user an isolated sandbox. New env vars: `MCP_API_KEY`, `MCP_IDENTITY_HEADER`, `MCP_DEFAULT_SUB`, `MCP_STATIC_TENANT`. Static auth is additive and off unless `MCP_API_KEY` is set — JWT clients on `/mcp` and all `/v1/*` routes are unchanged.

Startup hardening: `MCP_IDENTITY_HEADER` cannot be a reserved transport header (`authorization`, `cookie`, `content-type`, `accept`, `mcp-session-id`, `mcp-protocol-version`, `last-event-id`) — otherwise every request would derive `owner` from a shared value and collapse all users into one sandbox. The `mcp_static_auth_enabled` startup log records only whether a fallback owner is configured (`hasDefaultSub`), never the `MCP_DEFAULT_SUB` value.
