# sql-fs-sdk (TypeScript)

TypeScript client for the [SQL-FS API](https://github.com/Hazzng/sql-fs), which runs persistent bash sandboxes for AI agents. The SDK mints JWTs, retries safe requests, maps HTTP errors to error classes, and parses streamed exec output.

## Install the SDK

```bash
npm install sql-fs-sdk
```

The package is ESM only and needs Node.js 22 or later. To work on the SDK from a checkout of this repo:

1. Run `cd clients/typescript`.
2. Run `pnpm install`.
3. Run `pnpm test`.

## Create a sandbox and run a script

```ts
import { Client } from "sql-fs-sdk";

const client = new Client({
	baseUrl: "https://api.example.com",
	authSecret: process.env.AUTH_SECRET!,
	sub: "agent-001",
});

const sandbox = await client.sandboxes.create({ name: "demo", python: true });
try {
	const result = await sandbox.exec("echo hello && ls /home/user");
	console.log(result.stdout, result.exitCode, result.ok);

	await sandbox.fs.write("/home/user/main.py", "print('hi')\n");
	console.log(await sandbox.fs.readText("/home/user/main.py"));
} finally {
	await sandbox.delete();
}
```

`ExecResult` has `stdout`, `stderr`, `exitCode`, `exitSignal`, `timedOut`, `durationMs`, and `ok`. The `error` property is an alias for `stderr`.

## Authenticate and configure the client

The `Client` constructor takes one of three credentials:

- `authSecret` and `sub`. On the first request, the SDK exchanges the secret for a JWT at `POST /v1/auth/bootstrap`. It also sends `tenant` and `expiresIn` (default `"30d"`) when you set them.
- `token`, a JWT you already have. To mint one from the repo root, run `pnpm token:create`.
- `token`, `adminSecret`, and `sub`. The SDK uses your JWT and the server's admin secret to mint a JWT for `sub` at `POST /v1/auth/admin`. The client then acts as `sub`. You cannot combine `adminSecret` with `authSecret`.

```ts
const adminClient = new Client({
	baseUrl: "https://api.example.com",
	token: callerJwt,
	adminSecret: process.env.ADMIN_SECRET!,
	sub: "target-agent",
});
const targetJwt = await adminClient.getToken();
```

`await client.getToken()` returns the current JWT and mints it if needed. `client.token` stays `undefined` until a JWT exists.

The other options are `timeout` in milliseconds per request (default `30000`), `maxRetries` (default `3`), `userAgent`, `fetch`, and `maxFileSize`. Pass `fetch` to replace `globalThis.fetch`.

`maxFileSize` caps each file that `fs.write`, `fs.writeFiles`, and `ingestFiles` send. The default is 64 MiB, and `0` turns the check off. The SDK checks the size before it sends anything. An oversized file throws `ValidationError` with `code: "EFILE_TOO_LARGE"` and no `status`.

The server has its own limits. By default it accepts 50 MiB per file in `fs.write` and `fs.writeFiles`, and 50 MiB in total per `fs.writeFiles` call (`MAX_FILE_WRITE_BYTES` and `MAX_BULK_WRITE_BYTES`). Above a limit, it returns 413, which the SDK throws as `ValidationError`.

## Methods and defaults

```ts
client.sandboxes.create({ name, env, files, python, javascript, network }); // -> Sandbox
client.sandboxes.list();             // -> SandboxRecord[]
client.sandboxes.get(id);            // -> SandboxInfo
client.sandboxes.attach(id);         // -> Sandbox, no network call
client.sandboxes.delete(id);         // same as sandbox.delete()

sandbox.fs.read(path);               // -> ReadResult with content (Uint8Array), stat, and text()
sandbox.fs.readText(path);           // -> string
sandbox.fs.write(path, content);     // string, Uint8Array, or ArrayBuffer, creates parent directories
sandbox.fs.writeFiles({ [path]: text }); // many text files in one request
sandbox.fs.delete(path, { recursive: false });
sandbox.fs.mkdir(path, { recursive: false });
sandbox.fs.tree({ prefix, depth });  // -> TreeEntry[]
sandbox.ingestFiles({ [relativePath]: content }, { basePath: "/home/user/project" }); // base64 upload

sandbox.exec(script, { cwd, env, timeoutMs: 30000, debug: false, readOnly: false, retryOn5xx: false });
sandbox.execBatch(scripts, { timeoutMs: 30000, perScriptTimeoutMs, readOnly: false, retryOn5xx: false });
sandbox.execStream(script, { cwd, env, timeoutMs: 30000, debug: false, readOnly: false });
```

Three `create` flags turn on runtimes, and all three default to `false`:

- `python: true` enables `python3`, which is CPython on WASM with the standard library only.
- `javascript: true` enables `js-exec` and `node`, which run on QuickJS.
- `network: true` allows outbound network access.

Each `python3` call starts a fresh interpreter. Keep state in files, and run multi-step Python as one script.

## Put each read-modify-write in one exec call

Each exec call holds the sandbox lock for its whole script. Between two calls, another caller can write. To update a file based on its contents, do both in one script:

```ts
await sandbox.exec("n=$(cat count.txt); echo $((n + 1)) > count.txt");
```

The server accepts `timeoutMs` up to 300000. If a script runs longer than `timeoutMs`, `exec` throws `ExecTimeoutError`.

With `readOnly: true`, the call takes a shared read lock, so read-only calls run in parallel. If a read-only script writes to the filesystem, it fails with `EREADONLY_VIOLATION` (HTTP 422).

`execBatch` runs up to 50 `{ id, script }` objects and returns the results in input order:

- By default, the scripts run one after another under one write lock and share shell state. A batch saves round trips but not CPU time.
- With `readOnly: true`, the scripts run in parallel.
- `timeoutMs` is one budget for the whole batch. Scripts that the budget does not reach return `exitCode: -1` and `error: "timeout"`. To give each script its own budget, set `perScriptTimeoutMs`. `timeoutMs` stays the overall limit.

To search for several patterns, use one `grep -E 'a|b|c'`, which reads the files once. A batch of separate greps reads the files once per pattern.

`execStream` yields `StreamEvent` objects of type `"stdout"`, `"stderr"`, or `"exit"`, and stops after `"exit"`:

```ts
for await (const event of sandbox.execStream("for i in 1 2 3; do echo $i; sleep 1; done")) {
	if (event.type === "stdout") process.stdout.write(event.data ?? "");
	if (event.type === "exit") console.log(`exit=${event.exitCode} in ${event.durationMs}ms`);
}
```

## Errors map to error classes by HTTP status

Every error extends `SQLFSError` and has `code` (for example `ENOENT`), `status`, `details`, and `retryable`.

| Status | Error |
|---|---|
| 400, 413, 422 | `ValidationError` |
| 401, 403 | `AuthError` |
| 404 | `NotFoundError` |
| 408 | `ExecTimeoutError`, with `durationMs` |
| 409 | `ConflictError` |
| 429 | `RateLimitError`, with `retryAfter` in seconds |
| 5xx | `ServerError` |
| No response | `TransportError` |

## Retries never replay an exec with an unknown outcome

The SDK retries network errors and 429, 500, 502, 503, and 504 responses up to `maxRetries` times. It waits for `Retry-After` when the server sends one, and uses jittered backoff otherwise. It does not retry other 4xx responses, responses marked `retryable: false`, `sandboxes.create`, or `execStream`.

`exec` and `execBatch` retry only if two things are true. You passed `readOnly: true` or `retryOn5xx: true`, and the server marked the error `retryable: true`. A retry runs the whole script or batch again. Set `retryOn5xx: true` only for scripts that are safe to repeat.

The SDK never retries the codes `EEXEC_OUTCOME_UNKNOWN`, `ECOHERENCE`, and `ELOCKLOST_APPLIED`. `ECOHERENCE` and `ELOCKLOST_APPLIED` mean that the write was applied.

An exec outcome is unknown when you get a `ServerError` with code `EEXEC_OUTCOME_UNKNOWN`, or a `TransportError` whose message starts with `script outcome unknown`. The script may have run, and earlier scripts in a batch may have committed. Read the sandbox state before you run anything else.

## Further reading

- [SQL-FS server README](https://github.com/Hazzng/sql-fs#readme). A running server also serves its OpenAPI spec at `/openapi.json` and a Swagger UI at `/docs`.
- [TypeScript SDK changelog](https://github.com/Hazzng/sql-fs/blob/main/clients/typescript/CHANGELOG.md)
- [TypeScript quick-start example](https://github.com/Hazzng/sql-fs/blob/main/clients/typescript/examples/quickstart.ts)
