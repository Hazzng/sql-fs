---
"sql-fs-api": patch
---

Patch just-git 1.9.1 with four unreleased upstream fixes. `git status` and `git diff` now report a chmod-only change. Switching to a branch where a file differs only in its exec bit now applies that mode, and a local chmod-only change blocks the switch as it does in git. A merge keeps a mode change made on either side. `git ls-tree` works, and `git show`, `git log` and `git diff` accept `--summary`.
