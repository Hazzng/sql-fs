import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { buildScript, markerIntegrity, outcomeTotals, overloadDelayMs, validateOperation, visitConcurrent } from './aca-load-workload.mjs';
import { waitForStartBarrier } from './aca-load-barrier.mjs';

const defaults = { app: 'virtualfs-api', group: 'rg-harry-dev', duration: '30', rate: '2', pool: '20',
	'max-inflight': '20', 'setup-concurrency': '1', 'timeout-ms': '120000', 'command-timeout-ms': '30000', 'hold-ms': '250',
	'cpu-iterations': '0', 'start-barrier-timeout-ms': '300000', interval: '5', 'max-start-delay-ms': '250', retries: '0' };
const { positionals: [command], values: flags } = parseArgs({ allowPositionals: true, options: {
	...Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, { type: 'string', default: v }])),
	'start-barrier': { type: 'string' }, out: { type: 'string' }, manifest: { type: 'string' }, tenant: { type: 'string' },
	resource: { type: 'string', multiple: true, default: [] }, 'app-metrics': { type: 'boolean', default: false },
	help: { type: 'boolean', default: false },
} });
if (flags.help || !['inspect', 'observe', 'load', 'cleanup'].includes(command)) {
	console.log('node aca-load.mjs inspect|observe|load|cleanup [--help]\n' +
		'Common: --app NAME --group RG --out NEW_DIRECTORY --resource ARM_ID (repeatable)\n' +
		'Observe: --duration SECONDS --interval SECONDS [--app-metrics]\n' +
		'Load: --duration SECONDS --rate OPS_PER_SECOND --pool N --max-inflight N --hold-ms N\n' +
		'      --cpu-iterations N --retries N --timeout-ms N --command-timeout-ms N --tenant ID\n' +
		'      --max-start-delay-ms N --interval SECONDS --setup-concurrency N (1..8, default 1)\n' +
		'      --start-barrier PATH [--start-barrier-timeout-ms N (1000..900000, default 300000)]\n' +
		'      Creates PATH.prepared.json after setup; atomically write {runId,release:true} to PATH to start.\nCleanup: --manifest PATH');
	process.exit(flags.help ? 0 : 2);
}
function number(key, min, max, integer = false) {
	const n = Number(flags[key]);
	if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`Invalid --${key}`);
	return n;
}
const cfg = { duration: number('duration', 1, 7200), rate: number('rate', 0.01, 1000),
	pool: number('pool', 1, 500, true), setupConcurrency: number('setup-concurrency', 1, 8, true), maxInflight: number('max-inflight', 1, 500, true),
	timeout: number('timeout-ms', 5000, 120000, true), commandTimeout: number('command-timeout-ms', 1000, 90000, true),
	hold: number('hold-ms', 0, 60000), cpu: number('cpu-iterations', 0, 100000, true),
	startBarrierTimeoutMs: number('start-barrier-timeout-ms', 1000, 900000, true),
	interval: number('interval', 1, 300), maxDelay: number('max-start-delay-ms', 1, 10000), retries: number('retries', 0, 20, true) };
if (flags['start-barrier'] !== undefined && !flags['start-barrier'].trim()) throw new Error('--start-barrier must name a local release file');
if (flags['start-barrier'] && command !== 'load') throw new Error('--start-barrier is only valid for load');
if (cfg.timeout <= cfg.commandTimeout + 5000 || cfg.hold >= cfg.commandTimeout || Math.ceil(cfg.duration * cfg.rate) * (cfg.retries + 1) > 500000)
	throw new Error('Require timeout > command timeout + 5000ms, hold < command timeout, and <= 500000 possible attempts');
if (flags.resource.length > 8 || flags.resource.some(x => !/^\/subscriptions\/[\w-]+\/resourceGroups\/[\w.-]+\/providers\/Microsoft\.(App\/containerApps|DBforPostgreSQL\/flexibleServers|Cache\/Redis)\/[\w.-]+$/i.test(x)))
	throw new Error('Resources must be up to 8 ACA, PostgreSQL Flexible Server or Azure Redis ARM IDs');
const exec = promisify(execFile), now = () => new Date().toISOString(), sleep = ms => new Promise(r => setTimeout(r, ms));
const runId = `aca-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const root = flags.manifest ? dirname(resolve(flags.manifest)) : resolve(flags.out || join(dirname(fileURLToPath(import.meta.url)), '.run', runId));
let manifest, base, token, loadStart, loadDeadline, stopped = false, logging = Promise.resolve();
const ledger = [], delays = [], running = new Set(), errors = Object.create(null);
const counters = { planned: Math.ceil(cfg.rate * cfg.duration), offered: 0, dropped: 0, sentOperations: 0,
	sentAttempts: 0, completedAttempts: 0, completedOperations: 0, completedInOfferWindow: 0, successesInOfferWindow: 0, httpResponses: 0,
	successes: 0, safeRefusals: 0, unknown: 0, failed: 0, peakInflight: 0 };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; });
const safeCode = x => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(x) ? x : null;
const safeError = error => ({ error: safeCode(error?.name) || 'Error', code: safeCode(error?.code ?? error?.cause?.code), killed: error?.killed === true });
const record = row => { const entry = JSON.stringify({ at: now(), ...row }) + '\n'; logging = logging.then(() => appendFile(join(root, 'events.jsonl'), entry)); return logging; };
async function jsonFile(name, value) { const path = join(root, name); await writeFile(path + '.tmp', JSON.stringify(value, null, 2)); await rename(path + '.tmp', path); }
let manifestWrites = Promise.resolve();
const saveManifest = () => {
	const snapshot = structuredClone(manifest);
	manifestWrites = manifestWrites.then(() => jsonFile('manifest.json', snapshot));
	return manifestWrites;
};
async function az(args) {
	try { const r = await exec('az', [...args, '--output', 'json', '--only-show-errors'], { timeout: 60000, maxBuffer: 16 * 1024 ** 2 }); return JSON.parse(r.stdout); }
	catch (error) { throw Object.assign(new Error('Azure CLI read failed; stdout and stderr suppressed'), { code: safeCode(String(error?.code)), name: 'AzureReadError' }); }
}
const appArgs = () => ['--name', flags.app, '--resource-group', flags.group];
async function appState() {
	return az(['containerapp', 'show', ...appArgs(), '--query', '{id:id,name:name,location:location,fqdn:properties.configuration.ingress.fqdn,revision:properties.latestRevisionName,ready:properties.latestReadyRevisionName,provisioning:properties.provisioningState,scale:{min:properties.template.scale.minReplicas,max:properties.template.scale.maxReplicas,polling:properties.template.scale.pollingInterval,cooldown:properties.template.scale.cooldownPeriod,rules:properties.template.scale.rules[].{name:name,httpConcurrency:http.metadata.concurrentRequests,customType:custom.type}},containers:properties.template.containers[].{name:name,image:image,resources:resources}}']);
}
async function armSnapshot() {
	const requestedAt = now(), state = await appState();
	const revisions = await az(['containerapp', 'revision', 'list', ...appArgs(), '--all', '--query', '[].{name:name,active:properties.active,replicas:properties.replicas,running:properties.runningState,health:properties.healthState}']);
	const eligible = revisions.filter(x => x.active || x.replicas > 0), selected = eligible.slice(0, 30);
	const replicas = await Promise.all(selected.map(async revision => {
		try { return { revision: revision.name, replicas: await az(['containerapp', 'replica', 'list', ...appArgs(), '--revision', revision.name, '--query', '[].{name:name,created:properties.createdTime,state:properties.runningState,containers:properties.containers[].{name:name,ready:ready,started:started,restarts:restartCount,state:runningState}}']) }; }
		catch (error) { return { revision: revision.name, ...safeError(error) }; }
	}));
	return { requestedAt, observedAt: now(), state, revisions, replicas, replicaInventoryTruncated: eligible.length > selected.length };
}
async function authenticate(owner, tenant) {
	const app = await az(['containerapp', 'show', ...appArgs()]);
	const env = app.properties.template.containers.find(c => c.name === 'api')?.env || [];
	const entry = env.find(x => x.name === 'AUTH_SECRET');
	let secret = entry?.value;
	if (!secret && entry?.secretRef) {
		const secrets = await az(['rest', '--method', 'post', '--url', `https://management.azure.com${app.id}/listSecrets?api-version=2025-07-01`]);
		secret = secrets.value.find(x => x.name === entry.secretRef)?.value;
	}
	if (!secret) throw new Error('Cannot resolve application signing key');
	const enc = x => Buffer.from(JSON.stringify(x)).toString('base64url');
	const payload = `${enc({ alg: 'HS256' })}.${enc({ sub: owner, ...(tenant ? { tenant } : {}), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 14400 })}`;
	token = `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
	base = `https://${app.properties.configuration.ingress.fqdn}`;
	if (manifest?.base && manifest.base !== base) throw new Error('Application hostname differs from cleanup manifest');
}
async function request(path, body, method = body === undefined ? 'GET' : 'POST', limit = 1024 * 1024, deadline = cfg.timeout) {
	const began = performance.now(), requestedAt = now(); let status = null;
	try {
		const response = await fetch(base + path, { method, redirect: 'error', headers: { Authorization: `Bearer ${token}`,
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline))) });
		status = response.status; const chunks = []; let bytes = 0;
		if (response.body) for await (const chunk of response.body) { bytes += chunk.length; if (bytes > limit) throw Object.assign(new Error('Response exceeds limit'), { name: 'ResponseTooLarge' }); chunks.push(chunk); }
		const text = Buffer.concat(chunks).toString('utf8'); let json;
		try { json = JSON.parse(text); } catch { /* Binary and Prometheus responses have no JSON body. */ }
		const retryAfter = response.headers.get('retry-after');
		const replica = ['x-sqlfs-replica', 'x-replica-id', 'x-azure-containerapp-replica-name'].map(k => safeCode(response.headers.get(k))).find(Boolean) || null;
		return { status, requestedAt, ms: performance.now() - began, bytes, hash: createHash('sha256').update(text).digest('hex'),
			code: safeCode(json?.code), retryable: json?.retryable === true, retryAfter, replica, text, json };
	} catch (error) { return { status, requestedAt, ms: performance.now() - began, ...safeError(error), transportFailure: true }; }
}
function publicResult(r) { return { status: r.status, requestedAt: r.requestedAt, ms: r.ms, bytes: r.bytes, hash: r.hash,
	code: r.code, retryable: r.retryable, retryAfter: safeCode(r.retryAfter), replica: r.replica, error: r.error,
	transportFailure: r.transportFailure, exitCode: r.json?.exitCode, stdoutBytes: typeof r.json?.stdout === 'string' ? Buffer.byteLength(r.json.stdout) : undefined,
	stderrBytes: typeof r.json?.stderr === 'string' ? Buffer.byteLength(r.json.stderr) : undefined }; }
const safeRefusal = r => !r.transportFailure && r.status === 503 && r.retryable === true && ['EWORKER_BUSY', 'ERUNTIME_BUSY', 'ESHUTTINGDOWN'].includes(r.code);
async function appMetrics() {
	const r = await request('/metrics'); const metrics = Object.create(null);
	if (r.status === 200 && !r.transportFailure) for (const line of r.text.split('\n')) {
		const m = /^((?:sql_fs_|process_|nodejs_)[a-zA-Z0-9_]+(?:\{le="(?:\+Inf|\d+)"\})?) ([+\-\d.eE]+)$/.exec(line);
		if (m && Number.isFinite(Number(m[2])) && Object.keys(metrics).length < 200) metrics[m[1]] = Number(m[2]);
	}
	return { scope: 'load-balanced per-replica sample, never a fleet total', replica: r.replica,
		identityAvailable: r.replica !== null, request: publicResult(r), metrics };
}
const resourceMetrics = new Map();
async function prepareResources() {
	for (const resource of flags.resource) {
		try {
			const definitions = await az(['monitor', 'metrics', 'list-definitions', '--resource', resource]);
			const available = definitions.map(d => ({ name: safeCode(d.name?.value), unit: safeCode(d.unit), aggregation: safeCode(d.primaryAggregationType) }));
			const acaNames = new Set(['UsageNanoCores', 'WorkingSetBytes', 'RestartCount', 'Replicas', 'Requests', 'RxBytes', 'TxBytes']);
			const chosen = available.filter(d => /Microsoft\.App\/containerApps/i.test(resource) ? acaNames.has(d.name) :
				/cpu|nano.?cores|memory|working.?set|restart|connection|request|latency|error|load|cache|bandwidth|network|iops|replica|bytes/i.test(d.name || '')).slice(0, 16);
			resourceMetrics.set(resource, chosen.map(d => d.name));
			await record({ kind: 'metricDefinitions', resource, available, chosen });
		} catch (error) { await record({ kind: 'metricDefinitions', resource, ...safeError(error) }); }
	}
}
async function azureMetrics() {
	for (const [resource, names] of resourceMetrics) {
		if (!names.length) continue;
		try {
			const result = await az(['monitor', 'metrics', 'list', '--resource', resource, '--metric', ...names,
				'--start-time', new Date(Date.now() - 300000).toISOString(), '--end-time', now(), '--interval', 'PT1M']);
			await record({ kind: 'azureMetrics', resource, interval: 'PT1M', values: result.value?.map(m => ({ name: safeCode(m.name?.value), unit: safeCode(m.unit),
				series: m.timeseries?.slice(0, 100).map(s => ({ dimensions: s.metadatavalues?.map(d => ({ name: safeCode(d.name?.value), value: safeCode(d.value) })),
					data: s.data?.slice(-6).map(d => ({ timeStamp: d.timeStamp, average: d.average, maximum: d.maximum, minimum: d.minimum, total: d.total, count: d.count })) })) })) });
		} catch (error) { await record({ kind: 'azureMetrics', resource, ...safeError(error) }); }
	}
}
async function sample(withApp) {
	await record({ kind: 'generatorSample', rssBytes: process.memoryUsage().rss, cpu: process.cpuUsage(), inflight: running.size });
	const tasks = [armSnapshot().then(value => record({ kind: 'arm', value })), azureMetrics()];
	if (withApp) tasks.push(appMetrics().then(value => record({ kind: 'appMetrics', value })));
	for (const result of await Promise.allSettled(tasks)) if (result.status === 'rejected') await record({ kind: 'observationError', ...safeError(result.reason) });
}
async function cleanup(recover = false) {
	const found = await request('/v1/sandboxes');
	await record({ kind: 'cleanupDiscovery', request: publicResult(found) });
	const discovered = found.status === 200 && !found.transportFailure && Array.isArray(found.json?.sandboxes);
	if (discovered) {
		for (const s of found.json.sandboxes) if (s.owner === manifest.owner && /^[0-9a-f-]{36}$/i.test(s.id)) {
			if (!manifest.sandboxes.some(x => x.id === s.id)) manifest.sandboxes.push({ id: s.id, name: s.name });
		}
	}
	manifest.cleanupPending = true; await saveManifest();
	await visitConcurrent(manifest.sandboxes, 4, async sandbox => {
		if (recover) {
			const r = await request(`/v1/sandboxes/${sandbox.id}/files/home/user/aca-markers.txt`, undefined, 'GET', 32 * 1024 ** 2);
			const markerCounts = new Map();
			if (r.status === 200 && !r.transportFailure) for (const line of r.text.split('\n')) if (line.startsWith(`${manifest.runId}-`) && safeCode(line)) markerCounts.set(line, (markerCounts.get(line) || 0) + 1);
			const file = `recovery-${Date.now()}-${sandbox.id}.json`;
			await jsonFile(file, { sandbox: sandbox.id, request: publicResult(r), markerCounts: [...markerCounts] });
			await record({ kind: 'recoveryReadback', sandbox: sandbox.id, file, request: publicResult(r) });
		}
		let r;
		for (let attempt = 0; attempt < 3; attempt++) {
			r = await request(`/v1/sandboxes/${sandbox.id}`, undefined, 'DELETE');
			await record({ kind: 'cleanup', sandbox: sandbox.id, attempt, request: publicResult(r) });
			if ([200, 204, 404].includes(r.status) && !r.transportFailure) break;
			await sleep(1000 + Math.random() * 500);
		}
		sandbox.deleted = [200, 204, 404].includes(r.status) && !r.transportFailure;
		await saveManifest();
	});
	manifest.cleanupPending = !discovered || manifest.sandboxes.some(sandbox => !sandbox.deleted);
	manifest.cleanedAt = now(); await saveManifest();
	if (manifest.cleanupPending) process.exitCode = 1;
}
function stats(values) {
	if (!values.length) return { count: 0 };
	const sorted = [...values].sort((a, b) => a - b), q = p => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
	return { count: sorted.length, min: sorted[0], mean: sorted.reduce((a, b) => a + b, 0) / sorted.length, p50: q(.5), p95: q(.95), p99: q(.99), max: sorted.at(-1) };
}
async function validate() {
	const validation = [], unknown = [], integrity = [];
	await visitConcurrent(manifest.sandboxes, 4, async sandbox => {
		const r = await request(`/v1/sandboxes/${sandbox.id}/files/home/user/aca-markers.txt`, undefined, 'GET', 32 * 1024 ** 2);
		const counts = new Map();
		if (r.status === 200 && !r.transportFailure) for (const line of r.text.split('\n').filter(Boolean)) counts.set(line, (counts.get(line) || 0) + 1);
		const readable = !r.transportFailure && (r.status === 200 || (r.status === 404 && r.code === 'ENOENT'));
		const operations = ledger.filter(op => op.sandbox === sandbox.id);
		for (const op of operations) {
			const row = validateOperation(op, counts, readable);
			validation.push(row); if (op.outcome === 'unknown') unknown.push({ ...row, attempts: op.attempts });
			await record({ kind: 'validation', ...row });
		}
		const checked = { sandbox: sandbox.id, ...markerIntegrity(operations, counts) }; integrity.push(checked);
		await record({ kind: 'readback', sandbox: sandbox.id, request: publicResult(r), readable, markers: counts.size, integrity: checked });
	});
	await jsonFile('reconciliation.json', { checkedAt: now(), validation, integrity, unknown,
		note: 'Unknown outcomes remain unknown even when a marker is found. Cleanup follows this saved readback.' });
	return { validation, integrity };
}
async function execute(op) {
	const began = performance.now();
	for (let attempt = 0; ; attempt++) {
		const marker = `${op.marker}-${attempt}`;
		const script = buildScript(marker, cfg);
		record({ kind: 'attemptStart', op: op.id, sandbox: op.sandbox, attempt, marker, scheduledMs: op.scheduledMs });
		const sendDelayMs = performance.now() - loadStart - op.scheduledMs;
		if (attempt === 0) op.sendStartDelayMs = sendDelayMs;
		counters.sentAttempts++;
		const r = await request(`/v1/sandboxes/${op.sandbox}/exec-sync`, { script, timeoutMs: cfg.commandTimeout }, 'POST', 1024 * 1024, cfg.timeout - (performance.now() - began));
		counters.completedAttempts++;
		if (r.status !== null) counters.httpResponses++;
		const success = !r.transportFailure && r.status === 200 && r.json?.exitCode === 0 && r.json?.stdout === marker && r.json?.stderr === '';
		const refused = safeRefusal(r), key = `${r.status ?? 'transport'}:${r.code || r.error || (success ? 'success' : 'unexpected')}`;
		const rejected = !r.transportFailure && [400, 401, 403, 404, 413, 415, 422, 429].includes(r.status);
		if (!success) errors[key] = (errors[key] || 0) + 1;
		op.attempts.push({ ...publicResult(r), marker, success, safeRefusal: refused, rejected, sendDelayMs });
		record({ kind: 'attempt', op: op.id, sandbox: op.sandbox, attempt, marker, success, safeRefusal: refused, rejected, result: publicResult(r) });
		if (refused && attempt < cfg.retries && !stopped) {
			const after = overloadDelayMs(r.retryAfter, attempt);
			if (performance.now() - began + after + cfg.commandTimeout + 5000 > cfg.timeout) { op.outcome = 'safeRefusal'; break; }
			await sleep(after + Math.random() * Math.min(1000, after * .25 + 100));
			if (stopped) { op.outcome = 'safeRefusal'; break; }
			continue;
		}
		op.outcome = success ? 'success' : refused ? 'safeRefusal' : rejected ? 'failed' : 'unknown'; break;
	}
	op.ms = performance.now() - began; op.completedAfterStartMs = performance.now() - loadStart; op.endedAt = now(); counters.completedOperations++;
	if (performance.now() <= loadDeadline) { counters.completedInOfferWindow++; if (op.outcome === 'success') counters.successesInOfferWindow++; }
	if (op.outcome === 'success') counters.successes++; else if (op.outcome === 'safeRefusal') counters.safeRefusals++; else if (op.outcome === 'failed') counters.failed++; else counters.unknown++;
	record({ kind: 'operation', ...op });
}
async function load() {
	manifest = { version: 1, runId, owner: `aca-load-${randomUUID()}`, tenant: flags.tenant || null, app: flags.app, group: flags.group,
		namePrefix: `${runId}-`, createdAt: now(), cleanupPending: true, sandboxes: [] };
	await saveManifest(); await authenticate(manifest.owner, manifest.tenant); manifest.base = base; await saveManifest();
	let sampler, sampling = true, validation = [], integrity = [], measurement, began, offeredEnd;
	const loop = monitorEventLoopDelay({ resolution: 10 });
	try {
		await visitConcurrent(Array.from({ length: cfg.pool }), cfg.setupConcurrency, async (_, i) => {
			if (stopped) return;
			const name = `${manifest.namePrefix}${i}`;
			const r = await request('/v1/sandboxes', { name });
			await record({ kind: 'create', name, request: publicResult(r) });
			if (r.status !== 201 || r.json?.owner !== manifest.owner || !/^[0-9a-f-]{36}$/i.test(r.json?.id || '') || r.transportFailure) throw new Error('Sandbox creation failed; cleanup discovers any owned orphan');
			manifest.sandboxes.push({ id: r.json.id, name }); await saveManifest();
		});
		if (flags['start-barrier']) {
			await waitForStartBarrier(resolve(flags['start-barrier']), runId, { timeoutMs: cfg.startBarrierTimeoutMs, isStopped: () => stopped });
			await record({ kind: 'startBarrierReleased', runId });
		}
		await sample(true);
		const available = [...manifest.sandboxes];
		loop.enable(); began = performance.now(); loadStart = began; loadDeadline = began + cfg.duration * 1000; measurement = now();
		record({ kind: 'offerWindowStart', measurement, durationSeconds: cfg.duration, planned: counters.planned });
		sampler = (async () => { while (sampling && !stopped) { await sleep(cfg.interval * 1000); if (sampling && !stopped) await sample(true); } })().catch(() => { stopped = true; sampling = false; });
		for (let id = 0; id < counters.planned && !stopped; id++) {
			const due = began + id * 1000 / cfg.rate;
			if (due > performance.now()) await sleep(due - performance.now());
			if (stopped) break;
			const delay = performance.now() - due; counters.offered++; delays.push(delay);
			if (delay > cfg.maxDelay || running.size >= cfg.maxInflight || !available.length) {
				counters.dropped++; record({ kind: 'drop', id, scheduledMs: id * 1000 / cfg.rate, startDelayMs: delay,
					reason: delay > cfg.maxDelay ? 'generator-late' : running.size >= cfg.maxInflight ? 'max-inflight' : 'pool-exhausted' }); continue;
			}
			const sandbox = available.shift(), op = { id, sandbox: sandbox.id, marker: `${runId}-${id}`, scheduledMs: id * 1000 / cfg.rate,
				startDelayMs: delay, startedAt: now(), attempts: [] };
			ledger.push(op); counters.sentOperations++;
			const task = execute(op).catch(error => { stopped = true; op.outcome ||= 'unknown'; op.driverError = safeError(error); }).finally(() => { running.delete(task); available.push(sandbox); });
			running.add(task); counters.peakInflight = Math.max(counters.peakInflight, running.size);
		}
		if (!stopped && performance.now() < loadDeadline) await sleep(loadDeadline - performance.now());
		offeredEnd = performance.now(); record({ kind: 'offerWindowEnd', elapsedMs: offeredEnd - began });
		await Promise.allSettled(running); loop.disable(); record({ kind: 'drainEnd', elapsedMs: performance.now() - began });
		if (ledger.some(op => op.outcome === 'unknown')) {
			await record({ kind: 'reconciliationWait', ms: cfg.commandTimeout + 5000 }); await sleep(cfg.commandTimeout + 5000);
		}
		({ validation, integrity } = await validate());
	} finally {
		sampling = false; await sampler?.catch(() => { stopped = true; }); loop.disable(); await Promise.allSettled(running);
		await cleanup();
		const valid = validation.filter(x => x.valid === true).length, invalid = validation.filter(x => x.valid === false).length;
		const integrityFailures = integrity.filter(x => !x.valid).length;
		const totals = outcomeTotals(ledger);
		const attemptLatencies = Object.create(null);
		for (const op of ledger) for (const a of op.attempts) {
			const key = `${a.status ?? 'transport'}:${a.code || a.error || (a.success ? 'success' : 'unexpected')}`;
			(attemptLatencies[key] ||= []).push(a.ms);
		}
		const summary = { runId, measurement, config: cfg, stopped, ...counters, ledgerOperations: ledger.length,
			successes: totals.success, safeRefusals: totals.safeRefusal, unknown: totals.unknown, failed: totals.failed,
			errors, offersSeconds: began === undefined ? null : (offeredEnd - began) / 1000,
			wallSeconds: began === undefined ? null : (performance.now() - began) / 1000, targetOfferedRate: cfg.rate,
			actualOfferedRate: counters.offered / cfg.duration, sentOperationsRate: counters.sentOperations / cfg.duration,
			completedRateDuringOfferWindow: counters.completedInOfferWindow / cfg.duration, successRateDuringOfferWindow: counters.successesInOfferWindow / cfg.duration,
			latencyMs: stats(ledger.map(x => x.ms).filter(Number.isFinite)), successLatencyMs: stats(ledger.filter(x => x.outcome === 'success').map(x => x.ms)),
			attemptLatencyMsByResult: Object.fromEntries(Object.entries(attemptLatencies).map(([key, values]) => [key, stats(values)])),
			startDelayMs: stats(delays), sentStartDelayMs: stats(ledger.map(x => x.sendStartDelayMs).filter(Number.isFinite)), generator: { rssBytes: process.memoryUsage().rss, maxRssBytes: process.resourceUsage().maxRSS * 1024,
				eventLoopLagMs: { mean: Number.isFinite(loop.mean) ? loop.mean / 1e6 : null, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 } },
			validation: { checked: validation.length, valid, invalid, integrityFailures }, cleanupPending: manifest.cleanupPending };
		await jsonFile('summary.json', summary);
		if (invalid || integrityFailures || validation.length !== ledger.length || totals.unknown || totals.failed || manifest.cleanupPending || stopped) process.exitCode = 1;
	}
}
try {
	if (command === 'cleanup') {
		if (!flags.manifest) throw new Error('cleanup requires --manifest');
		manifest = JSON.parse(await readFile(resolve(flags.manifest), 'utf8'));
		if (manifest.version !== 1 || !/^aca-load-[0-9a-f-]{36}$/i.test(manifest.owner) || !/^aca-[a-z0-9-]+-$/.test(manifest.namePrefix) || !Array.isArray(manifest.sandboxes) || manifest.sandboxes.some(s => !/^[0-9a-f-]{36}$/i.test(s.id))) throw new Error('Invalid cleanup manifest');
		flags.app = manifest.app; flags.group = manifest.group; await authenticate(manifest.owner, manifest.tenant); await cleanup(true);
	} else {
		await mkdir(dirname(root), { recursive: true }); await mkdir(root);
		await record({ kind: 'configuration', runId, command, app: flags.app, group: flags.group, config: cfg,
			workload: 'one tenant, distinct owned sandboxes, durable append, no concurrent reuse of a sandbox', node: process.version });
		await prepareResources();
		if (command === 'load') await load();
		else if (command === 'inspect') await jsonFile('inspect.json', await armSnapshot());
		else {
			if (flags['app-metrics']) await authenticate(`aca-observe-${randomUUID()}`, flags.tenant);
			const until = Date.now() + cfg.duration * 1000;
			do { await sample(flags['app-metrics']); if (Date.now() >= until || stopped) break; await sleep(Math.min(cfg.interval * 1000, until - Date.now())); } while (!stopped);
		}
	}
	await logging; console.log(JSON.stringify({ evidence: root, exitCode: process.exitCode || 0 }));
} catch (error) {
	await record({ kind: 'fatal', ...safeError(error) }).catch(() => {});
	console.error(JSON.stringify({ error: 'Driver failed; inspect sanitized evidence', ...safeError(error), evidence: root })); process.exitCode = 1;
}
