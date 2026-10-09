---
"sql-fs-api": patch
---

Per-request `env` now reaches child shells. just-bash 3.6 sets exec env as shell variables without exporting them, so `bash script.sh` and `bash -c` saw them empty while `./script.sh` did not. The session manager exports the valid names at the top of each script (same line, so `$LINENO` is unchanged) until a just-bash release ships vercel-labs/just-bash#439.
