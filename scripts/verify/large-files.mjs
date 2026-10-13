#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import postgres from "postgres";
import { LocalApiRun, delay, repo, sha256 } from "./local-api.mjs";
import { distribution, scheduledProbes, validateIngressSamples, validateWorkerSamples } from "./measurements.mjs";
import { containerResources, sampleContainer } from "./container-api.mjs";

const [command = "tr", mibText = "16", trialsText = "5"] = process.argv.slice(2);
assert.ok(["sed", "tr"].includes(command), "Usage: large-files.mjs <sed|tr> <MiB> <trials>");
const mib = Number(mibText);
const trials = Number(trialsText);
assert.ok(
	Number.isInteger(mib) && mib > 8 && mib <= 64,
	"File size must be an integer above the old cap and at most 64 MiB",
);
assert.ok(Number.isInteger(trials) && trials >= 1, "Trial count must be positive");
const run = new LocalApiRun(`large-${command}-${mib}`);
run.record({
	phase: "claim",
	claim:
		"Worker owner transforms above 8 MiB keep a cross-tenant bystander p95 and p99 within twice the same-configuration idle median, with zero failed probes or stalls and correct durable output.",
	requiredTrials: 5,
});
assert.ok(process.env.DATABASE_URL, "Cross-tenant load verification requires DATABASE_URL with CREATEDB permission");
const admin = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const tenantBindings = [
	{ role: "aggressor", tenant: "verifyagg" },
	{ role: "observer", tenant: "verifyobserver" },
].map((binding) => ({
	...binding,
	database: `sqlfs_verify_${run.runId.replace(/[^a-z0-9]/g, "")}_${binding.role}`,
}));
const createdDatabases = [];
const bindings = { default: process.env.DATABASE_URL };
const databases = new Map();
const measurements = [];
const environment = {
	loadAverageBefore: execFileSync("uptime", { encoding: "utf8" }).trim(),
	coresReported: execFileSync("nproc", { encoding: "utf8" }).trim(),
	cpuQuota: readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(),
	memoryLimit: readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(),
	configuration: Object.fromEntries(
		Object.entries(process.env).filter(([name]) =>
			/^(SQL_FS_WORKER|SQL_FS_MAX_INGRESS|MAX_EXEC_FILE_BYTES|MAX_FILE_WRITE_BYTES|SCRIPT_TX_BUFFER)/.test(name),
		),
	),
	tenantBindings,
	tenantDatabaseConnections: {},
};
let failure;
let isolatedTenantsVerified = false;
let sampler;
let stopContainerSampler;
const processSamples = [];
const workerSamples = [];
const ingressSamples = [];
let workerSampler;
let workerSample;
try {
	for (const binding of tenantBindings) {
		await admin.unsafe(`CREATE DATABASE "${binding.database}"`);
		createdDatabases.push(binding.database);
		const connection = new URL(process.env.DATABASE_URL);
		connection.pathname = `/${binding.database}`;
		bindings[binding.tenant] = connection.href;
		run.secrets.push(connection.href);
		databases.set(binding.tenant, postgres(connection.href, { max: 1, prepare: false }));
	}
	const configuration = JSON.stringify(bindings);
	run.secrets.push(configuration);
	const serverEnvironment = {
		TENANT_DATABASES: configuration,
		JUST_BASH_DEFENSE_IN_DEPTH: "true",
		JUST_BASH_DEFENSE_AUDIT_MODE: "false",
	};
	const { loadWorkerPoolOptions } = await import(join(repo, "dist/api/worker-owner/pool.js"));
	const { loadIngressOptions } = await import(join(repo, "dist/api/ingress-admission.js"));
	const configuredEnvironment = { ...process.env, ...serverEnvironment };
	environment.resourceOptions = {
		worker: loadWorkerPoolOptions(configuredEnvironment),
		ingress: loadIngressOptions(configuredEnvironment),
	};
	const server = await run.start(serverEnvironment);
	const aggressorOwner = await run.owner(tenantBindings[0].tenant);
	const observerOwner = await run.owner(tenantBindings[1].tenant);
	run.equal(aggressorOwner.tenant === observerOwner.tenant, false, "Independent bystander tenant");
	run.equal(tenantBindings[0].database === tenantBindings[1].database, false, "Distinct owned tenant database names");
	for (const binding of tenantBindings) {
		const connection = databases.get(binding.tenant);
		const rows = await connection`SELECT current_database() AS name`;
		run.equal(rows[0].name, binding.database, `Fresh reader is bound to the ${binding.role} tenant database`);
	}
	isolatedTenantsVerified = true;
	workerSampler = setInterval(() => {
		if (workerSample) return;
		workerSample = (async () => {
			const atMs = performance.now();
			try {
				const response = await fetch(`${server.base}/metrics`, {
					headers: { Authorization: `Bearer ${observerOwner.token}` },
					signal: AbortSignal.timeout(1000),
				});
				assert.equal(response.status, 200, "Worker resource metrics response");
				const body = await response.text();
				const metrics = Object.fromEntries(
					[...body.matchAll(/^sql_fs_worker_(\w+) ([\d.eE+-]+)$/gm)].map((match) => [
						match[1], Number(match[2]),
					]),
				);
				workerSamples.push({
					atMs,
					enabled: Number(body.match(/^sql_fs_workers_enabled ([\d.eE+-]+)$/m)?.[1]),
					...metrics,
				});
				ingressSamples.push({
					atMs,
					...Object.fromEntries(
						[...body.matchAll(/^(sql_fs_ingress_\w+) ([\d.eE+-]+)$/gm)].map((match) => [
							match[1], Number(match[2]),
						]),
					),
				});
			} catch (error) {
				workerSamples.push({ atMs, error: error.message });
				ingressSamples.push({ atMs, error: error.message });
			}
		})().finally(() => {
			workerSample = undefined;
		});
	}, 100);
	if (server.container) {
		environment.container = server.resourceProfile;
		stopContainerSampler = sampleContainer(server.container, (sample) =>
			processSamples.push({ atMs: performance.now(), ...sample }),
		);
	}
	const aggressor = await run.create(server, aggressorOwner);
	const observer = await run.create(server, observerOwner);
	run.equal(aggressorOwner.sub === observerOwner.sub, false, "Independent bystander owner");
	run.equal(aggressor.id === observer.id, false, "Independent bystander sandbox");
	const line = "abcdefghijklm abcdefghijklm 123\n";
	run.equal(Buffer.byteLength(line), 32, "Fixture line width");
	const input = Buffer.from(line.repeat((mib * 1024 * 1024) / 32));
	const expected = Buffer.from(input);
	for (let index = 0; index < expected.length; index++) {
		if (command === "sed" && expected[index] === 97) expected[index] = 122;
		if (command === "tr" && expected[index] >= 97 && expected[index] <= 109) expected[index] += 13;
	}
	await run.request(server, aggressorOwner, "PUT", `${aggressor.path}/files/home/user/input.txt`, {
		raw: input,
		status: 204,
	});
	const script =
		command === "sed"
			? "sed 's/a/z/g' /home/user/input.txt > /home/user/output.txt"
			: "tr a-m n-z < /home/user/input.txt > /home/user/output.txt";
	const probe = async () => {
		const result = await run.request(server, observerOwner, "POST", `${observer.path}/exec-sync`, {
			json: { script: "echo bystander-ok", readOnly: true },
		});
		run.equal([result.body.exitCode, result.body.stdout], [0, "bystander-ok\n"], "Bystander output and exit");
		return result;
	};
	for (let count = 0; count < 5; count++) await probe();
	for (const binding of tenantBindings) {
		const connection = databases.get(binding.tenant);
		const rows = await connection`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()`;
		environment.tenantDatabaseConnections[binding.tenant] = { baseline: rows[0].count };
	}
	environment.baselineDatabaseConnections = environment.tenantDatabaseConnections[aggressorOwner.tenant].baseline;
	if (!server.container)
		sampler = setInterval(() => {
			try {
				const status = readFileSync(`/proc/${server.child.pid}/status`, "utf8");
				const extract = (name) => Number(status.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
				processSamples.push({
					atMs: performance.now(),
					rssBytes: extract("VmRSS") * 1024,
					peakRssBytes: extract("VmHWM") * 1024,
					threads: extract("Threads"),
				});
			} catch {}
		}, 100);
	for (let trial = 0; trial < trials; trial++) {
		const idle = await scheduledProbes(probe, () => delay(3000));
		const measurement = { trial, idle: { ...idle, result: undefined }, outputVerified: false };
		measurements.push(measurement);
		writeFileSync(join(run.evidence, "trials.json"), `${JSON.stringify(measurements, null, 2)}\n`);
		run.equal(idle.errors, [], "All scheduled idle probes succeed");
		const loaded = await scheduledProbes(probe, () =>
			run.request(server, aggressorOwner, "POST", `${aggressor.path}/exec-sync`, {
				json: { script, timeoutMs: 120000 },
			}),
		);
		measurement.loaded = {
			...loaded,
			failure: loaded.failure?.message,
			result: loaded.result && {
				status: loaded.result.status,
				ms: loaded.result.ms,
				exitCode: loaded.result.body.exitCode,
			},
		};
		writeFileSync(join(run.evidence, "trials.json"), `${JSON.stringify(measurements, null, 2)}\n`);
		if (loaded.failure) throw loaded.failure;
		run.equal(loaded.errors, [], "All scheduled loaded probes succeed");
		run.equal(loaded.result.body.exitCode, 0, "Large-file transform exit");
		const { PostgresDialect } = await import(join(repo, "dist/sql-fs/dialects/postgres.js"));
		const { SqlFs } = await import(join(repo, "dist/sql-fs/sql-fs.js"));
		const dialect = new PostgresDialect(bindings[aggressorOwner.tenant]);
		await dialect.connect();
		try {
			const fresh = new SqlFs({ dialect, sandboxId: aggressor.id, tenantId: aggressorOwner.tenant });
			await fresh.ready();
			const output = await fresh.readFileBuffer("/home/user/output.txt");
			run.equal(output.byteLength, expected.byteLength, "Fresh Postgres reader output size");
			run.equal(sha256(output), sha256(expected), "Fresh Postgres reader output SHA-256");
		} finally {
			await dialect.disconnect();
		}
		measurement.outputVerified = true;
		measurement.outputBytes = expected.byteLength;
		measurement.outputSha256 = sha256(expected);
		writeFileSync(join(run.evidence, "trials.json"), `${JSON.stringify(measurements, null, 2)}\n`);
		console.log(
			JSON.stringify({ trial, command, mib, execMs: loaded.result.ms, idle: idle.responses, loaded: loaded.responses }),
		);
	}
	for (const binding of tenantBindings) {
		const connection = databases.get(binding.tenant);
		const rows = await connection`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()`;
		environment.tenantDatabaseConnections[binding.tenant].final = rows[0].count;
	}
	environment.finalDatabaseConnections = environment.tenantDatabaseConnections[aggressorOwner.tenant].final;
} catch (error) {
	failure = error;
} finally {
	clearInterval(sampler);
	clearInterval(workerSampler);
	for (const result of await Promise.allSettled([workerSample, stopContainerSampler?.()])) {
		if (result.status === "rejected") failure ??= result.reason;
	}
	if (run.servers[0]?.container) {
		try {
			environment.containerFinal = await containerResources(run.servers[0].container);
		} catch (error) {
			environment.containerCaptureError = error.message;
			failure ??= error;
		}
	}
	const ownedSandboxes = run.owners.map((owner) => ({ tenant: owner.tenant, ids: [...owner.sandboxes] }));
	for (const { tenant, ids } of ownedSandboxes) {
		try {
			if (ids.length) {
				const connection = databases.get(tenant);
				const rows = await connection`SELECT id FROM sandboxes WHERE id IN ${connection(ids)}`;
				assert.equal(rows.length, ids.length, "Known test sandboxes exist in their tenant before cleanup");
			}
		} catch (error) {
			failure ??= error;
		}
	}
	const events = run.servers.flatMap((server) =>
		server.log.split("\n").flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		}),
	);
	const completed = measurements.filter((trial) => trial.outputVerified);
	const median = (values) => distribution(values).p50Ms;
	const ratios = Object.fromEntries(
		["p95Ms", "p99Ms"].map((tail) => {
			const idleMedianMs = median(completed.map((trial) => trial.idle.responses[tail]));
			const loadedMedianMs = median(completed.map((trial) => trial.loaded.responses[tail]));
			return [tail, { idleMedianMs, loadedMedianMs, ratio: loadedMedianMs / idleMedianMs }];
		}),
	);
	const stallEvents = events.filter((event) => event.event === "event_loop_stall");
	const defenseViolations = events.filter((event) => event.event === "defense_in_depth_violation");
	try {
		validateWorkerSamples(workerSamples);
		validateIngressSamples(ingressSamples, environment.resourceOptions.ingress);
		if (environment.containerFinal) {
			const resources = environment.containerFinal;
			assert.ok(Number.isFinite(resources.peakRssBytes) && resources.peakRssBytes > 0, "Container RSS peak required");
			assert.ok(Number.isFinite(resources.memoryPeakBytes) && resources.memoryPeakBytes > 0, "Cgroup memory peak required");
			assert.equal(resources.oomKilled, false, "No container OOM termination");
			assert.equal(resources.memoryEvents.oom, 0, "No cgroup OOM events");
			assert.equal(resources.memoryEvents.oom_kill, 0, "No cgroup OOM kills");
		}
		run.equal(stallEvents, [], "No reported event-loop stalls");
		run.equal(defenseViolations, [], "No strict defense violations");
		if (trials >= 5 && completed.length === trials) {
			for (const [tail, value] of Object.entries(ratios))
				assert.ok(value.ratio <= 2, `${tail} loaded/idle ratio ${value.ratio} exceeds 2`);
		}
	} catch (error) {
		failure ??= error;
	}
	const detail = {
		classification:
			process.env.VERIFY_CPU_PROFILE === "1"
				? "profile, excluded from performance claim"
				: trials >= 5
					? "repeated proof"
					: "smoke, insufficient repetitions for performance claim",
		acceptance: { completedTrials: completed.length, requiredTrials: 5, tailRatioLimit: 2, ratios },
		command,
		mib,
		trials,
		completedTrials: completed.length,
		workerEnabled: process.env.SQL_FS_WORKERS_ENABLED,
		method: {
			arrivalIntervalMs: 20,
			responseLatency: "scheduled arrival to completed response, including generator delay",
			independentOwnerAndSandbox: true,
			independentTenantAndDatabase: isolatedTenantsVerified,
			persistence: "fresh SqlFs and Postgres dialect bound to the aggressor tenant, without Redis or shared content cache",
			strictDefense: true,
			failedProbesRetained: true,
			resourceSampling: "100 ms parent metrics; worker external memory is last reported at operation boundaries",
		},
		environment,
		measurements,
		trialP99Ms: {
			idle: distribution(completed.map((trial) => trial.idle.responses.p99Ms)),
			loaded: distribution(completed.map((trial) => trial.loaded.responses.p99Ms)),
		},
		processSamples,
		workerSamples,
		ingressSamples,
		peakRssBytes:
			environment.containerFinal?.peakRssBytes ?? Math.max(0, ...processSamples.map((sample) => sample.peakRssBytes)),
		stallEvents,
		defenseViolations,
	};
	await run.finish(failure, detail, async () => {
		const errors = [];
		detail.postgresCleanup = {
			tenants: [],
			createdDatabases: [...createdDatabases],
			droppedDatabases: [],
			remainingDatabases: [],
			verified: false,
		};
		try {
			for (const { tenant, ids } of ownedSandboxes) {
				try {
					const connection = databases.get(tenant);
					const remaining = ids.length ? await connection`SELECT id FROM sandboxes WHERE id IN ${connection(ids)}` : [];
					detail.postgresCleanup.tenants.push({
						tenant,
						database: tenantBindings.find((binding) => binding.tenant === tenant).database,
						sandboxIds: ids,
						remainingSandboxIds: remaining.map((row) => row.id),
						verified: remaining.length === 0,
					});
					run.equal(remaining.length, 0, "Exact sandbox cleanup in the owning tenant database");
				} catch (error) {
					errors.push(error);
				}
			}
			for (const connection of databases.values()) {
				try {
					await connection.end({ timeout: 5 });
				} catch (error) {
					errors.push(error);
				}
			}
			for (const name of createdDatabases) {
				try {
					await admin.unsafe(`DROP DATABASE "${name}"`);
					detail.postgresCleanup.droppedDatabases.push(name);
				} catch (error) {
					errors.push(error);
				}
			}
			try {
				const remaining = createdDatabases.length
					? await admin`SELECT datname FROM pg_database WHERE datname IN ${admin(createdDatabases)}`
					: [];
				detail.postgresCleanup.remainingDatabases = remaining.map((row) => row.datname);
				run.equal(remaining.length, 0, "Owned load-test tenant databases removed");
			} catch (error) {
				errors.push(error);
			}
			detail.postgresCleanup.verified = errors.length === 0;
			writeFileSync(
				join(run.evidence, "postgres-cleanup.json"),
				`${JSON.stringify(run.redact(detail.postgresCleanup), null, 2)}\n`,
			);
		} finally {
			await admin.end({ timeout: 5 });
		}
		if (errors.length) throw new AggregateError(errors, "Cross-tenant load cleanup failed");
	});
}
