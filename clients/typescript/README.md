# sql-fs-sdk

Official TypeScript client for the SQL-FS API: persistent bash sandboxes for AI agents.

```bash
npm install sql-fs-sdk
```

Local development from this repo:

```bash
cd clients/typescript
pnpm install
pnpm test
```

## Quick Start

```ts
import { Client } from "sql-fs-sdk";

const client = new Client({
	baseUrl: "https://api.example.com",
	authSecret: process.env.AUTH_SECRET!,
	sub: "agent-001",
});

const sandbox = await client.sandboxes.create({ name: "demo", python_runtime: "stdlib" });

const result = await sandbox.exec("echo hello && ls /home/user");
console.log(result.stdout, result.exitCode, result.ok);

await sandbox.fs.write("/home/user/main.py", "print('hi')\n");
console.log(await sandbox.fs.readText("/home/user/main.py"));

for await (const event of sandbox.execStream("for i in 1 2 3; do echo $i; done")) {
	if (event.type === "stdout") {
		process.stdout.write(event.data ?? "");
	}
}

await sandbox.delete();
client.close();
```

Admin token minting requires both an existing caller JWT and the server's admin secret:

```ts
const adminClient = new Client({
	baseUrl: "https://api.example.com",
	token: callerJwt,
	adminSecret: process.env.ADMIN_SECRET!,
	sub: "target-agent",
});
const targetJwt = await adminClient.getToken();
```

## API Surface

- `client.sandboxes.list()`
- `client.sandboxes.create({ name, env, files, python_runtime, javascript, network })`
- `client.sandboxes.get(id)`
- `client.sandboxes.attach(id)`
- `client.sandboxes.delete(id)`
- `sandbox.fs.read(path)`, `readText(path)`, `write(path, content)`, `writeFiles(files)`, `delete(path, { recursive })`, `mkdir(path, { recursive })`, `tree({ prefix, depth })`
- `sandbox.exec(script, { cwd, env, timeoutMs, debug, readOnly, retryOn5xx })`
- `sandbox.execBatch([{ id, script }], { timeoutMs, perScriptTimeoutMs, readOnly, retryOn5xx })`
- `sandbox.execStream(script, { cwd, env, timeoutMs, debug, readOnly })`
- `sandbox.ingestFiles(files, { basePath })`
- `sandbox.delete()`

`Client({ maxFileSize })` defaults to 64 MiB per file and is enforced before write or ingest requests are sent. Set `maxFileSize: 0` to disable the client-side check.

All SDK errors derive from `SQLFSError`; status-specific subclasses include `AuthError`, `NotFoundError`, `ConflictError`, `ValidationError`, `ExecTimeoutError`, `RateLimitError`, `ServerError`, and `TransportError`.
