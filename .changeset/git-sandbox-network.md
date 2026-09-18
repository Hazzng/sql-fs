---
"sql-fs-api": major
---

Add a sandbox `git` command backed by just-git, export server `GITHUB_TOKEN` into sandbox GitHub-compatible Git/curl env, and let MCP-created sandboxes request network access for clone/fetch/push. A per-request `env.GITHUB_TOKEN` re-points git's HTTP credentials at that token, so an exec that overrides the token no longer pushes as the deployment identity. Each credential alias is derived on its own, so a request that pins one half (`GIT_HTTP_USER: "oauth2"` for a non-GitHub host, say) keeps it and still has the other half re-derived rather than inheriting the server's. Git's HTTP transport refuses plaintext `http://` remotes, and a redirect that downgrades to plaintext, rather than putting those credentials on the wire in the clear.
