---
"sql-fs-api": patch
---

Make the vitest excludes path-independent so a git worktree checked out inside the repo is not swept into every test run.

Tooling only — no runtime or published-artifact effect; the shipped code is byte-identical.

`vitest.config.ts` excluded the heavy bash-comparison suite with a root-anchored glob, `comparison/**/*.comparison.test.ts`. That matches only the repo-root `comparison/` directory, so a worktree checked out *inside* the repo — which is exactly where Claude Code's agent isolation puts them, `.claude/worktrees/<id>/` — contributed its own copy of `comparison/` plus a duplicate of the entire `src/` suite to `pnpm test:unit`. The glob is now `**/comparison/**/*.comparison.test.ts`, and `**/.claude/**` is excluded outright.

Measured with one worktree present: before, 304 test files / 3198 tests with 3 files and 6 tests failing in 13.9s — every failure inside the worktree's `comparison/*.comparison.test.ts`, fixtures that are deliberately excluded at the root and gate nothing. After, 126 files / 1271 tests, all green in 5.8s, identical to a tree with no worktree. The root `comparison/` suite stays excluded from `pnpm test:unit` and still runs on its own config via `pnpm test:comparison`.

The CLI `--exclude 'src/**/integration/**'` in the `test:unit` script is additive, not a replacement, so it was never the cause.
