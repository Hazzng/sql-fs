# Error reference

All errors extend `SQLFSError`. Each carries the server's `code` (e.g. `ENOENT`),
HTTP `status`, and any `details`.

```typescript
import {
  SQLFSError,
  AuthError,
  NotFoundError,
  ConflictError,
  ValidationError,
  ExecTimeoutError,
  RateLimitError,
  ServerError,
  TransportError,
} from "sql-fs-sdk";
```

---

## Hierarchy

```
SQLFSError                    base — never thrown directly by the SDK
├── AuthError                     401 / 403
├── NotFoundError                 404
├── ConflictError                 409 (EEXIST, ENOTEMPTY)
├── ValidationError               400 (INVALID_INPUT, EISDIR, ENOTDIR, EINVAL, ELOOP);
│                                 also client-side EFILE_TOO_LARGE / EFILE_TOO_LARGE_FOR_CPYTHON;
│                                 also EREADONLY_VIOLATION (422) from a write in a readOnly exec
├── ExecTimeoutError              408 (script ran longer than timeoutMs)
├── RateLimitError                429
├── ServerError                   5xx after retries exhausted
└── TransportError                network failure (DNS, TCP, TLS, timeout)
```

Every error is an `instanceof SQLFSError`, so a single `catch (e) { if (e instanceof SQLFSError) ... }`
covers them all.

---

## HTTP → error mapping

| HTTP | Class | Common server `code` | Cause |
|------|-------|---------------------|-------|
| 400 | `ValidationError` | `INVALID_INPUT`, `EISDIR`, `ENOTDIR`, `EINVAL`, `ELOOP` | Body/query validation, or path semantics (e.g. reading a dir as a file) |
| 401 | `AuthError` | `AUTH_REQUIRED`, `AUTH_INVALID`, `AUTH_UNKNOWN_TENANT` | Missing/expired token, wrong `AUTH_SECRET`, unknown tenant |
| 403 | `AuthError` | `FORBIDDEN` | Sandbox owned by a different `sub`; admin endpoint without `X-Admin-Secret` |
| 404 | `NotFoundError` | `ENOENT` | Sandbox/file/dir not found, or sandbox already deleted |
| 408 | `ExecTimeoutError` | `EXEC_TIMEOUT` | Script exceeded `timeoutMs` |
| 409 | `ConflictError` | `EEXIST`, `ENOTEMPTY` | Path collision; non-empty dir without `recursive: true` |
| 422 | `ValidationError` | `EREADONLY_VIOLATION` | A write op ran in a `readOnly` exec/stream |
| 429 | `RateLimitError` | `RATE_LIMITED` | Bootstrap/admin endpoint rate limit (default 5 / 60s) |
| 5xx | `ServerError` | `INTERNAL_ERROR`, `ESESSIONCLOSING`, `ELOCKTIMEOUT`, `ELOCKLOST` | Server failure after retries exhausted |
| network | `TransportError` | n/a | DNS, TCP, TLS, timeout |

The SDK retries 429 / 5xx / network failures up to `maxRetries` (default 3)
with exponential jitter. The error you catch is the **final** failure.

---

## Client-side validation (thrown before any HTTP request)

Not every `ValidationError` comes from the server. The SDK enforces two
per-file ceilings locally on `ingestFiles`, so an oversized file fails
**before** anything is base64-encoded or sent:

| `code` | Thrown by | Cause |
|---|---|---|
| `EFILE_TOO_LARGE` | `ingestFiles`, `fs.write`, `fs.writeFiles` | A file exceeds the client's `maxFileSize` (default 64 MiB). `e.status` is `undefined`; `e.details` lists each offending `path (size > limit)`. Disable with `maxFileSize: 0`. |
| `EFILE_TOO_LARGE_FOR_CPYTHON` | `ingestFiles` | A file exceeds **8 MiB**, which the `python3` runtime (CPython WASM) can't `open()`. `e.status` is `undefined`; `e.details` lists each offending path. Pass `{ allowOversized: true }` to ingest anyway (usable from bash/`js-exec`, not `python3`), or split into <8 MiB chunks. |

```typescript
import { ValidationError } from "sql-fs-sdk";

try {
  await sb.ingestFiles({ "huge.csv": payload });
} catch (e) {
  if (e instanceof ValidationError && e.code === "EFILE_TOO_LARGE_FOR_CPYTHON") {
    // too big for python3, never sent. Retry with { allowOversized: true } if
    // you only need it from bash, or chunk it.
    await sb.ingestFiles({ "huge.csv": payload }, { allowOversized: true });
  }
}
```

---

## Common properties

Every error exposes:

| Property | Type | Notes |
|---|---|---|
| `e.code` | `string \| undefined` | Server-side machine code (`ENOENT`, `RATE_LIMITED`, …) or client-side code |
| `e.status` | `number \| undefined` | HTTP status code; `undefined` for client-side / transport errors |
| `e.details` | `unknown` | Server's `details` array, if any |

Some errors add fields:

| Class | Extra | Notes |
|---|---|---|
| `ExecTimeoutError` | `e.durationMs?: number` | Wall-clock spent before timeout |
| `RateLimitError` | `e.retryAfter?: number` | Seconds from the `Retry-After` response header |

---

## Idiomatic `try/catch` patterns

### Catch a specific failure mode

```typescript
import { NotFoundError } from "sql-fs-sdk";

let info: SandboxInfo | null = null;
try {
  info = await client.sandboxes.get(sbId);
} catch (e) {
  if (e instanceof NotFoundError) info = null;  // deleted out from under us
  else throw e;
}
```

### Distinguish auth from authz

`AuthError` covers both 401 and 403 — check `.status` to disambiguate:

```typescript
import { AuthError } from "sql-fs-sdk";

try {
  await client.sandboxes.list();
} catch (e) {
  if (e instanceof AuthError) {
    if (e.status === 401) console.log("token expired or invalid — re-authenticate");
    else if (e.status === 403) console.log("forbidden:", e.details);
  } else throw e;
}
```

### Honour `retryAfter` on rate limit

```typescript
import { RateLimitError } from "sql-fs-sdk";

try {
  await client.sandboxes.create({ name: "x" });
} catch (e) {
  if (e instanceof RateLimitError) {
    await new Promise((r) => setTimeout(r, (e.retryAfter ?? 5) * 1000));
    await client.sandboxes.create({ name: "x" });
  } else throw e;
}
```

In practice the SDK already retries 429 transparently; you only see this error
when retries are exhausted.

### Distinguish exec timeout from server-side bash failure

`ExecTimeoutError` is thrown when the **server** kills the script for exceeding
`timeoutMs`. A script that exits non-zero on its own is **not** an error — it's
a successful HTTP response with `exitCode !== 0`. Check `result.ok`:

```typescript
import { ExecTimeoutError } from "sql-fs-sdk";

try {
  const r = await sb.exec("long-running-script.sh", { timeoutMs: 10_000 });
  if (!r.ok) console.log(`script exited ${r.exitCode}: ${r.error}`);
} catch (e) {
  if (e instanceof ExecTimeoutError) console.log(`timed out after ${e.durationMs}ms`);
  else throw e;
}
```

### Catch-all at the top of an agent loop

```typescript
import { SQLFSError } from "sql-fs-sdk";

try {
  await doWork(sb);
} catch (e) {
  if (e instanceof SQLFSError) {
    log.error("sqlfs failure", { code: e.code, status: e.status, details: e.details });
  } else throw e;
}
```

Catching `SQLFSError` covers every typed error the SDK can throw. Bare `fetch`
failures are wrapped into `TransportError` before they surface, so you don't
need a separate network-error branch.

---

## What the SDK does NOT throw

- A non-zero `exitCode` from a script does **not** throw — it's a normal
  result. Check `result.ok` or `result.exitCode`.
- A successful response with empty `stdout` does **not** throw — the script
  may have legitimately produced no output.
- Pre-bootstrap errors (e.g. wrong `authSecret`) come back as `AuthError` with
  `status === 403`, same shape as a runtime auth failure.
