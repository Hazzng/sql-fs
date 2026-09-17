---
"sql-fs-api": patch
---

Remove the destination of a `git clone` that fails partway, so a refused symlink can no longer leave a poisoned index behind.

just-git writes the index in full while the checkout is still running, and both just-git (symlink targets that escape the worktree) and SqlFs (`allowSymlinks` defaults to false) abort mid-checkout on a symlink — roughly half of popular repos contain one. The clone exited non-zero but the half-built tree was committed, and because the index was complete `git status` reported every un-checked-out file as a staged deletion: ~2800 of them for `vitejs/vite`. An agent following a failed clone with `git add -A && git commit && git push` turned those into a real commit that deleted most of the tree.

The `git` command now lives in `src/api/commands/git-command.ts` and removes what a failed clone left behind, leaving the sandbox as it was. The destination comes from just-git's own `preClone` hook rather than from parsing argv, so it is the path git actually resolved — argv parsing got `--bare` wrong and would have skipped cleanup entirely. A destination that already held files is never touched; one that existed but was empty is emptied again, which is the `git clone <url> .` case. Cleanup also runs when the command throws rather than exiting non-zero.

Also adds `src/api/tests/integration/git-sqlfs.integration.test.ts`, which exercises git through `SessionManager` + SqlFs + Postgres — including the `GIT_HTTP_USER`/`GIT_HTTP_PASSWORD` basic-auth credentials the server actually injects, which had no coverage. The previous `git-network.integration.test.ts` used `InMemoryFs` and a bare `createGit()`, so it tested just-git rather than this service; it is renamed to `tests/unit/git-transport-contract.test.ts` to say so.
