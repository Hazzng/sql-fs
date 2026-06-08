# `Client` reference

The top-level entry point. Wraps a `fetch`-based transport with auth bootstrap,
retry policy, and the typed error layer. One `Client` instance is safe for the
lifetime of your process.

```typescript
import { Client } from "sql-fs-sdk";
```

---

## Constructor

```typescript
new Client({
  baseUrl: string,                  // required
  token?: string,                   // one of these three is required
  authSecret?: string,
  adminSecret?: string,
  sub?: string,                     // required if using authSecret/adminSecret
  tenant?: string,                  // multi-tenant deployments only
  expiresIn?: string,               // "24h" | "30d" | "1y" | "never" (default "30d")
  timeout?: number,                 // default fetch timeout in ms (default 30_000)
  maxRetries?: number,              // 5xx / 429 retries with jitter (default 3)
  userAgent?: string,               // defaults to "sql-fs-sdk/<ver>"
  fetch?: typeof globalThis.fetch,  // bring-your-own (e.g. for mocks)
  maxFileSize?: number,             // per-file ceiling in bytes (default 64 MiB); 0 disables
})
```

**Validation:** the constructor throws `Error` if you pass none of
`token / authSecret / adminSecret`, or if you pass a secret without `sub`.

**Token bootstrap is lazy.** Constructing the `Client` does not hit the network —
the JWT is minted on the first request that needs it (or when you call
`client.getToken()`).

**`maxFileSize` (bytes, default 64 MiB).** A per-file ceiling enforced
**client-side**, before any content is base64-encoded or sent over the network.
It applies to every write path — `sb.ingestFiles(...)`, `sb.fs.write(...)`, and
`sb.fs.writeFiles(...)`. A file larger than the limit throws `ValidationError`
(code `EFILE_TOO_LARGE`) naming each offending path and its size; nothing is
transmitted. The limit is threaded down to every `Sandbox` the client creates or
attaches. Set `maxFileSize: 0` to disable the check entirely.

```typescript
new Client({ baseUrl, authSecret, sub: "agent", maxFileSize: 128 * 1024 * 1024 });  // raise to 128 MiB
new Client({ baseUrl, authSecret, sub: "agent", maxFileSize: 0 });                  // disable
```

> The `maxFileSize` check is separate from the 8 MiB `python3` read limit that
> `ingestFiles` enforces — see `ref/sandbox.md`. A file between 8 MiB and
> `maxFileSize` ingests fine but can't be read by the `python3` runtime unless
> you pass `{ allowOversized: true }`.

> Sizing note: the server caps the whole HTTP request body (default 256 MB) and
> base64 inflates content ~33%, so the practical per-request ceiling is ~190 MB
> of raw bytes regardless of `maxFileSize`. The default 64 MiB keeps a single
> file well inside that, with margin for batching several files in one ingest.

---

## Releasing resources

There is no context manager in TS. Always call `client.close()` in a `finally`:

```typescript
const client = new Client({ baseUrl, token });
try {
  await client.sandboxes.list();
} finally {
  client.close();
}
```

---

## Properties & methods

| Member | Type | Notes |
|---|---|---|
| `client.token` | `string \| undefined` | The current JWT, or `undefined` before bootstrap. Sync getter. |
| `client.getToken()` | `Promise<string>` | Forces bootstrap from `authSecret`/`adminSecret` if needed, then returns the cached JWT. |
| `client.close()` | `void` | Releases the transport. |

---

## `client.sandboxes` — sandbox CRUD

A namespaced resource exposing the four sandbox lifecycle operations plus a
zero-cost `attach()` for reusing an existing id.

### `client.sandboxes.list(): Promise<SandboxRecord[]>`

Maps to `GET /v1/sandboxes`. Returns sandboxes owned by the caller's `sub`.

```typescript
for (const s of await client.sandboxes.list()) {
  console.log(s.id, s.name, s.createdAt);
}
```

### `client.sandboxes.create(options?): Promise<Sandbox>`

Maps to `POST /v1/sandboxes`. Returns a `Sandbox` handle bound to the new id,
ready for `exec` / `ingestFiles`.

```typescript
const sb = await client.sandboxes.create({
  name: "my-project",                       // human label, optional
  env: { GREETING: "hi" },                   // initial sandbox env vars
  files: { "/home/user/seed.txt": "..." },   // text-only seed (use ingestFiles for many/binary)
  python: false,                             // enable CPython WASM runtime
  javascript: false,                         // enable QuickJS runtime
  network: false,                            // enable outbound fetch() from js-exec (opt-in)
});
```

All options are optional — `client.sandboxes.create()` is valid and creates
an anonymous sandbox.

**`network: true` — enabling outbound fetch()**

Pass `network: true` together with `javascript: true` to allow `fetch()` calls
inside `js-exec` scripts to reach external HTTP endpoints:

```typescript
const sb = await client.sandboxes.create({ javascript: true, network: true });
const r = await sb.exec(`js-exec -c '
  fetch("https://httpbin.org/get")
    .then(r => r.json())
    .then(d => console.log("origin:", d.origin))
'`);
console.log(r.stdout);   // origin: <your-ip>
```

- **Bash remains air-gapped.** Even with `network: true`, the Bash shell has
  no `curl`, `wget`, DNS, or raw socket access. Only `fetch()` inside `js-exec`
  gains outbound HTTP.
- **Opt-in, default `false`.** Omitting `network` (or passing `network: false`)
  produces a fully isolated sandbox.
- **js-exec timeout extends to 60 s** when network is enabled.

### `client.sandboxes.get(sandboxId): Promise<SandboxInfo>`

Maps to `GET /v1/sandboxes/{id}`. Use this when you have an id and need to
verify ownership / read `lastUsedAt`. Throws `NotFoundError` (404) or
`AuthError` (403) for a sandbox owned by a different `sub`.

### `client.sandboxes.attach(sandboxId): Sandbox`

**No network call. Synchronous.** Returns a `Sandbox` handle for an existing id.
Use this to resume work on a long-lived sandbox without paying a `GET`
round-trip. Combine with `.get()` if you need to verify the sandbox first.

```typescript
const sb = client.sandboxes.attach(process.env.SANDBOX_ID!);
const result = await sb.exec("ls /home/user");
```

### `client.sandboxes.delete(sandboxId): Promise<void>`

Maps to `DELETE /v1/sandboxes/{id}`. Destroys the sandbox and orphans its
blobs (which are GC'd by the server's blob-GC job).

```typescript
await client.sandboxes.delete(sb.id);
// Equivalent: await sb.delete();
```

Throws `NotFoundError` if the id doesn't exist or `AuthError` if owned by a
different `sub`.

---

## Retry & error policy

The `Client` retries up to `maxRetries` times on **transient** failures only:

| Status | Retried? |
|---|---|
| 200–299 | n/a (success) |
| 400 / 404 / 408 / 409 | **No** — surfaced immediately as typed errors |
| 401 / 403 | **No** — surfaced immediately as `AuthError` |
| 429 | **Yes** — honours `Retry-After` header if present, else exponential jitter |
| 5xx | **Yes** — exponential jitter |
| network (DNS, TCP, TLS, timeout) | **Yes** — exponential jitter |

`exec` / `execBatch` are only retried when `readOnly` or `retryOn5xx` is set
(otherwise the server can't safely re-run them). `execStream` is **never**
retried — at-most-once semantics. After `maxRetries` exhaustion the SDK throws
`ServerError` (for 5xx) or `TransportError` (for network failures).

See `plugins/sql-fs/skills/ts-sdk/ref/errors.md` for the full error hierarchy.

---

## Common patterns

### Long-lived agent process — keep one `Client`

```typescript
class Agent {
  readonly client: Client;
  constructor() {
    this.client = new Client({
      baseUrl: process.env.BASE_URL!,
      authSecret: process.env.AUTH_SECRET!,
      sub: "agent",
    });
  }
  close() {
    this.client.close();
  }
}
```

The bootstrap hits the wire once. Subsequent calls reuse the cached JWT.

### Short-lived script — try/finally

```typescript
const client = new Client({ baseUrl, authSecret, sub: "cli" });
try {
  const sb = await client.sandboxes.create({ name: "cli-run" });
  try {
    // ...
  } finally {
    await client.sandboxes.delete(sb.id);
  }
} finally {
  client.close();
}
```

### Custom `fetch` (e.g. for tests, proxies, instrumentation)

```typescript
const client = new Client({ baseUrl, token, fetch: myInstrumentedFetch });
```

The SDK uses the supplied `fetch` for every request; it does not own or close it.
