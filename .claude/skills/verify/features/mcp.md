# MCP

MCP clients connect to `/mcp` over Streamable HTTP with the same bearer token as REST. They get tools for sandboxes, files, bash, and ingest. MCP and REST share one filesystem, so a write through one transport is visible through the other, and owner isolation applies to both.

## Sub-features

- `mcp-list` lists 11 tools: `sandbox_create`, `sandbox_list`, `sandbox_update`, `sandbox_delete`, `file_read`, `file_write`, `file_edit`, `bash_exec`, `bash_exec_batch`, `fs_ingest`, `fs_export`.
- `mcp-file` writes and reads files through tools.
- `mcp-bash` runs bash through tools, including `readOnly`.
- `mcp-cross-transport` makes MCP writes visible to REST, and the reverse.
- `mcp-isolation` returns `{"ok":false,"error":"forbidden"}` to other owners.

## How to get to it (user POV)

- Connect an MCP client to `<base>/mcp` with `Authorization: Bearer <jwt>`.
- With `MCP_API_KEY` set, a trusted proxy may authenticate with the static key plus an identity header.

## Driving it with stack.sh

Preconditions:

- Baseline from the [index](./README.md), and `ID` from a fresh sandbox.

- **List tools.** Run `$S mcp list`. It prints the 11 tools with their argument names.
- **Write via MCP.** Run `$S mcp file_write "{\"id\":\"$ID\",\"path\":\"/home/user/mcp.txt\",\"content\":\"mcp-proof\\n\"}"`. The output is `{"ok":true,...,"size":10}`.
- **Read via REST.** Run `$S api GET /v1/sandboxes/$ID/files/home/user/mcp.txt`. It prints `mcp-proof`.
- **Bash via MCP.** Run `$S mcp bash_exec "{\"id\":\"$ID\",\"script\":\"cat /home/user/mcp.txt\",\"readOnly\":true}"`. The output has `"stdout":"mcp-proof\n"` and `"exitCode":0`.
- **Isolation.** Run `EXPECT=error AS=intruder $S mcp file_read "{\"id\":\"$ID\",\"path\":\"/home/user/mcp.txt\"}"`. It prints `{"ok":false,"error":"forbidden"}` and exits 0 because the denial was expected. Then run `AS=intruder $S mcp bash_exec "{\"id\":\"$ID\",\"script\":\"cat /home/user/mcp.txt\"}"`. The output has `"exitCode":1` and `"stderr":"forbidden"`.

## Gotchas

- File and sandbox tool failures are `{"ok":false}` with `isError:false`. Without `EXPECT=error`, the helper exits non-zero on them.
- `bash_exec` reports denial as `exitCode:1` with `stderr:"forbidden"`. The helper exits 0, so assert the fields yourself.
- `bash_exec` takes `timeout`, not REST's `timeoutMs`.
- Static-key mode (`MCP_API_KEY`) is off on the stack. To enable it, restart with `SERVER_ENV="MCP_API_KEY=..."`, then read `docs/CONFIGURATION.md` for the identity header.
