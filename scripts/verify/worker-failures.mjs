#!/usr/bin/env node
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import postgres from "postgres";
import { LocalApiRun, repo, sha256 } from "./local-api.mjs";

const run = new LocalApiRun("worker-failures");
const coverage = [];
const experiments = [];
const sandboxIds = [];
const fixtureBytes = 7 * 1024 * 1024;
let failure;

function events(bytes) {
	return bytes
		.toString()
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
}

try {
	const server = await run.start({
		SQL_FS_WORKERS_ENABLED: "true",
		SQL_FS_WORKER_COUNT: "2",
		SQL_FS_WORKER_CANCEL_GRACE_MS: "50",
		JUST_BASH_DEFENSE_IN_DEPTH: "true",
		JUST_BASH_DEFENSE_AUDIT_MODE: "false",
	});
	const peer = await run.start({ SQL_FS_WORKERS_ENABLED: "false" });
	const owner = await run.owner();
	const client = new Client({ name: "sql-fs-worker-failure-verifier", version: "1.0.0" });
	run.clients.push(client);
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), {
			requestInit: { headers: { Authorization: `Bearer ${owner.token}` } },
		}),
	);
	const { PostgresDialect } = await import(join(repo, "dist/sql-fs/dialects/postgres.js"));
	const { SqlFs } = await import(join(repo, "dist/sql-fs/sql-fs.js"));
	for (const transport of ["sync", "sse", "mcp"]) {
		for (const readOnly of [false, true]) {
			const sandbox = await run.create(server, owner, {
				javascript: true,
				files: { "/home/user/counter.txt": "initial\n" },
			});
			sandboxIds.push(sandbox.id);
			await run.request(server, owner, "PUT", `${sandbox.path}/files/home/user/cpu.txt`, {
				raw: "abcdefghijklm abcdefghijklm 123\n".repeat(fixtureBytes / 32),
				status: 204,
			});
			const baseline = await run.request(peer, owner, "GET", `${sandbox.path}/files/home/user/counter.txt`);
			run.equal(baseline.body.toString(), "initial\n", `${transport} warm rolling-deploy peer reads initial bytes`);
			const warm = await run.request(server, owner, "POST", `${sandbox.path}/exec-sync`, {
				json: { script: 'node -e "console.log(42)"', readOnly: true },
			});
			run.equal(
				[warm.body.exitCode, warm.body.stdout],
				[0, "42\n"],
				`${transport} runtime is warm before forced termination`,
			);
			const script = 'sed "s/a/z/g" /home/user/cpu.txt';
			const started = performance.now();
			let body;
			if (transport === "sync") {
				const response = await run.request(server, owner, "POST", `${sandbox.path}/exec-sync`, {
					json: { script, timeoutMs: 100, readOnly },
					status: 503,
				});
				body = response.body;
			} else if (transport === "sse") {
				const response = await run.request(server, owner, "POST", `${sandbox.path}/exec`, {
					json: { script, timeoutMs: 100, readOnly },
				});
				const frames = events(response.body);
				run.record({ transport, readOnly, frames });
				body = frames.find((frame) => frame.event === "error")?.data;
				run.equal(frames.filter((frame) => frame.event === "exit").map((frame) => frame.data.exitCode), [-1], "Exactly one failed SSE terminal exit");
				run.equal(frames.findIndex((frame) => frame.event === "error") < frames.findIndex((frame) => frame.event === "exit"), true, "SSE error precedes terminal exit");
				run.equal(
					frames.findLast((frame) => frame.event === "exit")?.data.error,
					"error",
					"SSE unknown has an error terminal event",
				);
			} else {
				const response = await client.callTool({
					name: "bash_exec",
					arguments: { id: sandbox.id, script, timeout: 100, readOnly },
				});
				run.record({ transport, readOnly, response });
				run.equal(response.isError, true, "MCP unknown is an error result");
				body = JSON.parse(response.content[0].text);
				run.equal(response.structuredContent, body, "MCP text and structured failure agree");
			}
			experiments.push({
				transport,
				readOnly,
				durationMs: performance.now() - started,
				code: body?.code,
				retryable: body?.retryable,
			});
			run.equal(
				body?.code,
				"EEXEC_OUTCOME_UNKNOWN",
				`${transport} dispatched exec death is unknown (readOnly=${readOnly})`,
			);
			run.equal(body?.retryable, false, `${transport} unknown must not invite automatic replay`);
			const recovery = await run.request(server, owner, "POST", `${sandbox.path}/exec-sync`, {
				json: { script: "cat /home/user/counter.txt", readOnly: true },
			});
			run.equal(
				[recovery.body.exitCode, recovery.body.stdout],
				[0, "initial\n"],
				`${transport} worker safely recovers`,
			);
			run.equal(
				(await run.request(peer, owner, "GET", `${sandbox.path}/files/home/user/counter.txt`)).body.toString(),
				"initial\n",
				`${transport} warm peer remains correct`,
			);
			const dialect = new PostgresDialect(process.env.DATABASE_URL);
			await dialect.connect();
			try {
				const fresh = new SqlFs({ dialect, sandboxId: sandbox.id });
				await fresh.ready();
				run.equal(
					sha256(await fresh.readFileBuffer("/home/user/counter.txt")),
					sha256("initial\n"),
					`${transport} fresh Postgres reader verifies durable state`,
				);
			} finally {
				await dialect.disconnect();
			}
			coverage.push(`${transport}-forced-death-readonly-${readOnly}`);
		}
	}
	const cooperative = await run.create(server, owner);
	sandboxIds.push(cooperative.id);
	const ordinaryTimeout = await run.request(server, owner, "POST", `${cooperative.path}/exec-sync`, {
		json: {
			script: "echo prefix > /home/user/prefix.txt; sleep 1; echo suffix > /home/user/suffix.txt",
			timeoutMs: 100,
		},
		status: 408,
	});
	run.equal(ordinaryTimeout.body.error, "timeout", "Cooperative timeout remains distinct from unknown");
	run.equal(
		(await run.request(peer, owner, "GET", `${cooperative.path}/files/home/user/prefix.txt`)).body.toString(),
		"prefix\n",
		"Cooperative timeout retains the completed prefix",
	);
	await run.request(peer, owner, "GET", `${cooperative.path}/files/home/user/suffix.txt`, { status: 404 });
	coverage.push("cooperative-timeout-prefix");
	run.equal(
		server.log.includes('"event":"defense_in_depth_violation"'),
		false,
		"Forced termination proof has no strict-defense violation",
	);
} catch (error) {
	failure = error;
} finally {
	await run.finish(
		failure,
		{
			coverage,
			experiments,
			fixtureBytes,
			scope: "real compiled API, strict defense, CPU grace kill, rolling peer, fresh Postgres",
		},
		async () => {
			if (!sandboxIds.length) return;
			const database = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
			try {
				const remaining = await database`SELECT id FROM sandboxes WHERE id IN ${database(sandboxIds)}`;
				run.equal(remaining.length, 0, "Exact owned sandbox rows are absent after every API owner stops");
			} finally {
				await database.end({ timeout: 5 });
			}
		},
	);
}
