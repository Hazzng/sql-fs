---
"sql-fs-api": major
---

Add a sandbox `git` command backed by just-git, export server `GITHUB_TOKEN` into sandbox GitHub-compatible Git/curl env, and let MCP-created sandboxes request network access for clone/fetch/push. A per-request `env.GITHUB_TOKEN` re-points git's HTTP credentials at that token, so an exec that overrides the token no longer pushes as the deployment identity.
