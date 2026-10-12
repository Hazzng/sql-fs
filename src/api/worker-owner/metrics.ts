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

export function renderWorkerMetrics(snapshot: Snapshot | undefined, ingress?: IngressAdmission["metrics"]): string {
	const lines = ["# TYPE sql_fs_workers_enabled gauge", `sql_fs_workers_enabled ${snapshot === undefined ? 0 : 1}`];
	if (snapshot !== undefined) {
		for (const [suffix, type, field] of fields) {
			const name = `sql_fs_worker_${suffix}`;
			lines.push(`# TYPE ${name} ${type}`, `${name} ${snapshot[field]}`);
		}
		const histogram = "sql_fs_worker_queue_wait_milliseconds";
		lines.push(`# TYPE ${histogram} histogram`);
		for (const bucket of snapshot.waitBuckets) {
			lines.push(`${histogram}_bucket{le="${bucket.upperMs}"} ${bucket.count}`);
		}
		lines.push(
			`${histogram}_bucket{le="+Inf"} ${snapshot.admitted}`,
			`${histogram}_sum ${snapshot.totalWaitMs}`,
			`${histogram}_count ${snapshot.admitted}`,
		);
	}
	lines.push("# TYPE sql_fs_ingress_enabled gauge", `sql_fs_ingress_enabled ${ingress === undefined ? 0 : 1}`);
	if (ingress !== undefined) {
		const ingressFields = [
			["active_requests", "gauge", "activeRequests"],
			["queued_requests", "gauge", "queuedRequests"],
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
	}
	return `${lines.join("\n")}\n`;
}
