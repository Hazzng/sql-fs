#!/usr/bin/env node
import { once } from "node:events";
import { createServer, request } from "node:http";
import { performance } from "node:perf_hooks";
import { delay, LocalApiRun, sha256 } from "./local-api.mjs";

const run = new LocalApiRun("ingress-queue");
const trials = [];
const opened = new Set();
let failure;

function open(server, owner, method, path, bytes) {
	let finish;
	let status;
	const done = new Promise((resolve) => {
		finish = resolve;
	});
	const wire = request(
		new URL(path, server.base),
		{
			method,
			agent: false,
			headers: {
				authorization: `Bearer ${owner.token}`,
				"content-type": "application/octet-stream",
				"content-length": String(bytes),
			},
		},
		(response) => {
			status = response.statusCode;
			response.resume();
			response.once("end", () => finish());
			response.once("error", () => finish());
		},
	);
	wire.once("error", () => finish());
	wire.once("close", () => finish());
	wire.setTimeout(10000, () => wire.destroy());
	wire.flushHeaders();
	opened.add(wire);
	return {
		wire,
		done,
		get status() {
			return status;
		},
		async send(body, end = true) {
			await new Promise((resolve, reject) => {
				const callback = (error) => (error ? reject(error) : resolve());
				if (end) wire.end(body, callback);
				else wire.write(body, callback);
			});
		},
		async close() {
			wire.destroy();
			await done;
			opened.delete(wire);
		},
	};
}

async function metrics(server, owner) {
	const response = await run.request(server, owner, "GET", "/metrics");
	const values = Object.fromEntries(
		response.body
			.toString()
			.split("\n")
			.filter((line) => /^sql_fs_ingress_[a-z_]+ /.test(line))
			.map((line) => {
				const [name, value] = line.split(" ");
				return [name, Number(value)];
			}),
	);
	return {
		active: values.sql_fs_ingress_active_requests,
		queued: values.sql_fs_ingress_queued_requests,
		bytes: values.sql_fs_ingress_retained_raw_bytes,
		aborted: values.sql_fs_ingress_aborted_total,
		timeouts: values.sql_fs_ingress_queue_timeouts_total,
		refused: values.sql_fs_ingress_refused_total,
	};
}

async function until(server, owner, predicate, label) {
	const deadline = performance.now() + 3000;
	let sample;
	do {
		sample = await metrics(server, owner);
		if (predicate(sample)) return sample;
		await delay(20);
	} while (performance.now() < deadline);
	throw new Error(`${label}: ${JSON.stringify(sample)}`);
}

async function lateDelete(peer, owner) {
	const sandbox = await run.create(peer, owner);
	const freshPeer = await run.start({ SQL_FS_WORKERS_ENABLED: "false" });
	let entered;
	let barrierResponse;
	let timer;
	const arrived = new Promise((resolve) => {
		entered = resolve;
	});
	const barrier = createServer((incoming, outgoing) => {
		if (incoming.url !== `/${sandbox.id}`) {
			outgoing.writeHead(404).end();
			return;
		}
		barrierResponse = outgoing;
		entered();
	});
	barrier.listen(0, "127.0.0.1");
	await once(barrier, "listening");
	let holder;
	let target;
	try {
		const server = await run.start({
			SQL_FS_WORKERS_ENABLED: "true",
			SQL_FS_MAX_INGRESS_REQUESTS: "3",
			SQL_FS_MAX_INGRESS_TENANT_REQUESTS: "2",
			SQL_FS_MAX_INGRESS_BYTES: "10",
			SQL_FS_MAX_INGRESS_TENANT_BYTES: "9",
			SQL_FS_MAX_INGRESS_WAIT_MS: "5000",
			INGRESS_VERIFY_DELETE_ID: sandbox.id,
			INGRESS_VERIFY_BARRIER: `http://127.0.0.1:${barrier.address().port}`,
			NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=./scripts/verify/ingress-faults.mjs`.trim(),
		});
		holder = open(server, owner, "POST", "/v1/sandboxes", 9);
		await holder.send(Buffer.from("        "), false);
		await until(server, owner, (sample) => sample.active === 1 && sample.bytes === 8, "The holder retains eight bytes");
		target = open(server, owner, "DELETE", sandbox.path, 3);
		await Promise.race([
			arrived,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("Durable DELETE did not reach the reply barrier")), 5000);
			}),
		]);
		clearTimeout(timer);
		await run.request(freshPeer, owner, "GET", sandbox.path, { status: 404 });
		owner.sandboxes.delete(sandbox.id);
		await target.send(Buffer.from("abc"));
		await delay(100);
		const during = await metrics(server, owner);
		barrierResponse.writeHead(204).end();
		await target.done;
		run.record({ case: "late-input-after-durable-delete", during, status: target.status });
		run.equal(target.status, 204, "Late ignored DELETE input does not replace a committed result with retryable busy");
		run.equal(during.refused, 0, "Ignored active input does not create a post-dispatch ingress refusal");
		await holder.close();
		await until(
			server,
			owner,
			(sample) => sample.active === 0 && sample.queued === 0 && sample.bytes === 0,
			"DELETE and holder release their ingress charges",
		);
	} finally {
		clearTimeout(timer);
		barrierResponse?.end();
		await target?.close();
		await holder?.close();
		barrier.closeAllConnections();
		await new Promise((resolve, reject) => barrier.close((error) => (error ? reject(error) : resolve())));
	}
}

try {
	const server = await run.start({
		SQL_FS_WORKERS_ENABLED: "true",
		SQL_FS_MAX_INGRESS_REQUESTS: "1",
		SQL_FS_MAX_INGRESS_TENANT_REQUESTS: "1",
		SQL_FS_MAX_INGRESS_QUEUED_REQUESTS: "4",
		SQL_FS_MAX_INGRESS_TENANT_QUEUED_REQUESTS: "3",
		SQL_FS_MAX_INGRESS_BYTES: String(8 * 1024 * 1024),
		SQL_FS_MAX_INGRESS_TENANT_BYTES: String(6 * 1024 * 1024),
		SQL_FS_MAX_INGRESS_WAIT_MS: "5000",
	});
	const owner = await run.owner();
	const sandbox = await run.create(server, owner);
	const bytes = Buffer.alloc(1024 * 1024, 0x71);
	const positive = `${sandbox.path}/files/home/user/positive`;
	await run.request(server, owner, "PUT", positive, { raw: bytes, status: 204 });
	run.equal(
		sha256((await run.request(server, owner, "GET", positive)).body),
		sha256(bytes),
		"The live upload control stores all 1 MiB exactly",
	);
	for (let round = 0; round < 5; round++) {
		const trial = { round };
		trials.push(trial);
		const holder = open(server, owner, "POST", "/v1/sandboxes", 2 * 1024 * 1024);
		let target;
		try {
			await holder.send(Buffer.from(" "), false);
			await until(server, owner, (sample) => sample.active === 1 && sample.bytes === 1, "Incomplete body holds ingress");
			const path = `${sandbox.path}/files/home/user/abandoned-${round}`;
			target = open(server, owner, "PUT", path, bytes.length);
			[trial.before] = await Promise.all([
				until(
					server,
					owner,
					(sample) => sample.active === 1 && sample.queued === 1,
					"The fully offered upload waits for ingress",
				),
				target.send(bytes),
			]);
			run.equal(target.status, undefined, "The target has no response before abandonment");
			await target.close();
			await delay(500);
			trial.afterAbort = await metrics(server, owner);
			run.equal(holder.status, undefined, "The holder still prevents target admission after abandonment");
			await holder.close();
			trial.settled = await until(
				server,
				owner,
				(sample) => sample.active === 0 && sample.queued === 0 && sample.bytes === 0,
				"Cancelled upload and holder release every ingress charge",
			);
			const durable = await run.request(server, owner, "GET", path, { status: null });
			trial.readStatus = durable.status;
			run.record({ case: "abandoned-queued-upload", ...trial });
			run.equal(durable.status, 404, "An upload abandoned while queued never becomes a durable file");
			run.equal(trial.afterAbort.queued, 0, "Disconnect removes the upload before the active holder releases");
			run.equal(trial.afterAbort.aborted - trial.before.aborted, 1, "The queued disconnect is observed exactly once");
			run.equal(trial.afterAbort.timeouts, trial.before.timeouts, "Cancellation is observed without a queue timeout");
		} finally {
			await target?.close();
			await holder.close();
		}
	}
	await lateDelete(server, owner);
} catch (error) {
	failure = error;
} finally {
	for (const wire of opened) wire.destroy();
	await run.finish(failure, { trials });
}
