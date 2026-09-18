---
"sql-fs-api": patch
---

Refuse to replay a git request body across origins on a 307 or 308 redirect.

Crossing origins already dropped the credentials, but 307 and 308 preserve the method *and* the body — and for git that body is the packfile being pushed. `fetch` replays it cross-origin and leaves the caller to CORS, which does not apply server-side, so a remote an agent was talked into pushing to could forward the whole repository to a host of its choosing. Such a hop is now refused before the second request is made. Same-origin replay, and bodiless cross-origin redirects like a clone's `info/refs`, are unchanged.
