#!/usr/bin/env node
import { once } from "node:events";
import { createServer } from "node:http";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import postgres from "postgres";
import { LocalApiRun, repo, sha256 } from "./local-api.mjs";

const run = new LocalApiRun("input-budgets");
const limitBytes = 128;
const markerPrefix = `/home/user/input-verify-${run.runId}-`;
const files = {
	"/home/user/counter": "original\n",
	"/home/user/a": "a".repeat(70),
	"/home/user/b": "b".repeat(70),
	"/home/user/exact": "c".repeat(limitBytes),
	"/home/user/above": "d".repeat(limitBytes + 1),
	"/home/user/unicode-exact": "😀".repeat(32),
	"/home/user/unicode-above": "😀".repeat(33),
};
const cases = [
	{ name: "above-boundary", command: "cat /home/user/above", attemptedBytes: 129 },
	{ name: "utf8-boundary", command: "cat /home/user/unicode-above", attemptedBytes: 132 },
	{ name: "two-files", command: "cat /home/user/a /home/user/b", attemptedBytes: 140 },
	{ name: "warm-repeat", command: "cat /home/user/a /home/user/a", attemptedBytes: 140 },
	{ name: "wc", command: "wc -c /home/user/a /home/user/b", attemptedBytes: 140 },
	{
		name: "substitution",
		command: 'a=$(</home/user/a); b=$(</home/user/b); printf \'%s%s\' "$a" "$b"',
		attemptedBytes: 140,
	},
	{
		name: "javascript-bridge",
		command: `js-exec -c 'const fs=require("fs"); console.log(fs.readFileSync("/home/user/a").length+fs.readFileSync("/home/user/b").length)'`,
		attemptedBytes: 140,
	},
	{
		name: "python-bridge",
		command: `python3 -c 'print(len(open("/home/user/a","rb").read())+len(open("/home/user/b","rb").read()))'`,
		attemptedBytes: 140,
	},
	{ name: "sse", command: "wc -c /home/user/a /home/user/b", attemptedBytes: 140, transport: "sse" },
	{ name: "batch", command: "wc -c /home/user/a /home/user/b", attemptedBytes: 140, transport: "batch" },
	{ name: "mcp", command: "wc -c /home/user/a /home/user/b", attemptedBytes: 140, transport: "mcp" },
	{ name: "mcp-batch", command: "wc -c /home/user/a /home/user/b", attemptedBytes: 140, transport: "mcp-batch" },
];
const results = [];
const sandboxIds = [];
let overlap;
let failure;

async function overlappingReads(server, owner, sandbox, PostgresDialect, SqlFs) {
	const waiting = new Map();
	const trace = [];
	let entered;
	const bothEntered = new Promise((resolve) => {
		entered = resolve;
	});
	const barrier = createServer((request, response) => {
		const name = request.url?.slice(1);
		if (!["rejected", "healthy"].includes(name) || waiting.has(name)) {
			response.writeHead(404).end();
			return;
		}
		waiting.set(name, response);
		trace.push({
			phase: "marker-read-entered-barrier",
			name,
			atMs: performance.now(),
			threadId: Number(request.headers["x-input-verify-thread"]),
			contextId: Number(request.headers["x-input-verify-context"]),
			readCalls: Number(request.headers["x-input-verify-read-calls"]),
			inputBytes: Number(request.headers["x-input-verify-bytes"]),
			inputLimitBytes: Number(request.headers["x-input-verify-limit"]),
			sandboxId: request.headers["x-input-verify-sandbox"],
		});
		if (waiting.size === 2) entered();
	});
	barrier.listen(0, "127.0.0.1");
	await once(barrier, "listening");
	const address = barrier.address();
	const requests = [];
	let timer;
	let healthyCompleted = false;
	try {
		const markers = Object.fromEntries(
			["rejected", "healthy"].map((name) => [name, `${markerPrefix}${address.port}-${name}`]),
		);
		for (const path of Object.values(markers)) {
			await run.request(server, owner, "PUT", `${sandbox.path}/files${path}`, { raw: "", status: 204 });
		}
		const command = (name, reads) => `cat ${markers[name]}; wc -c ${reads}`;
		const rejected = run.request(server, owner, "POST", `${sandbox.path}/exec-sync`, {
			json: { script: command("rejected", "/home/user/a /home/user/a"), readOnly: true, timeoutMs: 20000 },
			status: 413,
			timeoutMs: 30000,
		});
		requests.push(rejected);
		const healthy = run
			.request(server, owner, "POST", `${sandbox.path}/exec-sync`, {
				json: { script: command("healthy", "/home/user/a"), readOnly: true, timeoutMs: 20000 },
				timeoutMs: 30000,
			})
			.then((response) => {
				healthyCompleted = true;
				return response;
			});
		requests.push(healthy);
		await Promise.race([
			bothEntered,
			...requests.map((request) =>
				request.then(() => {
					throw new Error("A readonly request ended before both scripts reached the barrier");
				}),
			),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("Both readonly scripts did not reach the barrier")), 5000);
			}),
		]);
		clearTimeout(timer);
		const arrivals = trace.filter((event) => event.phase === "marker-read-entered-barrier");
		run.equal(arrivals.length, 2, "Each marker performs exactly one underlying read and barrier wait");
		run.equal(arrivals.map(({ readCalls }) => readCalls), [1, 1], "Each barrier follows exactly one canonical filesystem read call");
		run.equal(arrivals[0].threadId > 0, true, "Marker tracing runs in an owner worker thread");
		run.equal(arrivals[0].threadId, arrivals[1].threadId, "Both active input contexts use the same worker thread");
		run.equal(arrivals[0].contextId !== arrivals[1].contextId, true, "Overlapping scripts have distinct active input contexts");
		run.equal(
			arrivals.map(({ inputBytes, inputLimitBytes, sandboxId }) => [inputBytes, inputLimitBytes, sandboxId]),
			[
				[0, limitBytes, sandbox.id],
				[0, limitBytes, sandbox.id],
			],
			"Empty marker reads preserve the canonical charge inside two active input contexts",
		);
		const metrics = (await run.request(server, owner, "GET", "/metrics")).body.toString();
		const value = (name) => Number(metrics.match(new RegExp(`^sql_fs_worker_${name} (\\d+)$`, "m"))?.[1]);
		run.equal(
			[value("capacity"), value("busy"), value("resident_sessions"), value("running_operations")],
			[3, 1, 1, 2],
			"Both executing scripts overlap on one resident worker within the tenant active quota",
		);
		trace.push({ phase: "release-rejected", atMs: performance.now() });
		waiting.get("rejected").writeHead(200, { "Content-Length": "0" }).end();
		const rejectedResult = await rejected;
		trace.push({ phase: "rejected-completed", atMs: performance.now() });
		run.equal(rejectedResult.body.code, "EEXEC_INPUT_LIMIT", "Overlapping 140-byte readonly input is rejected");
		run.equal(rejectedResult.body.retryable, false, "Overlapping input failure cannot invite replay");
		run.equal(healthyCompleted, false, "Healthy script remains running after its neighbor's sticky error");
		trace.push({ phase: "release-healthy", atMs: performance.now() });
		waiting.get("healthy").writeHead(200, { "Content-Length": "0" }).end();
		const healthyResult = await healthy;
		trace.push({ phase: "healthy-completed", atMs: performance.now() });
		run.equal(
			[healthyResult.body.exitCode, healthyResult.body.stdout],
			[0, "70 /home/user/a\n"],
			"Overlapping healthy readonly exec retains its own 70-byte budget",
		);
		const dialect = new PostgresDialect(process.env.DATABASE_URL, undefined, 1);
		await dialect.connect();
		try {
			const fresh = new SqlFs({ dialect, sandboxId: sandbox.id });
			await fresh.ready();
			for (const [path, content] of Object.entries(files)) {
				run.equal(
					sha256(await fresh.readFileBuffer(path)),
					sha256(content),
					`Overlapping readonly execs preserve ${path}`,
				);
			}
			for (const path of Object.values(markers)) {
				run.equal(
					(await fresh.readFileBuffer(path)).byteLength,
					0,
					"Barrier marker bytes remain empty in fresh Postgres",
				);
			}
		} finally {
			await dialect.disconnect();
		}
		return { rejectedBytes: 140, healthyBytes: 70, limitBytes, sameResident: true, trace };
	} finally {
		clearTimeout(timer);
		for (const response of waiting.values()) {
			if (!response.writableEnded) response.end();
		}
		barrier.closeAllConnections();
		const closed = once(barrier, "close");
		barrier.close();
		await closed;
		await Promise.allSettled(requests);
		run.record({ case: "same-resident-overlapping-input", trace });
	}
}

try {
	const server = await run.start({
		SQL_FS_WORKERS_ENABLED: "true",
		SQL_FS_WORKER_COUNT: "3",
		SQL_FS_WORKER_ACTIVE_TENANT_MAX: "2",
		SQL_FS_WORKER_HEAP_MB: "256",
		SQL_FS_WORKER_MAX_PG_CONNECTIONS: "6",
		SQL_FS_WORKER_INPUT_BYTES: String(limitBytes),
		INPUT_VERIFY_PREFIX: markerPrefix,
		NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=./scripts/verify/input-faults.mjs`.trim(),
		JUST_BASH_DEFENSE_IN_DEPTH: "true",
		JUST_BASH_DEFENSE_AUDIT_MODE: "false",
	});
	const peer = await run.start({ SQL_FS_WORKERS_ENABLED: "false" });
	const owner = await run.owner();
	const sandbox = await run.create(server, owner, { javascript: true, python: true, files });
	sandboxIds.push(sandbox.id);
	const { PostgresDialect } = await import(join(repo, "dist/sql-fs/dialects/postgres.js"));
	const { SqlFs } = await import(join(repo, "dist/sql-fs/sql-fs.js"));
	const client = new Client({ name: "sql-fs-input-budget-verifier", version: "1.0.0" });
	run.clients.push(client);
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), {
			requestInit: { headers: { Authorization: `Bearer ${owner.token}` } },
		}),
	);
	const healthy = async () => {
		for (const path of ["/home/user/exact", "/home/user/unicode-exact"]) {
			const response = await run.request(server, owner, "POST", `${sandbox.path}/exec-sync`, {
				json: { script: `cat ${path}`, readOnly: true },
			});
			run.equal(
				[response.body.exitCode, response.body.stdout],
				[0, files[path]],
				"Exact UTF-8 input boundary remains usable after rejection",
			);
		}
	};
	await healthy();
	for (const [path, content] of Object.entries(files)) {
		run.equal(
			(await run.request(peer, owner, "GET", `${sandbox.path}/files${path}`)).body.toString(),
			content,
			"Warm rolling peer reads fixture bytes without exec budget",
		);
	}
	for (const { name, command, attemptedBytes, transport = "sync" } of cases) {
		const prefix = `/home/user/rejected-${name}.txt`;
		const script = `echo must-rollback > /home/user/counter; echo must-rollback > ${prefix}; ${command}`;
		let body;
		let status;
		if (transport === "mcp" || transport === "mcp-batch") {
			const response = await client.callTool({
				name: transport === "mcp" ? "bash_exec" : "bash_exec_batch",
				arguments:
					transport === "mcp"
						? { id: sandbox.id, script, timeout: 120000 }
						: {
								id: sandbox.id,
								scripts: [
									{ id: "rejected", script },
									{ id: "later", script: `echo must-not-run > /home/user/${name}-later.txt` },
								],
								timeout: 120000,
							},
			});
			run.record({ name, transport, response });
			run.equal(response.isError, true, "MCP input limit is an error result");
			body = JSON.parse(response.content[0].text);
			run.equal(response.structuredContent, body, "MCP text and structured input limit agree");
		} else if (transport === "sse") {
			const response = await run.request(server, owner, "POST", `${sandbox.path}/exec`, {
				json: { script, timeoutMs: 120000 },
			});
			status = response.status;
			const frames = response.body
				.toString()
				.split(/\r?\n\r?\n/)
				.filter((block) => block.includes("data:"))
				.map((block) => ({
					event: block.match(/^event:\s*(.*)$/m)?.[1],
					data: JSON.parse(block.match(/^data:\s*(.*)$/m)[1]),
				}));
			run.record({ name, transport, frames });
			body = frames.find((frame) => frame.event === "error")?.data;
			run.equal(frames.filter((frame) => frame.event === "exit").map((frame) => frame.data.exitCode), [-1], "Exactly one input-failure SSE terminal exit");
			run.equal(frames.findIndex((frame) => frame.event === "error") < frames.findIndex((frame) => frame.event === "exit"), true, "SSE input error precedes terminal exit");
			run.equal(
				frames.findLast((frame) => frame.event === "exit")?.data.error,
				"error",
				"SSE input limit has an error terminal event",
			);
		} else {
			const response = await run.request(
				server,
				owner,
				"POST",
				`${sandbox.path}/${transport === "batch" ? "exec-sync-batch" : "exec-sync"}`,
				{
					json:
						transport === "batch"
							? {
									scripts: [
										{ id: "rejected", script },
										{ id: "later", script: "echo must-not-run > /home/user/batch-later.txt" },
									],
									timeoutMs: 120000,
								}
							: { script, timeoutMs: 120000 },
					status: 413,
				},
			);
			body = response.body;
			status = response.status;
		}
		results.push({
			name,
			transport,
			limitBytes,
			attemptedBytes,
			status,
			code: body?.code,
			retryable: body?.retryable,
		});
		run.equal(body?.code, "EEXEC_INPUT_LIMIT", `${name} surfaces the canonical aggregate input limit`);
		run.equal(body?.retryable, false, `${name} input failure does not invite replay`);
		await run.request(peer, owner, "GET", `${sandbox.path}/files${prefix}`, { status: 404 });
		run.equal(
			(await run.request(peer, owner, "GET", `${sandbox.path}/files/home/user/counter`)).body.toString(),
			files["/home/user/counter"],
			`${name} warm peer retains the existing file after rollback`,
		);
		if (transport === "batch" || transport === "mcp-batch") {
			await run.request(peer, owner, "GET", `${sandbox.path}/files/home/user/${name}-later.txt`, { status: 404 });
		}
		await healthy();
		const dialect = new PostgresDialect(process.env.DATABASE_URL, undefined, 1);
		await dialect.connect();
		try {
			const fresh = new SqlFs({ dialect, sandboxId: sandbox.id });
			await fresh.ready();
			run.equal(await fresh.exists(prefix), false, `${name} buffered prefix is absent from fresh Postgres`);
			if (transport === "batch" || transport === "mcp-batch") {
				run.equal(
					await fresh.exists(`/home/user/${name}-later.txt`),
					false,
					"Batch stops before its next script after the input failure",
				);
			}
			for (const [path, content] of Object.entries(files)) {
				run.equal(sha256(await fresh.readFileBuffer(path)), sha256(content), `${name} preserves durable ${path} bytes`);
			}
		} finally {
			await dialect.disconnect();
		}
	}
	overlap = await overlappingReads(server, owner, sandbox, PostgresDialect, SqlFs);
	await healthy();
	const isolated = await run.request(server, owner, "POST", `${sandbox.path}/exec-sync-batch`, {
		json: {
			readOnly: true,
			scripts: [
				{ id: "a", script: "cat /home/user/a" },
				{ id: "b", script: "cat /home/user/b" },
			],
		},
	});
	run.equal(
		isolated.body.results.map(({ exitCode, stdout }) => [exitCode, stdout]),
		[
			[0, files["/home/user/a"]],
			[0, files["/home/user/b"]],
		],
		"Concurrent readonly batch scripts each have their own input budget",
	);
	const direct = await run.request(server, owner, "GET", `${sandbox.path}/files/home/user/above`);
	run.equal(
		direct.body.toString(),
		files["/home/user/above"],
		"Direct file API remains readable above the interpreter input budget",
	);
	run.equal(
		server.log.includes('"event":"defense_in_depth_violation"'),
		false,
		"Input-limit proof has no strict-defense violation",
	);
} catch (error) {
	failure = error;
} finally {
	await run.finish(
		failure,
		{
			limitBytes,
			results,
			overlap,
			policy:
				"cumulative bytes for every whole-file read, including repeats and warm cache; direct file API is outside exec",
		},
		async () => {
			if (!sandboxIds.length) return;
			const database = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
			try {
				const rows = await database`SELECT id FROM sandboxes WHERE id IN ${database(sandboxIds)}`;
				run.equal(rows.length, 0, "Exact input-budget sandbox rows are absent after API owners stop");
			} finally {
				await database.end({ timeout: 5 });
			}
		},
	);
}
