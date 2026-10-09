---
"sql-fs-api": patch
---

Sandbox git keeps executable files executable and honours `git -c`, `-C` and `--no-pager`. A cloned or checked-out `100755` file used to land as 0644, so `./gradlew` failed with "Permission denied" and the next `git add -A` committed a `100755 -> 100644` change nobody made (blindmansion/just-git#10); every file git writes now gets the mode its index entry records. Bump just-git to 1.9.1, which runs the command behind leading global options instead of printing help and exiting 0 (blindmansion/just-git#11). `GIT_AUTHOR_*`/`GIT_COMMITTER_*` server settings are now git's fallback identity instead of sandbox env, so `git -c user.*`, repo `git config` and per-request `GIT_AUTHOR_*` env override them.
