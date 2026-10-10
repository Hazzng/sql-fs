---
"sql-fs-api": patch
---

Per-request `env` with valid shell variable names now reaches `bash script.sh`, `bash -c`, and child shells started through `env`, `time`, or `timeout`. A local just-bash patch copies the active execution's variables and export attributes, and marks request variables for export without adding a shell command. This preserves the user's command budget, first-command arguments, shebangs, and line numbers, and prevents export attributes from leaking into later requests. Child-shell defaults preserve explicitly exported `SHELLOPTS` and `BASHOPTS` values.

Names outside `[A-Za-z_][A-Za-z0-9_]*`, such as `A-B`, stay available to direct commands but cannot be exported to child shells. The API logs a bounded sample once per warm session at warning severity, with tenant and sandbox IDs and without any env values. Remove the env patch when a just-bash release includes [vercel-labs/just-bash#439](https://github.com/vercel-labs/just-bash/pull/439).
