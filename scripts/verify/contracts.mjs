#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LocalApiRun, repo } from "./local-api.mjs";

const run = new LocalApiRun("contracts");
const coverage = [];
let failure;
try {
	const server = await run.start();
	const owner = await run.owner();
	const request = async (method, path, options = {}) => (await run.request(server, owner, method, path, options)).body;
	const exec = async (sandbox, script, options = {}) =>
		request("POST", `${sandbox.path}/exec-sync`, { json: { script, ...options } });
	run.equal((await run.request(server, null, "GET", "/healthz")).body.status, "ok", "Health is ok");
	run.equal((await run.request(server, null, "GET", "/readyz")).body.status, "ok", "Redis-aware readiness is ok");
	const metrics = (await run.request(server, owner, "GET", "/metrics")).body.toString();
	const workersEnabled = process.env.SQL_FS_WORKERS_ENABLED === "true";
	run.equal(metrics.includes(`sql_fs_workers_enabled ${workersEnabled ? 1 : 0}\n`), true, "Worker feature metric");
	run.equal(metrics.includes(`sql_fs_ingress_enabled ${workersEnabled ? 1 : 0}\n`), true, "Ingress feature metric");
	if (workersEnabled) {
		run.equal(metrics.includes(`sql_fs_worker_capacity ${process.env.SQL_FS_WORKER_COUNT ?? 2}\n`), true, "Fixed worker capacity metric");
		run.equal(metrics.includes("# TYPE sql_fs_worker_queue_wait_milliseconds histogram"), true, "Queue delay histogram exported");
	}
	const spec = (await run.request(server, null, "GET", "/openapi.json")).body;
	run.equal(spec.info.title, "SQL-FS API", "OpenAPI identity");
	run.enableOpenApiValidation(spec);
	run.equal(
		spec.info.version,
		JSON.parse(readFileSync(join(repo, "package.json"))).version,
		"OpenAPI checkout version",
	);
	await run.request(server, null, "GET", "/v1/sandboxes", { status: 401 });
	await run.request(server, null, "POST", "/v1/auth/bootstrap", {
		headers: { "X-Auth-Secret": "incorrect-verification-secret" },
		json: { sub: owner.sub },
		status: 403,
		validateRequestSchema: false,
	});
	const authenticated = await run.request(server, null, "POST", "/v1/auth/bootstrap", {
		headers: { "X-Auth-Secret": process.env.AUTH_SECRET },
		json: { sub: owner.sub, expiresIn: "24h" },
		status: 201,
	});
	run.equal(typeof authenticated.body.token, "string", "Bootstrap token issued");
	owner.token = authenticated.body.token;
	const sandbox = await run.create(server, owner, { files: { "/home/user/seed.txt": "persisted seed\n" } });
	run.equal((await request("GET", sandbox.path)).owner, owner.sub, "Sandbox metadata owner");
	run.equal(
		(await request("GET", `${sandbox.path}/files/home/user/seed.txt`)).toString(),
		"persisted seed\n",
		"Creation persists seed bytes",
	);
	const outsider = await run.owner();
	await run.request(server, outsider, "GET", sandbox.path, { status: 403, validateRequestSchema: false });
	coverage.push("sandbox-lifecycle");

	const first = await exec(sandbox, 'printf "execution-proof\\n" > /home/user/proof.txt; cat /home/user/proof.txt');
	run.equal([first.exitCode, first.stdout], [0, "execution-proof\n"], "Bash stdout and exit");
	run.equal(
		(await request("GET", `${sandbox.path}/files/home/user/proof.txt`)).toString(),
		"execution-proof\n",
		"Bash write independently visible",
	);
	run.equal(
		(await exec(sandbox, "cat /home/user/proof.txt", { readOnly: true })).stdout,
		"execution-proof\n",
		"Read-only reads committed bytes",
	);
	const denied = await request("POST", `${sandbox.path}/exec-sync`, {
		json: { script: "echo forbidden > /home/user/forbidden.txt", readOnly: true },
		status: 422,
	});
	run.equal(denied.code, "EREADONLY_VIOLATION", "Read-only rejection code");
	await request("GET", `${sandbox.path}/files/home/user/forbidden.txt`, { status: 404 });
	const stream = (
		await request("POST", `${sandbox.path}/exec`, { json: { script: 'printf "stream-proof\\n"' } })
	).toString();
	const events = stream
		.split(/\r?\n\r?\n/)
		.filter((block) => block.includes("data:"))
		.map((block) => {
			const lines = block.split(/\r?\n/);
			return {
				event: lines
					.find((line) => line.startsWith("event:"))
					?.slice(6)
					.trim(),
				data: JSON.parse(
					lines
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).trim())
						.join("\n"),
				),
			};
		});
	run.equal(
		events
			.filter((event) => event.event === "stdout")
			.map((event) => event.data.data)
			.join(""),
		"stream-proof\n",
		"SSE stdout",
	);
	run.equal(events.filter((event) => event.event === "exit").map((event) => event.data.exitCode), [0], "Exactly one SSE terminal exit");
	const batch = await request("POST", `${sandbox.path}/exec-sync-batch`, {
		json: {
			scripts: [
				{ id: "first", script: "echo batch-one" },
				{ id: "second", script: "echo batch-two" },
			],
		},
	});
	run.equal(
		batch.results.map((item) => [item.id, item.exitCode, item.stdout]),
		[
			["first", 0, "batch-one\n"],
			["second", 0, "batch-two\n"],
		],
		"Batch results and IDs",
	);
	try {
		const timeout = await run.request(server, owner, "POST", `${sandbox.path}/exec-sync`, {
			json: {
				script: "echo prefix > /home/user/prefix.txt; sleep 2; echo suffix > /home/user/suffix.txt",
				timeoutMs: 100,
			},
			status: null,
		});
		run.equal(
			(await request("GET", `${sandbox.path}/files/home/user/prefix.txt`)).toString(),
			"prefix\n",
			"Cooperative timeout commits completed prefix",
		);
		await request("GET", `${sandbox.path}/files/home/user/suffix.txt`, { status: 404 });
		run.equal(timeout.status, 408, "Cooperative timeout HTTP status");
		run.equal(timeout.body.code, "EXEC_TIMEOUT", "Cooperative timeout code");
	} catch (error) {
		failure ??= error;
	}
	coverage.push("bash-execution", "read-only", "sse", "batch", "timeout-prefix");

	await request("POST", `${sandbox.path}/mkdir`, { json: { path: "/home/user/verify", recursive: true }, status: 204 });
	await request("PUT", `${sandbox.path}/files/home/user/verify/note.txt`, { raw: "before\n", status: 204 });
	run.equal(
		(await request("GET", `${sandbox.path}/files/home/user/verify/note.txt`)).toString(),
		"before\n",
		"Raw file bytes",
	);
	run.equal(
		(
			await request("PATCH", `${sandbox.path}/files/home/user/verify/note.txt`, {
				json: { oldString: "before", newString: "after" },
			})
		).replacements,
		1,
		"One edit replacement",
	);
	run.equal(
		(await request("GET", `${sandbox.path}/files/home/user/verify/note.txt`)).toString(),
		"after\n",
		"Edited bytes independently visible",
	);
	await request("POST", `${sandbox.path}/writeFiles`, {
		json: { files: { "/home/user/verify/one.txt": "one\n", "/home/user/verify/two.txt": "two\n" } },
		status: 204,
	});
	const tree = await request("GET", `${sandbox.path}/tree?prefix=/home/user/verify&depth=3`);
	for (const name of ["note.txt", "one.txt", "two.txt"])
		run.equal(
			tree.some((item) => item.path === `/home/user/verify/${name}`),
			true,
			`Tree contains ${name}`,
		);
	run.equal(
		(await exec(sandbox, "cat /home/user/verify/one.txt /home/user/verify/two.txt", { readOnly: true })).stdout,
		"one\ntwo\n",
		"Bulk write visible to bash",
	);
	await request("DELETE", `${sandbox.path}/files/home/user/verify/note.txt`, { status: 204 });
	await request("GET", `${sandbox.path}/files/home/user/verify/note.txt`, { status: 404 });
	coverage.push("file-operations");

	const originals = { "greeting.txt": "hello-from-ingest\n", "nested/second.txt": "second-file\n" };
	const ingested = await request("POST", `${sandbox.path}/ingest-files`, {
		json: {
			basePath: "/home/user/ingested",
			files: Object.fromEntries(
				Object.entries(originals).map(([name, text]) => [name, Buffer.from(text).toString("base64")]),
			),
		},
	});
	run.equal(ingested.fileCount, 2, "Ingest reports file count");
	for (const [name, text] of Object.entries(originals))
		run.equal(
			(await request("GET", `${sandbox.path}/files/home/user/ingested/${name}`)).toString(),
			text,
			`Ingested ${name} bytes`,
		);
	const exported = await exec(sandbox, "tar -czf - -C /home/user/ingested . | base64 -w 0", { readOnly: true });
	run.equal(exported.exitCode, 0, "Bash archive export exit");
	const archive = join(run.evidence, "export.tar.gz");
	writeFileSync(archive, Buffer.from(exported.stdout.trim(), "base64"));
	const manifest = JSON.parse(
		execFileSync(
			"python3",
			[
				"-c",
				'import tarfile,json,sys\nwith tarfile.open(sys.argv[1],"r:gz") as t:\n print(json.dumps({m.name.removeprefix("./"):t.extractfile(m).read().decode() for m in t.getmembers() if m.isfile()}))',
				archive,
			],
			{ encoding: "utf8" },
		),
	);
	run.equal(manifest, originals, "Export contains exact original files");
	coverage.push("ingest-export");

	const peer = await run.start();
	run.equal(
		(await run.request(peer, owner, "GET", `${sandbox.path}/files/home/user/proof.txt`)).body.toString(),
		"execution-proof\n",
		"Cold replica reads persisted bytes",
	);
	await request("PUT", `${sandbox.path}/files/home/user/proof.txt`, { raw: "updated by primary\n", status: 204 });
	run.equal(
		(await run.request(peer, owner, "GET", `${sandbox.path}/files/home/user/proof.txt`)).body.toString(),
		"updated by primary\n",
		"Warm replica refreshes after peer commit",
	);
	coverage.push("cross-replica-coherence");

	const runtime = await run.create(server, owner, { python: true, javascript: true });
	const git = await exec(
		runtime,
		"git init /repo && printf 'git-proof\\n' > /repo/proof.txt && git -C /repo add proof.txt && git -C /repo -c user.name=Verifier -c user.email=verify@example.invalid commit -m proof && git -C /repo show HEAD:proof.txt",
	);
	run.equal(git.exitCode, 0, "Custom git command exit");
	assert.ok(git.stdout.endsWith("git-proof\n"));
	run.equal(
		(await request("GET", `${runtime.path}/files/repo/proof.txt`)).toString(),
		"git-proof\n",
		"Git worktree persisted",
	);
	const javascript = await exec(runtime, 'node -e "console.log(6 * 7)"');
	run.equal([javascript.exitCode, javascript.stdout], [0, "42\n"], "JavaScript runtime command");
	const python = await exec(runtime, "python3 -c 'print(6 * 7)'", { timeoutMs: 120000 });
	run.equal([python.exitCode, python.stdout], [0, "42\n"], "Python runtime command");
	coverage.push("custom-git", "javascript-runtime", "python-runtime");

	const client = new Client({ name: "sql-fs-worker-verifier", version: "1.0.0" });
	run.clients.push(client);
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), {
			requestInit: { headers: { Authorization: `Bearer ${owner.token}` } },
		}),
	);
	const tool = async (name, args) => {
		const response = await client.callTool({ name, arguments: { id: sandbox.id, ...args } });
		run.record({ transport: "mcp", name, args, response });
		assert.notEqual(response.isError, true, `MCP ${name} error`);
		return JSON.parse(response.content[0].text);
	};
	run.equal(
		(await tool("file_write", { path: "/home/user/mcp.txt", content: "mcp-proof\n" })).ok,
		true,
		"MCP file write",
	);
	run.equal((await tool("file_read", { path: "/home/user/mcp.txt" })).content, "mcp-proof\n", "MCP file read");
	run.equal(
		(await tool("bash_exec", { script: "cat /home/user/mcp.txt", readOnly: true })).stdout,
		"mcp-proof\n",
		"MCP bash reads same owner filesystem",
	);
	run.equal(
		(await run.request(peer, owner, "GET", `${sandbox.path}/files/home/user/mcp.txt`)).body.toString(),
		"mcp-proof\n",
		"MCP write visible on peer REST replica",
	);
	coverage.push("mcp-transport");
} catch (error) {
	failure = error;
} finally {
	await run.finish(failure, { coverage, workerEnabled: process.env.SQL_FS_WORKERS_ENABLED });
}
