# VirtualFS API — Error Reference

All error responses use this shape:
```json
{ "error": "human message", "code": "MACHINE_CODE", "details": ["optional array"] }
```

---

## HTTP → FS code mapping

| HTTP | Code | Meaning | Common cause |
|------|------|---------|--------------|
| 400 | `INVALID_INPUT` | Request validation failed | Check `details` array for field errors |
| 400 | `EISDIR` | Expected a file, got a directory | Reading a dir path as a file |
| 400 | `ENOTDIR` | Expected a directory, got a file | Using a file path as a parent directory |
| 400 | `ELOOP` | Symlink loop detected | Circular symlinks (rare — symlinks off by default) |
| 400 | `EINVAL` | Invalid argument | Malformed path, bad `basePath`, failed tar extraction |
| 401 | `AUTH_REQUIRED` | Missing or malformed `Authorization` | Add `Authorization: Bearer $TOKEN` |
| 401 | `AUTH_INVALID` | JWT expired or bad signature | Regenerate token; check `AUTH_SECRET` |
| 401 | `AUTH_UNKNOWN_TENANT` | `tenant` claim not configured | Omit the claim (single-tenant) or update server config |
| 403 | `FORBIDDEN` | Sandbox owned by different caller, OR `X-Admin-Secret` missing/wrong on `/v1/auth/admin` | Use the token that created the sandbox; for admin endpoints add `X-Admin-Secret: $ADMIN_SECRET` |
| 404 | `ENOENT` | Sandbox or file not found | Sandbox deleted, or path doesn't exist |
| 500 | `ADMIN_NOT_CONFIGURED` | Server has no `ADMIN_SECRET` env var | Operator must set `ADMIN_SECRET` on the deployment |
| 408 | `EXEC_TIMEOUT` | Script exceeded `timeoutMs` | Increase `timeoutMs` (max 300 000) |
| 409 | `EEXIST` | File or directory already exists | Path collision on create |
| 409 | `ENOTEMPTY` | Directory not empty | Use `?recursive=true` on DELETE |
| 500 | `INTERNAL_ERROR` | Unexpected server error | Check server logs; transient DB error |
| 503 | `ESESSIONCLOSING` | Session being destroyed | Retry after a moment |
| 503 | `ELOCKTIMEOUT` | Distributed lock acquire timed out | Another replica holds the sandbox lock; retry |
| 500 | `ELOCKLOST` | Distributed lock lost mid-operation | Redis heartbeat failed; operation may be incomplete |

---

## Debugging patterns

### Script exits non-zero but no error in response

`exec-sync` returns `200` even when the script fails — check `exitCode`:

```bash
result=$(curl -s -X POST "$BASE_URL/v1/sandboxes/$SB/exec-sync" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"script": "cat /nonexistent"}')

echo "Exit code: $(echo $result | jq .exitCode)"
echo "Stderr: $(echo $result | jq -r .stderr)"
# exitCode: 1, stderr: "cat: /nonexistent: No such file or directory\n"
```

### ENOENT on a path that should exist

The path cache is populated at session start. If the sandbox was written to by another
replica between session creation and the read, the local replica's cache may be stale.
The server auto-refreshes via Redis version counters, but if Redis is unavailable it
falls back to a full Postgres reload. In practice this is transparent — just retry.

### 504 / "stream timeout" on ingest

The ACA gateway has a 240 s stream timeout. With the bulk-INSERT `/ingest-files`
path this is rare — the dialect commits the whole batch in ~5 round-trips. You can
still hit it when:
- The HTTP request body itself is huge and slow to upload
- Network to Neon (Postgres) is degraded

Fix: split very large uploads into a couple of calls by directory; check Neon health.

### Token looks right but gets AUTH_INVALID

```bash
# Check expiry
echo $TOKEN | cut -d. -f2 | base64 -d 2>/dev/null | jq '.exp | . as $e | ($e - now) / 3600 | floor | "\(.) hours remaining"'
```

If expired, regenerate:
```bash
export TOKEN=$(AUTH_SECRET=<secret> pnpm token:create -- --sub admin --expires 30d 2>/dev/null | tail -1)
```
