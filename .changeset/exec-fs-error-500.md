---
"sql-fs-api": patch
---

A filesystem error that escapes a script now returns `500 EEXEC_FS` instead of the `404 ENOENT` a missing sandbox gets, and MCP `bash_exec` no longer reports it as "sandbox not found". One way to hit it is a redirect whose target directory the script removes while the command runs (`mkdir d; { rm -rf d; echo x; } > d/out`). The script's changes are rolled back and `retryable` is `false`. The server now logs every such escape as `exec_fs_error`, and every 5xx from the global error handler as `http_error`.
