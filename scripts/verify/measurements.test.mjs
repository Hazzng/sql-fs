import assert from "node:assert/strict";
import test from "node:test";
import { distribution, scheduledProbes, validateIngressSamples, validateWorkerSamples } from "./measurements.mjs";

test("resource proof rejects absent, disabled, failed or non-finite worker telemetry", () => {
	const sample = { enabled: 1, capacity: 2, process_rss_bytes: 100, external_bytes: 0, refused_total: 0, restarts_total: 0 };
	validateWorkerSamples([sample]);
	for (const samples of [
		[],
		[{}],
		[{ ...sample, enabled: 0 }],
		[{ ...sample, error: "metrics unavailable" }],
		[{ ...sample, external_bytes: NaN }],
		[{ ...sample, process_rss_bytes: 0 }],
		[{ ...sample, refused_total: 1 }],
		[{ ...sample, restarts_total: 1 }],
	]) {
		assert.throws(() => validateWorkerSamples(samples));
	}
});

const ingressOptions = { maxRequests: 8, maxBytes: 128 };
const ingressSample = {
	sql_fs_ingress_enabled: 1,
	sql_fs_ingress_active_requests: 8,
	sql_fs_ingress_queued_requests: 8,
	sql_fs_ingress_retained_raw_bytes: 128,
	sql_fs_ingress_refused_total: 0,
	sql_fs_ingress_payload_too_large_total: 0,
	sql_fs_ingress_aborted_total: 0,
	sql_fs_ingress_queue_timeouts_total: 0,
};

test("resource proof accepts bounded aggregate ingress telemetry with waiting requests", () => {
	validateIngressSamples(
		[
			{
				...ingressSample,
				sql_fs_ingress_active_requests: 0,
				sql_fs_ingress_queued_requests: 0,
				sql_fs_ingress_retained_raw_bytes: 0,
			},
			ingressSample,
		],
		ingressOptions,
	);
});

test("resource proof rejects absent ingress samples or missing metrics", () => {
	assert.throws(() => validateIngressSamples([], ingressOptions));
	assert.throws(() => validateIngressSamples([{}], ingressOptions));
	for (const field of Object.keys(ingressSample)) {
		const sample = { ...ingressSample };
		delete sample[field];
		assert.throws(() => validateIngressSamples([sample], ingressOptions), `Missing ${field} must fail`);
	}
});

test("resource proof rejects disabled ingress and sampling failures", () => {
	assert.throws(() => validateIngressSamples([{ ...ingressSample, sql_fs_ingress_enabled: 0 }], ingressOptions));
	assert.throws(() => validateIngressSamples([{ ...ingressSample, error: "metrics unavailable" }], ingressOptions));
});

test("resource proof rejects ingress metrics that are not finite nonnegative integers", () => {
	for (const field of Object.keys(ingressSample).filter((field) => field !== "sql_fs_ingress_enabled")) {
		for (const value of [-1, 0.5, NaN, Infinity, -Infinity, "0", null, Number.MAX_SAFE_INTEGER + 1]) {
			assert.throws(
				() => validateIngressSamples([{ ...ingressSample, [field]: value }], ingressOptions),
				new RegExp(field),
			);
		}
	}
});

test("resource proof rejects ingress gauges above configured aggregate capacity", () => {
	for (const [field, value] of [
		["sql_fs_ingress_active_requests", 9],
		["sql_fs_ingress_queued_requests", 9],
		["sql_fs_ingress_retained_raw_bytes", 129],
	]) {
		assert.throws(() => validateIngressSamples([{ ...ingressSample, [field]: value }], ingressOptions));
	}
});

test("resource proof rejects recorded ingress refusals, payload failures, aborts and queue timeouts", () => {
	for (const field of [
		"sql_fs_ingress_refused_total",
		"sql_fs_ingress_payload_too_large_total",
		"sql_fs_ingress_aborted_total",
		"sql_fs_ingress_queue_timeouts_total",
	]) {
		assert.throws(
			() => validateIngressSamples([ingressSample, { ...ingressSample, [field]: 1 }], ingressOptions),
			new RegExp(field),
		);
	}
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("reports nearest-rank tails without dropping the slowest response", () => {
	assert.equal(distribution([1, 2, 3, 400]).p99Ms, 400);
	assert.equal(distribution([]).p99Ms, null);
});

test("scheduled arrivals continue during slow responses and retain failed probes", async () => {
	let calls = 0;
	const measured = await scheduledProbes(
		async () => {
			const call = calls++;
			await delay(30);
			if (call === 1) throw new Error("probe failure");
			return { status: 200, ms: 30 };
		},
		() => delay(55),
		10,
	);
	assert.ok(calls >= 5, "A closed loop would send fewer than five requests");
	assert.equal(measured.errors.length, 1);
	assert.equal(measured.samples.length, calls);
	assert.ok(measured.samples.every((sample) => sample.latencyMs >= sample.completedMs - sample.sentMs));
});
