#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { LocalApiRun, delay, repo, sha256 } from "./local-api.mjs";
import { isJsonMediaType } from "./openapi-contract.mjs";

const run = new LocalApiRun("sdk-clients");
const ingestMiB = Number(process.env.SDK_VERIFY_INGEST_MIB ?? "16");
assert.ok(Number.isSafeInteger(ingestMiB) && ingestMiB > 8 && ingestMiB <= 50, "SDK ingest size must be above 8 and at most 50 MiB");
const observations = [];
let openapiContract;
const coverage = [];
let failure;
const schemaValidation = {
	typescript: { exchanges: 0, requestSchemas: 0, responseSchemas: 0 },
	python: { exchanges: 0, requestSchemas: 0, responseSchemas: 0 },
};

function observedFetch(sdk) {
	return async (url, init) => {
		const response = await fetch(url, init);
		const requestHeaders = new Headers(init?.headers);
		const requestContentType = requestHeaders.get("content-type");
		const requestBodyPresent = init?.body !== undefined && init.body !== null;
		const requestBody = response.status < 400 && isJsonMediaType(requestContentType) && typeof init?.body === "string"
			? JSON.parse(init.body)
			: init?.body;
		const responseContentType = response.headers.get("content-type");
		const responseSchema = openapiContract?.responseSchema(init?.method ?? "GET", new URL(url).pathname, response.status, responseContentType);
		const normalizedResponseType = responseContentType?.split(";", 1)[0]?.trim().toLowerCase();
		const responseBody = isJsonMediaType(responseContentType) && responseSchema?.format !== "binary"
			? await response.clone().json()
			: normalizedResponseType?.startsWith("text/") &&
				  normalizedResponseType !== "text/event-stream" &&
				  responseSchema?.format !== "binary"
				? Buffer.from(await response.clone().arrayBuffer())
				: undefined;
		const validation = openapiContract?.validateExchange({
			method: init?.method ?? "GET",
			path: new URL(url).pathname,
			status: response.status,
			requestContentType,
			requestBody,
			requestBodyPresent,
			validateRequestSchema: response.status < 400,
			responseContentType,
			responseBody,
			responseBodyPresent: response.body !== null,
		});
		if (validation) {
			const counts = schemaValidation[sdk];
			counts.exchanges += Number(validation.exchangeValidated);
			counts.requestSchemas += Number(validation.requestSchemaValidated);
			counts.responseSchemas += Number(validation.responseSchemaValidated);
		}
		const entry = {
			sdk,
			method: init?.method ?? "GET",
			path: new URL(url).pathname,
			status: response.status,
			atMs: performance.now(),
			retryAfter: response.headers.get("Retry-After"),
		};
		if (response.status >= 400) {
			const body = await response.clone().json();
			entry.code = body.code;
			entry.retryable = body.retryable;
		}
		observations.push(entry);
		run.record({ phase: "sdk-http-response", ...entry });
		return response;
	};
}

async function python(server, owner, mode, extra = {}) {
	const captureDir = mkdtempSync(join(tmpdir(), "sql-fs-sdk-capture-"));
	try {
		return await runPythonWithCapture(server, owner, mode, extra, captureDir);
	} finally {
		rmSync(captureDir, { recursive: true, force: true });
	}
}

async function runPythonWithCapture(server, owner, mode, extra, captureDir) {
	const child = spawn(process.env.VERIFY_PYTHON ?? "python3", [join(repo, "scripts/verify/sdk-python.py"), mode], {
		cwd: repo,
		env: {
			...process.env,
			PYTHONPATH: join(repo, "clients/python/src"),
			SDK_VERIFY_BASE_URL: server.base,
			SDK_VERIFY_SUB: owner.sub,
			SDK_VERIFY_TOKEN: owner.token,
			SDK_VERIFY_MARKER: run.runId,
			SDK_VERIFY_CAPTURE_DIR: captureDir,
			...extra,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const status = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	run.record({ phase: "python-sdk", mode, status, stderr });
	assert.equal(status, 0, run.redact(stderr));
	const proof = JSON.parse(stdout);
	for (const request of proof.requests) {
		const requestBody = request.requestBodyFile
			? request.requestBodyFile.endsWith(".json")
				? request.status < 400
					? JSON.parse(readFileSync(request.requestBodyFile, "utf8"))
					: undefined
				: readFileSync(request.requestBodyFile)
			: undefined;
		const responseBodyBytes = request.responseBodyFile ? readFileSync(request.responseBodyFile) : Buffer.alloc(0);
		const responseSchema = openapiContract?.responseSchema(
			request.method, request.path, request.status, request.responseContentType,
		);
		let responseBody;
		if (responseBodyBytes.length && isJsonMediaType(request.responseContentType) && responseSchema?.format !== "binary") {
			responseBody = JSON.parse(responseBodyBytes.toString("utf8"));
		} else if (responseBodyBytes.length && request.responseContentType?.toLowerCase().startsWith("text/") && request.responseContentType !== "text/event-stream") {
			responseBody = responseBodyBytes;
		}
		const validation = openapiContract?.validateExchange({
			...request,
			requestBody,
			requestBodyPresent: request.requestBodyPresent,
			validateRequestSchema: request.status < 400,
			responseBody,
			responseBodyPresent: request.responseBodyPresent,
		});
		if (validation) {
			const counts = schemaValidation.python;
			counts.exchanges += Number(validation.exchangeValidated);
			counts.requestSchemas += Number(validation.requestSchemaValidated);
			counts.responseSchemas += Number(validation.responseSchemaValidated);
		}
		delete request.requestBodyFile;
		delete request.responseBodyFile;
		delete request.responseBodyPresent;
		delete request.responseContentType;
		delete request.requestContentType;
		run.record({ phase: "sdk-http-response", sdk: "python", ...request });
	}
	run.checks.push(...proof.checks);
	observations.push(...proof.requests.map((request) => ({ sdk: "python", ...request })));
	if (proof.sandboxId) owner.sandboxes.add(proof.sandboxId);
	return proof;
}

async function waitForHold(server, sandboxId, offset) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (
			server.log
				.slice(offset)
				.split("\n")
				.some((line) => line.includes('"sdk_verify_hold_dispatched"') && line.includes(sandboxId))
		)
			return;
		await delay(10);
	}
	throw new Error("SDK saturation fixture was not dispatched");
}

async function durableBytes(sandboxId, path) {
	const { PostgresDialect } = await import(join(repo, "dist/sql-fs/dialects/postgres.js"));
	const { SqlFs } = await import(join(repo, "dist/sql-fs/sql-fs.js"));
	const dialect = new PostgresDialect(process.env.DATABASE_URL);
	await dialect.connect();
	try {
		const fresh = new SqlFs({ dialect, sandboxId });
		await fresh.ready();
		return Buffer.from(await fresh.readFileBuffer(path));
	} finally {
		await dialect.disconnect();
	}
}

try {
	assert.ok(!process.env.TENANT_DATABASES, "SDK crash durability proof requires a local single-tenant database");
	const compiler = join(repo, "clients/typescript/node_modules/typescript/bin/tsc");
	assert.ok(existsSync(compiler), "Install TypeScript SDK dependencies with its frozen lockfile before verification");
	execFileSync(process.execPath, [compiler, "-p", join(repo, "clients/typescript/tsconfig.json")], { cwd: repo });
	const { Client, NotFoundError, ServerError, ValidationError } = await import(join(repo, "clients/typescript/dist/index.js"));
	const server = await run.start({
		SQL_FS_WORKERS_ENABLED: "true",
		SQL_FS_WORKER_COUNT: "1",
		SQL_FS_WORKER_QUEUE_WAIT_MS: "100",
		JUST_BASH_DEFENSE_IN_DEPTH: "true",
		JUST_BASH_DEFENSE_AUDIT_MODE: "false",
		SDK_VERIFY_MARKER: run.runId,
		NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=./scripts/verify/sdk-faults.mjs`.trim(),
	});
	const spec = (await run.request(server, null, "GET", "/openapi.json")).body;
	openapiContract = new (await import("./openapi-contract.mjs")).OpenApiContract(spec);
	const owner = await run.owner(undefined, `${run.runId}-typescript`);
	const client = new Client({
		baseUrl: server.base,
		authSecret: process.env.AUTH_SECRET,
		sub: owner.sub,
		maxRetries: 1,
		fetch: observedFetch("typescript"),
	});
	run.clients.push(client);
	const sandbox = await client.sandboxes.create({
		name: "typescript-sdk-verification",
		files: { "/home/user/seed.txt": "seed\n" },
	});
	owner.sandboxes.add(sandbox.id);
	run.equal((await client.sandboxes.get(sandbox.id)).id, sandbox.id, "TypeScript sandbox metadata");
	run.equal(
		(await client.sandboxes.list()).some((item) => item.id === sandbox.id),
		true,
		"TypeScript sandbox listed",
	);
	run.equal(await sandbox.fs.readText("/home/user/seed.txt"), "seed\n", "TypeScript seeded bytes");
	await sandbox.fs.mkdir("/home/user/sdk", { recursive: true });
	const binary = Uint8Array.from([0, 1, 10, 127, 128, 255]);
	await sandbox.fs.write("/home/user/sdk/binary.bin", binary);
	const bytes = await sandbox.fs.read("/home/user/sdk/binary.bin");
	run.equal([...bytes.content], [...binary], "TypeScript binary round trip");
	run.equal([bytes.stat.kind, bytes.stat.size], ["file", 6], "TypeScript binary stat");
	const arbitraryBytes = Uint8Array.from([0, 255, 10, 128, 1]);
	for (const extension of ["json", "txt"]) {
		const path = `/home/user/sdk/arbitrary.${extension}`;
		await sandbox.fs.write(path, arbitraryBytes);
		run.equal(
			[...(await sandbox.fs.read(path)).content],
			[...arbitraryBytes],
			`TypeScript arbitrary bytes with ${extension} filename`,
		);
	}
	await sandbox.fs.writeFiles({ "/home/user/sdk/a.txt": "A", "/home/user/sdk/b.txt": "B" });
	await sandbox.ingestFiles({ "nested/ingested.txt": "ingested" }, { basePath: "/home/user/sdk" });
	run.equal(await sandbox.fs.readText("/home/user/sdk/nested/ingested.txt"), "ingested", "TypeScript ingest persisted");
	const largeInput = new Uint8Array(ingestMiB * 1024 * 1024).fill(90);
	await sandbox.ingestFiles({ "large.bin": largeInput }, { basePath: "/home/user/sdk" });
	const largePersisted = await durableBytes(sandbox.id, "/home/user/sdk/large.bin");
	run.equal(largePersisted.byteLength, largeInput.byteLength, `TypeScript default ingest accepts ${ingestMiB} MiB`);
	run.equal(sha256(largePersisted), sha256(largeInput), `TypeScript ${ingestMiB} MiB ingest fresh PostgreSQL SHA-256`);
	const limitedClient = new Client({ baseUrl: server.base, token: owner.token, maxFileSize: 8 * 1024 * 1024, fetch: observedFetch("typescript") });
	run.clients.push(limitedClient);
	for (const allowOversized of [false, true]) {
		const beforeLimit = observations.length;
		await assert.rejects(limitedClient.sandboxes.attach(sandbox.id).ingestFiles({ "large.bin": largeInput }, { allowOversized }), { code: "EFILE_TOO_LARGE" });
		run.equal(observations.length, beforeLimit, "TypeScript explicit file limit rejects before network");
	}
	const execution = await sandbox.exec(
		'printf "%s" "$SDK_VALUE" > /home/user/sdk/bash.txt; cat /home/user/sdk/bash.txt',
		{ env: { SDK_VALUE: "typescript-bash" } },
	);
	run.equal([execution.exitCode, execution.stdout], [0, "typescript-bash"], "TypeScript Bash result");
	run.equal(await sandbox.fs.readText("/home/user/sdk/bash.txt"), "typescript-bash", "TypeScript Bash persisted");
	const batch = await sandbox.execBatch(
		[
			{ id: "a", script: "cat /home/user/sdk/a.txt" },
			{ id: "b", script: "cat /home/user/sdk/b.txt" },
		],
		{ readOnly: true },
	);
	run.equal(
		batch.map((item) => [item.id, item.exitCode, item.stdout]),
		[
			["a", 0, "A"],
			["b", 0, "B"],
		],
		"TypeScript read-only batch",
	);
	await assert.rejects(
		sandbox.exec("echo denied > /home/user/sdk/denied.txt", { readOnly: true }),
		(error) => error instanceof ValidationError && error.code === "EREADONLY_VIOLATION",
	);
	run.checks.push("TypeScript read-only rejection");
	await assert.rejects(sandbox.fs.read("/home/user/sdk/denied.txt"), NotFoundError);
	run.checks.push("TypeScript rejected write remains absent");
	const events = [];
	for await (const event of sandbox.execStream("printf 'stream-out'; printf 'stream-err' >&2")) events.push(event);
	run.equal(
		events
			.filter((event) => event.type === "stdout")
			.map((event) => event.data)
			.join(""),
		"stream-out",
		"TypeScript SSE stdout",
	);
	run.equal(
		events
			.filter((event) => event.type === "stderr")
			.map((event) => event.data)
			.join(""),
		"stream-err",
		"TypeScript SSE stderr",
	);
	run.equal([events.at(-1).type, events.at(-1).exitCode], ["exit", 0], "TypeScript SSE terminal");
	run.equal(
		(await sandbox.fs.tree({ prefix: "/home/user/sdk", depth: 3 })).some((item) => item.path.endsWith("/binary.bin")),
		true,
		"TypeScript tree bytes",
	);
	await sandbox.fs.delete("/home/user/sdk", { recursive: true });
	coverage.push(
		"typescript-sandbox-lifecycle",
		"typescript-files-binary-stat-tree-ingest",
		"typescript-bash-batch-readonly-sse",
	);
	await sandbox.fs.write("/home/user/outcome.txt", "before\n");
	const before = observations.length;
	await assert.rejects(
		sandbox.exec(`printf 'once\\n' >> /home/user/outcome.txt; printf '${run.runId}:crash\\n'; sleep 5`, {
			retryOn5xx: true,
		}),
		{ code: "EEXEC_OUTCOME_UNKNOWN", status: 503 },
	);
	const attempts = observations.slice(before).filter((request) => request.path.endsWith("/exec-sync"));
	run.equal(attempts.length, 1, "TypeScript never replays unknown outcome");
	run.equal(attempts[0].retryable, false, "TypeScript unknown is not retryable");
	run.equal(
		(await durableBytes(sandbox.id, "/home/user/outcome.txt")).toString(),
		"before\n",
		"TypeScript killed buffered write never commits or replays",
	);
	await sandbox.delete();
	owner.sandboxes.delete(sandbox.id);
	const readonly = await client.sandboxes.create({ files: { "/home/user/outcome.txt": "before\n" } });
	owner.sandboxes.add(readonly.id);
	const readonlyStart = observations.length;
	await assert.rejects(readonly.exec(`printf '${run.runId}:crash\\n'; sleep 5`, { readOnly: true, retryOn5xx: true }), {
		code: "EEXEC_OUTCOME_UNKNOWN",
		status: 503,
	});
	const readonlyAttempts = observations.slice(readonlyStart).filter((request) => request.path.endsWith("/exec-sync"));
	run.equal(readonlyAttempts.length, 1, "TypeScript never replays unknown read-only script");
	run.equal(readonlyAttempts[0].retryable, false, "TypeScript unknown read-only script is not retryable");
	run.equal(
		(await durableBytes(readonly.id, "/home/user/outcome.txt")).toString(),
		"before\n",
		"TypeScript interrupted read-only bytes remain durable",
	);
	await readonly.delete();
	owner.sandboxes.delete(readonly.id);
	const streamUnknown = await client.sandboxes.create({ files: { "/home/user/outcome.txt": "before\n" } });
	owner.sandboxes.add(streamUnknown.id);
	const streamStart = observations.length;
	await assert.rejects(async () => {
		for await (const event of streamUnknown.execStream(`printf 'once\\n' >> /home/user/outcome.txt; printf '${run.runId}:crash\\n'; sleep 5`)) run.record({ phase: "typescript-stream-unknown", event });
	}, (error) => error instanceof ServerError && error.code === "EEXEC_OUTCOME_UNKNOWN" && error.status === 503 && error.retryable === false);
	run.equal(observations.slice(streamStart).filter((request) => request.path.endsWith("/exec")).length, 1, "TypeScript never replays an unknown stream");
	run.equal((await durableBytes(streamUnknown.id, "/home/user/outcome.txt")).toString(), "before\n", "TypeScript unknown stream preserves durable bytes");
	await streamUnknown.delete();
	owner.sandboxes.delete(streamUnknown.id);
	run.equal(await client.sandboxes.list(), [], "TypeScript SDK lifecycle cleanup");
	coverage.push("typescript-real-worker-death-no-replay-fresh-postgres", "typescript-readonly-script-death-no-replay");
	run.equal(schemaValidation.typescript.requestSchemas > 0, true, "TypeScript SDK request schemas validated");
	run.equal(schemaValidation.typescript.responseSchemas > 0, true, "TypeScript SDK response schemas validated");
	const pythonOwner = await run.owner(undefined, `${run.runId}-python`);
	await python(server, pythonOwner, "normal");
	const pythonLarge = await python(server, pythonOwner, "large-ingest");
	const pythonPersisted = await durableBytes(pythonLarge.sandboxId, "/home/user/sdk/large.bin");
	run.equal(pythonPersisted.byteLength, pythonLarge.bytes, `Python default ingest accepts ${ingestMiB} MiB`);
	run.equal(sha256(pythonPersisted), pythonLarge.sha256, `Python ${ingestMiB} MiB ingest fresh PostgreSQL SHA-256`);
	coverage.push("python-sandbox-lifecycle", "python-files-binary-stat-tree-ingest", "python-bash-batch-readonly-sse");
	const unknown = await python(server, pythonOwner, "unknown");
	run.equal(
		(await durableBytes(unknown.sandboxId, "/home/user/outcome.txt")).toString(),
		"before\n",
		"Python killed buffered write never commits or replays",
	);
	coverage.push("python-real-worker-death-no-replay-fresh-postgres");
	const readonlyUnknown = await python(server, pythonOwner, "readonly-unknown");
	run.equal(
		(await durableBytes(readonlyUnknown.sandboxId, "/home/user/outcome.txt")).toString(),
		"before\n",
		"Python interrupted read-only bytes remain durable",
	);
	coverage.push("python-readonly-script-death-no-replay");
	const pythonStream = await python(server, pythonOwner, "stream-unknown");
	run.equal((await durableBytes(pythonStream.sandboxId, "/home/user/outcome.txt")).toString(), "before\n", "Python unknown stream preserves durable bytes");
	coverage.push(`typescript-python-default-${ingestMiB}mib-ingest-fresh-postgres`, "typescript-python-typed-unknown-stream-no-replay");
	const blocker = await client.sandboxes.create();
	const contender = await client.sandboxes.create();
	owner.sandboxes.add(blocker.id);
	owner.sandboxes.add(contender.id);
	let holdOffset = server.log.length;
	let hold = blocker.exec(`printf '${run.runId}:hold\\n'; sleep 0.6`);
	await waitForHold(server, blocker.id, holdOffset);
	const busyStart = observations.length;
	run.equal(
		(await contender.exec("printf 'busy-retry-ok'", { retryOn5xx: true })).stdout,
		"busy-retry-ok",
		"TypeScript busy retry result",
	);
	await hold;
	const busyAttempts = observations
		.slice(busyStart)
		.filter((request) => request.path.includes(contender.id) && request.path.endsWith("/exec-sync"));
	run.equal(busyAttempts.length, 2, "TypeScript busy uses exactly one retry");
	run.equal(
		[busyAttempts[0].status, busyAttempts[0].code, busyAttempts[0].retryable],
		[503, "EWORKER_BUSY", true],
		"TypeScript busy predispatch contract",
	);
	const waitSeconds = Number(busyAttempts[0].retryAfter);
	run.equal(Number.isInteger(waitSeconds) && waitSeconds >= 1, true, "TypeScript busy retry guidance");
	run.equal(busyAttempts[1].atMs - busyAttempts[0].atMs >= waitSeconds * 1000, true, "TypeScript honors Retry-After");
	coverage.push("typescript-real-worker-busy-retry-guidance");
	const pythonContender = await run.create(server, pythonOwner);
	holdOffset = server.log.length;
	hold = blocker.exec(`printf '${run.runId}:hold\\n'; sleep 0.6`);
	await waitForHold(server, blocker.id, holdOffset);
	await python(server, pythonOwner, "busy", { SDK_VERIFY_SANDBOX_ID: pythonContender.id });
	await hold;
	coverage.push("python-real-worker-busy-retry-guidance");
	run.equal(
		server.log.split("\n").filter((line) => line.includes('"sdk_verify_worker_terminated"')).length,
		6,
		"Verifier terminates exactly six actual workers",
	);
	run.equal(server.log.includes('"defense_in_depth_violation"'), false, "SDK API produces no defense violations");
	run.equal(schemaValidation.python.requestSchemas > 0, true, "Python SDK request schemas validated");
	run.equal(schemaValidation.python.responseSchemas > 0, true, "Python SDK response schemas validated");
} catch (error) {
	failure = error;
} finally {
	await run.finish(failure, {
		coverage,
		observations,
		schemaValidation,
		contractCoverageLimitations: ["Path/query/header parameters are not schema-validated by this verifier", "SSE event payloads retain existing behavior assertions and are not OpenAPI-schema-validated"],
		faultInjection: "Verifier-only preload terminates actual worker after dispatch; no public fault route",
		unknownDurability: "Fresh Postgres filesystem confirms killed buffered write was not committed",
		compiledTypeScriptEntrySha256: existsSync(join(repo, "clients/typescript/dist/index.js"))
			? sha256(readFileSync(join(repo, "clients/typescript/dist/index.js")))
			: null,
		compiledTypeScriptHttpSha256: existsSync(join(repo, "clients/typescript/dist/http.js"))
			? sha256(readFileSync(join(repo, "clients/typescript/dist/http.js")))
			: null,
		compiledTypeScriptSandboxSha256: existsSync(join(repo, "clients/typescript/dist/sandbox.js"))
			? sha256(readFileSync(join(repo, "clients/typescript/dist/sandbox.js")))
			: null,
		pythonTransportSha256: sha256(readFileSync(join(repo, "clients/python/src/sqlfs/_http.py"))),
		pythonSandboxSha256: sha256(readFileSync(join(repo, "clients/python/src/sqlfs/sandbox.py"))),
	});
}
