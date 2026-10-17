---
"sql-fs-api": patch
---

Shut down promptly when MCP clients hold a `GET /mcp` listener stream open. The server waited for those streams before it drained workers, so every such shutdown ran into the 60 s force exit and exited with code 1. It now ends listener streams first and lets in-flight MCP tool calls finish.
