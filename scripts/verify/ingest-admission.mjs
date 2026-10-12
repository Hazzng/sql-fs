import assert from "node:assert/strict";
import { open, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { containerResources } from "./container-api.mjs";
import { LocalApiRun, delay, repo, sha256 } from "./local-api.mjs";

const run = new LocalApiRun("ingest-admission");
const control = process.env.MCP_INGEST_VERIFY_CONTROL === "1";
const messageBytes = Number(process.env.SQL_FS_WORKER_MESSAGE_BYTES ?? 64 * 1024 * 1024);
assert.ok(Number.isSafeInteger(messageBytes) && messageBytes > 0);
const oversizedBytes = messageBytes + 1024 * 1024;
const observations = [];
const samples = [];
let failure;
let sampler;
let server;
const fixturePrefix = join(run.evidence, "host-");
try {
	const large = await open(`${fixturePrefix}large`, "w");
	try {
		await large.truncate(oversizedBytes);
		await large.write(Buffer.from("large-host-fixture"), 0, 18, 0);
	} finally {
		await large.close();
	}
	const smallBytes = Buffer.alloc(4 * 1024 * 1024, 0x71);
	const small = await open(`${fixturePrefix}small`, "w");
	try {
		await small.writeFile(smallBytes);
	} finally {
		await small.close();
	}
	const mappedPrefix = process.env.VERIFY_CONTAINER_IMAGE ? join("/app", relative(repo, fixturePrefix)) : fixturePrefix;
	server = await run.start({
		SQL_FS_WORKERS_ENABLED: "true",
		SQL_FS_WORKER_COUNT: "2",
		SQL_FS_WORKER_ACTIVE_TENANT_MAX: "1",
		SQL_FS_WORKER_MESSAGE_BYTES: String(messageBytes),
		SQL_FS_WORKER_QUEUE_BYTES: String(1024 * 1024),
		SQL_FS_WORKER_QUEUE_WAIT_MS: "100",
		SQL_FS_MAX_INGRESS_REQUESTS: "20",
		SQL_FS_MAX_INGRESS_TENANT_REQUESTS: "10",
		JUST_BASH_DEFENSE_IN_DEPTH: "true",
		JUST_BASH_DEFENSE_AUDIT_MODE: "false",
		MCP_INGEST_VERIFY_PREFIX: mappedPrefix,
		NODE_OPTIONS: "--import=./scripts/verify/ingest-faults.mjs",
	});
	if (!server.container) {
		sampler = setInterval(async () => {
			try {
				const status = await readFile(`/proc/${server.child.pid}/status`, "utf8");
				samples.push({ rssBytes: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024, peakRssBytes: Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0) * 1024 });
			} catch {}
		}, 10);
	}
	const owner = await run.owner();
	const sandboxes = [];
	for (let index = 0; index < 3; index++) sandboxes.push(await run.create(server, owner));
	const target = sandboxes[2];
	const client = new Client({ name: "ingest-admission-verifier", version: "1" });
	run.clients.push(client);
	await client.connect(new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${owner.token}` } } }));
	const hostReads = () => server.log.split("\n").flatMap((line) => {
		try {
			const item = JSON.parse(line);
			return item.event === "ingest-host-read" ? [item] : [];
		} catch {
			return [];
		}
	});
	const ingest = async (name, file) => {
		const result = await client.callTool({ name: "fs_ingest", arguments: { id: target.id, paths: { [name]: `${mappedPrefix}${file}` } } });
		const body = JSON.parse(result.content[0].text);
		observations.push({ name, body });
		return body;
	};
	const oversized = await ingest("oversized", "large");
	run.equal(oversized.ok, false, "Oversized host ingest is refused");
	await delay(50);
	const largeReadBytes = hostReads().filter((item) => item.name === "large").reduce((bytes, item) => bytes + item.bytes, 0);
	run.equal(largeReadBytes, control ? oversizedBytes : 0, "Oversized host content read count");
	const blockers = sandboxes.slice(0, 1).map((sandbox) => run.request(server, owner, "POST", `${sandbox.path}/exec-sync`, { json: { script: "sleep 3; echo done", timeoutMs: 10000 }, timeoutMs: 20000 }));
	try {
		const deadline = Date.now() + 5000;
		while (true) {
			const response = await fetch(`${server.base}/metrics`, { headers: { Authorization: `Bearer ${owner.token}` } });
			assert.equal(response.status, 200, "Worker metrics response");
			const metrics = await response.text();
			if (/^sql_fs_worker_busy 1$/m.test(metrics) && /^sql_fs_worker_running_operations 1$/m.test(metrics)) break;
			assert.ok(Date.now() < deadline, "Tenant reached its active execution quota");
			await delay(10);
		}
		const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => ingest(`busy-${index}`, "small")));
		for (const body of responses) {
			run.equal(body.code, "EWORKER_BUSY", "Busy ingest preserves worker admission code");
			run.equal(body.retryable, true, "Busy ingest has no effects and permits retry");
		}
		await delay(50);
		const smallReadBytes = hostReads().filter((item) => item.name === "small").reduce((bytes, item) => bytes + item.bytes, 0);
		run.equal(smallReadBytes, control ? 8 * smallBytes.length : 0, "Busy calls read no host content before admission");
	} finally {
		await Promise.allSettled(blockers);
	}
	const healthy = await ingest("healthy", "small");
	run.equal(healthy, { ok: true, count: 1 }, "Allowed host ingest remains usable after refusal");
	const persisted = await run.request(server, owner, "GET", `${target.path}/files/home/user/healthy`);
	run.equal([persisted.body.length, sha256(persisted.body)], [smallBytes.length, sha256(smallBytes)], "Allowed host ingest byte count and SHA-256");
	for (const name of ["oversized", ...Array.from({ length: 8 }, (_, index) => `busy-${index}`)]) await run.request(server, owner, "GET", `${target.path}/files/home/user/${name}`, { status: 404 });
	if (server.container) observations.push({ container: await containerResources(server.container) });
	observations.push({ hostReads: hostReads() });
} catch (error) {
	failure = error;
} finally {
	clearInterval(sampler);
}
await run.finish(failure, { control, messageBytes, oversizedBytes, observations, samples, peakRssBytes: Math.max(0, ...samples.map((item) => item.peakRssBytes)) }, async () => {
	await Promise.all([rm(`${fixturePrefix}large`, { force: true }), rm(`${fixturePrefix}small`, { force: true })]);
});
