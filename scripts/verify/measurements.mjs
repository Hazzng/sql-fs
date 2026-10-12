import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

export function validateWorkerSamples(samples) {
	assert.ok(samples.length > 0, "Worker resource telemetry must contain samples");
	for (const sample of samples) {
		assert.equal(sample.error, undefined, "Worker resource telemetry must not contain sampling failures");
		assert.equal(sample.enabled, 1, "Worker resource telemetry must confirm worker mode");
		for (const field of ["capacity", "process_rss_bytes", "external_bytes", "refused_total", "restarts_total"]) {
			assert.ok(Number.isFinite(sample[field]) && sample[field] >= 0, `Worker telemetry requires finite ${field}`);
		}
		assert.ok(sample.capacity > 0 && sample.process_rss_bytes > 0, "Worker telemetry requires positive capacity and RSS");
		assert.equal(sample.refused_total, 0, "Loaded proof must not refuse worker requests");
		assert.equal(sample.restarts_total, 0, "Loaded proof must not restart workers");
	}
}

export function validateIngressSamples(samples, options) {
	assert.ok(samples.length > 0, "Ingress resource telemetry must contain samples");
	for (const sample of samples) {
		assert.equal(sample.error, undefined, "Ingress resource telemetry must not contain sampling failures");
		assert.equal(sample.sql_fs_ingress_enabled, 1, "Ingress resource telemetry must confirm ingress admission");
		for (const field of [
			"sql_fs_ingress_active_requests",
			"sql_fs_ingress_queued_requests",
			"sql_fs_ingress_retained_raw_bytes",
			"sql_fs_ingress_refused_total",
			"sql_fs_ingress_payload_too_large_total",
			"sql_fs_ingress_aborted_total",
			"sql_fs_ingress_queue_timeouts_total",
		]) {
			assert.ok(
				Number.isSafeInteger(sample[field]) && sample[field] >= 0,
				`Ingress telemetry requires nonnegative integer ${field}`,
			);
		}
		assert.ok(
			sample.sql_fs_ingress_active_requests <= options.maxRequests,
			"Ingress active requests exceed configured capacity",
		);
		assert.ok(
			sample.sql_fs_ingress_queued_requests <= options.maxRequests,
			"Ingress queued requests exceed configured capacity",
		);
		assert.ok(
			sample.sql_fs_ingress_retained_raw_bytes <= options.maxBytes,
			"Ingress retained raw bytes exceed configured capacity",
		);
		for (const field of [
			"sql_fs_ingress_refused_total",
			"sql_fs_ingress_payload_too_large_total",
			"sql_fs_ingress_aborted_total",
			"sql_fs_ingress_queue_timeouts_total",
		]) {
			assert.equal(sample[field], 0, `Loaded proof requires zero ${field}`);
		}
	}
}

export function distribution(values) {
	if (!values.length) return { count: 0, p50Ms: null, p95Ms: null, p99Ms: null, minMs: null, maxMs: null };
	const sorted = values.toSorted((a, b) => a - b);
	const percentile = (p) => sorted[Math.ceil(sorted.length * p) - 1];
	return {
		count: sorted.length,
		p50Ms: percentile(0.5),
		p95Ms: percentile(0.95),
		p99Ms: percentile(0.99),
		minMs: sorted[0],
		maxMs: sorted.at(-1),
	};
}

export async function scheduledProbes(probe, work, intervalMs = 20) {
	const origin = performance.now();
	const samples = [];
	const pending = [];
	let ordinal = 0;
	const sendDue = (until) => {
		while (origin + ordinal * intervalMs <= until) {
			const scheduledMs = ordinal++ * intervalMs;
			const sentMs = performance.now() - origin;
			pending.push(
				probe()
					.then((result) => {
						const completedMs = performance.now() - origin;
						samples.push({
							scheduledMs,
							sentMs,
							completedMs,
							latencyMs: completedMs - scheduledMs,
							requestMs: result.ms,
							status: result.status,
						});
					})
					.catch((error) => {
						const completedMs = performance.now() - origin;
						samples.push({
							scheduledMs,
							sentMs,
							completedMs,
							latencyMs: completedMs - scheduledMs,
							error: error.message,
						});
					}),
			);
		}
	};
	const timer = setInterval(() => sendDue(performance.now()), intervalMs);
	let result;
	let failure;
	try {
		sendDue(origin);
		result = await work();
	} catch (error) {
		failure = error;
	} finally {
		clearInterval(timer);
		sendDue(performance.now());
		await Promise.all(pending);
	}
	const ordered = samples.toSorted((a, b) => a.scheduledMs - b.scheduledMs);
	return {
		result,
		failure,
		samples: ordered,
		responses: distribution(
			ordered.filter((sample) => !sample.error && sample.status === 200).map((sample) => sample.latencyMs),
		),
		errors: ordered.filter((sample) => sample.error || sample.status !== 200),
		arrivalIntervalMs: intervalMs,
	};
}
