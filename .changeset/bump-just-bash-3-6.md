---
"sql-fs-api": patch
---

Bump just-bash to 3.6.0 and just-git to 1.9.0. Sandboxes gain `curl -d @file`, `--data-binary @file` and `-G`, `jq --arg` and string interpolation with nested quotes, and `git commit -q`. A local patch makes a redirect into a missing directory print `bash: <path>: No such file or directory` and set `$?` to 1 instead of failing the whole exec (vercel-labs/just-bash#557); drop it once a release fixes that.
