import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { LocalApiRun, delay, repo, sha256 } from "./local-api.mjs";

assert.ok(!process.argv.includes("--expect-before"), "Redis INCR before controls are historical; use the original source and receipts for that boundary");
const run = new LocalApiRun("sse-durable-finalization");
const observations = [];
let failure;
let redis;
let gates;
const gatedIds = [];

function parseEvents(text) {
	return text
		.split(/\r?\n\r?\n/)
		.filter((frame) => frame.includes("data: "))
		.map((frame) => JSON.parse(frame.split(/\r?\n/).find((line) => line.startsWith("data: ")).slice(6)));
}

async function checkpoint(server, event, id) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (server.log.split("\n").some((line) => line.includes(`"event":"${event}"`) && line.includes(id))) return;
		await delay(10);
	}
	throw new Error(`Missing ${event} checkpoint for ${id}`);
}

async function durable(id) {
	const { PostgresDialect } = await import(join(repo, "dist/sql-fs/dialects/postgres.js"));
	const { SqlFs } = await import(join(repo, "dist/sql-fs/sql-fs.js"));
	const dialect = new PostgresDialect(process.env.DATABASE_URL);
	await dialect.connect();
	try {
		const fs = new SqlFs({ dialect, sandboxId: id });
		await fs.ready();
		return Buffer.from(await fs.readFileBuffer("/home/user/finalization.txt"));
	} finally {
		await dialect.disconnect();
	}
}

function python(server, owner, id, script) {
	const child = spawn(process.env.VERIFY_PYTHON ?? "python3", [join(repo, "scripts/verify/sse-finalization-python.py")], {
		cwd: repo,
		env: {
			...process.env,
			PYTHONPATH: join(repo, "clients/python/src"),
			SSE_FINALIZATION_BASE: server.base,
			SSE_FINALIZATION_TOKEN: owner.token,
			SSE_FINALIZATION_SANDBOX: id,
			SSE_FINALIZATION_SCRIPT: script,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	run.clients.push({ close: () => { if (child.exitCode === null) child.kill("SIGTERM"); } });
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code !== 0) reject(new Error(run.redact(stderr)));
			else resolve(JSON.parse(stdout));
		});
	});
}

try {
	assert.ok(!process.env.TENANT_DATABASES, "SSE finalization proof requires a local single-tenant database");
	assert.ok(process.env.REDIS_URL, "Real Redis leases are required");
	const { Redis } = await import("ioredis");
	redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 2000 });
	gates = join(run.evidence, "gates");
	mkdirSync(gates);
	const server = await run.start({
		SQL_FS_WORKERS_ENABLED: "true",
		SQL_FS_WORKER_COUNT: "2",
		REDIS_RWLOCK_ENABLED: "true",
		JUST_BASH_DEFENSE_IN_DEPTH: "true",
		JUST_BASH_DEFENSE_AUDIT_MODE: "false",
		SSE_FINALIZATION_MARKER: run.runId,
		SSE_FINALIZATION_GATES: process.env.VERIFY_CONTAINER_IMAGE ? join("/app", relative(repo, gates)) : gates,
		NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=./scripts/verify/sse-finalization-faults.mjs`.trim(),
	});
	const owner = await run.owner(undefined, `${run.runId}-owner`);
	const { Client } = await import(join(repo, "clients/typescript/dist/index.js"));
	for (const sdk of ["raw", "typescript", "python"]) {
		for (const mode of ["reject", "hold"]) {
			const { id, path } = await run.create(server, owner);
			gatedIds.push(id);
			const script = `echo applied >> /home/user/finalization.txt; echo streamed\n# ${run.runId}:${mode}`;
			let settled = false;
			const requests = [];
			let operation;
			if (sdk === "raw") {
				operation = run.request(server, owner, "POST", `${path}/exec`, { json: { script, timeoutMs: 5000 } })
					.then(({ body }) => ({ events: parseEvents(body.toString()) }));
			} else if (sdk === "typescript") {
				const client = new Client({
					baseUrl: server.base,
					token: owner.token,
					maxRetries: 3,
					fetch: (url, init) => {
						requests.push({ method: init.method, path: new URL(url).pathname });
						return fetch(url, init);
					},
				});
				run.clients.push(client);
				operation = (async () => {
					const events = [];
					try {
						for await (const event of client.sandboxes.attach(id).execStream(script, { timeoutMs: 5000 })) events.push(event);
						return { events, requests, outcome: { kind: "success" } };
					} catch (error) {
						return { events, requests, outcome: { kind: "error", code: error.code, retryable: error.retryable, status: error.status, class: error.name } };
					}
				})();
			} else {
				operation = python(server, owner, id, script);
			}
			const completed = operation.then(
				(result) => { settled = true; return { result }; },
				(error) => { settled = true; return { error }; },
			);
			await checkpoint(server, "sse_finalization_clear_dirty_held", id);
			await delay(75);
			run.equal(settled, false, `${sdk}/${mode}: no successful completion while finalization is held`);
			const beforeFault = await durable(id);
			run.equal(beforeFault.toString(), "applied\n", `${sdk}/${mode}: PostgreSQL append is durable exactly once before the fault`);
			if (mode === "hold") {
				const writer = `vfs:default:rwlock:{${id}}:writer`;
				run.equal(await redis.del(writer), 1, `${sdk}: revoke the real active Redis writer lease`);
				await checkpoint(server, "sse_finalization_lease_lost", id);
			}
			writeFileSync(join(gates, id), "release");
			const completion = await completed;
			if (completion.error) throw completion.error;
			const result = completion.result;
			await checkpoint(server, mode === "hold" ? "sse_finalization_clear_dirty_released" : "sse_finalization_owner_terminated", id);
			const expectedCode = "EEXEC_OUTCOME_UNKNOWN";
			const persisted = await durable(id);
			run.equal(persisted.toString(), "applied\n", `${sdk}/${mode}: fresh PostgreSQL observes one append`);
			if (sdk === "raw") {
				const exits = result.events.filter((event) => event.t === "exit");
				const errors = result.events.filter((event) => event.t === "error");
				run.equal(exits.length, 1, `raw/${mode}: terminal event count`);
				run.equal(exits[0].exitCode, -1, `raw/${mode}: first terminal reflects finalization`);
				run.equal(result.events.map((event) => event.t), ["stdout", "error", "exit"], `raw/${mode}: failure precedes the only terminal event`);
				run.equal(errors.map((event) => [event.code, event.retryable]), [[expectedCode, false]], `raw/${mode}: typed nonretryable finalization failure`);
				run.equal(result.events[0], { t: "stdout", data: "streamed\n" }, `raw/${mode}: output survives post-work failure`);
			} else {
				run.equal(result.outcome.kind, "error", `${sdk}/${mode}: SDK observes finalization outcome`);
				run.equal(result.requests.filter((request) => request.path.endsWith("/exec")).length, 1, `${sdk}/${mode}: script is never replayed`);
				run.equal(result.outcome.code, expectedCode, `${sdk}/${mode}: SDK preserves outcome code`);
				run.equal(result.outcome.retryable, false, `${sdk}/${mode}: SDK preserves nonretryable outcome`);
				run.equal(result.outcome.status, 503, `${sdk}/${mode}: SDK preserves unavailable outcome status`);
				run.equal(result.outcome.class, "ServerError", `${sdk}/${mode}: SDK preserves canonical error class`);
				run.equal(result.events.some((event) => (event.type ?? event.t) === "exit"), false, `${sdk}/${mode}: SDK never receives premature exit`);
				run.equal(result.events.filter((event) => (event.type ?? event.t) === "stdout").map((event) => event.data).join(""), "streamed\n", `${sdk}/${mode}: output survives post-work failure`);
			}
			const reused = await run.request(server, owner, "POST", `${path}/exec-sync`, {
				json: { script: "cat /home/user/finalization.txt; echo reused >> /home/user/finalization.txt", timeoutMs: 5000 },
			});
			run.equal([reused.body.exitCode, reused.body.stdout], [0, "applied\n"], `${sdk}/${mode}: the same sandbox is reusable after finalization failure`);
			const afterReuse = await durable(id);
			run.equal(afterReuse.toString(), "applied\nreused\n", `${sdk}/${mode}: fresh PostgreSQL confirms the later write without replay`);
			observations.push({ sdk, mode, id, ...result, beforeFaultBytes: beforeFault.length, beforeFaultSha256: sha256(beforeFault), durableBytes: persisted.length, durableSha256: sha256(persisted), afterReuseBytes: afterReuse.length, afterReuseSha256: sha256(afterReuse) });
		}
	}
	for (const [script, expected] of [["echo healthy", { exitCode: 0 }], ["sleep 2", { exitCode: -1, error: "timeout" }]]) {
		const { path } = await run.create(server, owner);
		const { body } = await run.request(server, owner, "POST", `${path}/exec`, { json: { script, timeoutMs: script === "sleep 2" ? 100 : 5000 } });
		const exits = parseEvents(body.toString()).filter((event) => event.t === "exit");
		run.equal(exits.length, 1, `${script}: exactly one terminal`);
		for (const [key, value] of Object.entries(expected)) run.equal(exits[0][key], value, `${script}: ${key}`);
	}
} catch (error) {
	failure = error;
} finally {
	if (gates) for (const id of gatedIds) writeFileSync(join(gates, id), "release");
	await redis?.quit();
	await run.finish(failure, {
		baselineNegativeControl: false,
		finalizationBoundary: "SessionManager.withSessionEntry awaits WorkerFileSystem.clearDirty after exec commit",
		observations,
		artifact: {
			execRouteSourceSha256: sha256(readFileSync(join(repo, "src/api/routes/exec.ts"))),
			compiledExecRouteSha256: sha256(readFileSync(join(repo, "dist/api/routes/exec.js"))),
			sessionManagerSourceSha256: sha256(readFileSync(join(repo, "src/api/session-manager.ts"))),
			compiledSessionManagerSha256: sha256(readFileSync(join(repo, "dist/api/session-manager.js"))),
			workerFileSystemSourceSha256: sha256(readFileSync(join(repo, "src/api/worker-owner/filesystem.ts"))),
			compiledWorkerFileSystemSha256: sha256(readFileSync(join(repo, "dist/api/worker-owner/filesystem.js"))),
			workerPoolSourceSha256: sha256(readFileSync(join(repo, "src/api/worker-owner/pool.ts"))),
			compiledWorkerPoolSha256: sha256(readFileSync(join(repo, "dist/api/worker-owner/pool.js"))),
			sqlFsSourceSha256: sha256(readFileSync(join(repo, "src/sql-fs/sql-fs.ts"))),
			compiledSqlFsSha256: sha256(readFileSync(join(repo, "dist/sql-fs/sql-fs.js"))),
			faultPreloadSha256: sha256(readFileSync(join(repo, "scripts/verify/sse-finalization-faults.mjs"))),
			verifierSourceSha256: sha256(readFileSync(join(repo, "scripts/verify/sse-finalization.mjs"))),
			pythonVerifierSourceSha256: sha256(readFileSync(join(repo, "scripts/verify/sse-finalization-python.py"))),
			typescriptSandboxSourceSha256: sha256(readFileSync(join(repo, "clients/typescript/src/sandbox.ts"))),
			compiledTypescriptSandboxSha256: sha256(readFileSync(join(repo, "clients/typescript/dist/sandbox.js"))),
			typescriptHttpSourceSha256: sha256(readFileSync(join(repo, "clients/typescript/src/http.ts"))),
			compiledTypescriptHttpSha256: sha256(readFileSync(join(repo, "clients/typescript/dist/http.js"))),
			pythonSandboxSourceSha256: sha256(readFileSync(join(repo, "clients/python/src/sqlfs/sandbox.py"))),
			pythonHttpSourceSha256: sha256(readFileSync(join(repo, "clients/python/src/sqlfs/_http.py"))),
		},
	});
}
