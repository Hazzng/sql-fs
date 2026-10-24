import type { IngressAdmission } from "../ingress-admission.js";
import type { SessionManager } from "../session-manager.js";

type Snapshot = NonNullable<ReturnType<SessionManager["getWorkerMetrics"]>>;

const fields = [
	["capacity", "gauge", "workers"],
	["ready", "gauge", "readyWorkers"],
	["busy", "gauge", "busyWorkers"],
	["resident_sessions", "gauge", "residentSessions"],
	["queued", "gauge", "queued"],
	["queued_bytes", "gauge", "queuedBytes"],
	["runnable_queued", "gauge", "runnableQueued"],
	["sandbox_waiting", "gauge", "sandboxWaiting"],
	["lock_waiting", "gauge", "lockWaiting"],
	["running_operations", "gauge", "runningOperations"],
	["recovering_operations", "gauge", "recoveringOperations"],
	["external_bytes", "gauge", "externalBytes"],
	["process_rss_bytes", "gauge", "rssBytes"],
	["python_active", "gauge", "pythonActive"],
	["python_queued", "gauge", "pythonQueued"],
	["javascript_active", "gauge", "javascriptActive"],
	["javascript_queued", "gauge", "javascriptQueued"],
	["offered_total", "counter", "offered"],
	["admitted_total", "counter", "admitted"],
	["refused_total", "counter", "refused"],
	["cancelled_total", "counter", "cancelled"],
	["queue_timeouts_total", "counter", "timedOut"],
	["completed_total", "counter", "completed"],
	["restarts_total", "counter", "restarts"],
	["unknown_outcomes_total", "counter", "unknownOutcomes"],
	["queue_wait_milliseconds_total", "counter", "totalWaitMs"],
] as const satisfies ReadonlyArray<readonly [string, "gauge" | "counter", keyof Snapshot]>;

function waitHistogram(name: string, snapshot: Pick<Snapshot, "waitBuckets" | "admitted" | "totalWaitMs">): string[] {
	return [
		`# TYPE ${name} histogram`,
		...snapshot.waitBuckets.map((bucket) => `${name}_bucket{le="${bucket.upperMs}"} ${bucket.count}`),
		`${name}_bucket{le="+Inf"} ${snapshot.admitted}`,
		`${name}_sum ${snapshot.totalWaitMs}`,
		`${name}_count ${snapshot.admitted}`,
	];
}

export function renderWorkerMetrics(snapshot: Snapshot | undefined, ingress?: IngressAdmission["metrics"]): string {
	const lines = ["# TYPE sql_fs_workers_enabled gauge", `sql_fs_workers_enabled ${snapshot === undefined ? 0 : 1}`];
	if (snapshot !== undefined) {
		for (const [suffix, type, field] of fields) {
			const name = `sql_fs_worker_${suffix}`;
			lines.push(`# TYPE ${name} ${type}`, `${name} ${snapshot[field]}`);
		}
		lines.push(...waitHistogram("sql_fs_worker_queue_wait_milliseconds", snapshot));
	}
	lines.push("# TYPE sql_fs_ingress_enabled gauge", `sql_fs_ingress_enabled ${ingress === undefined ? 0 : 1}`);
	if (ingress !== undefined) {
		const ingressFields = [
			["request_capacity", "gauge", "requestCapacity"],
			["queue_capacity", "gauge", "queueCapacity"],
			["raw_byte_capacity", "gauge", "rawByteCapacity"],
			["queue_wait_limit_milliseconds", "gauge", "queueWaitLimitMs"],
			["active_requests", "gauge", "activeRequests"],
			["queued_requests", "gauge", "queuedRequests"],
			["offered_total", "counter", "offered"],
			["admitted_total", "counter", "admitted"],
			["completed_total", "counter", "completed"],
			["cancelled_total", "counter", "cancelled"],
			["queue_timeouts_total", "counter", "queueTimeouts"],
			["mcp_listeners_active", "gauge", "activeMcpListeners"],
			["mcp_listeners_queued", "gauge", "queuedMcpListeners"],
			["mcp_listeners_queue_timeouts_total", "counter", "mcpListenerQueueTimeouts"],
			["mcp_listeners_refused_total", "counter", "mcpListenerRefused"],
			["retained_raw_bytes", "gauge", "retainedRawBytes"],
			["refused_total", "counter", "refused"],
			["payload_too_large_total", "counter", "payloadTooLarge"],
			["aborted_total", "counter", "aborted"],
		] as const;
		for (const [suffix, type, field] of ingressFields) {
			const name = `sql_fs_ingress_${suffix}`;
			lines.push(`# TYPE ${name} ${type}`, `${name} ${ingress[field]}`);
		}
		lines.push(...waitHistogram("sql_fs_ingress_queue_wait_milliseconds", ingress));
	}
	return `${lines.join("\n")}\n`;
}
