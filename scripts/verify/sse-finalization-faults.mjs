import { existsSync } from "node:fs";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";

const marker = process.env.SSE_FINALIZATION_MARKER;
if (isMainThread && marker) {
	const { SessionManager } = await import("../../dist/api/session-manager.js");
	const { sessionLeaseSignal } = await import("../../dist/api/session-lease-context.js");
	const { WorkerFileSystem } = await import("../../dist/api/worker-owner/filesystem.js");
	const armed = new WeakMap();
	const initialize = SessionManager.prototype.initializeWorkers;
	SessionManager.prototype.initializeWorkers = function (...args) {
		this.execLockOptions = { ...this.execLockOptions, leaseMs: 2000, readerLeaseMs: 2000, renewMs: 100 };
		return initialize.apply(this, args);
	};
	const execute = SessionManager.prototype.execWithRuntimeThrottle;
	SessionManager.prototype.execWithRuntimeThrottle = async function (session, script, options) {
		const result = await execute.call(this, session, script, options);
		if (!session.owner.startsWith(`${marker}-`)) return result;
		const mode = script.includes(`${marker}:reject`) ? "reject" : script.includes(`${marker}:hold`) ? "hold" : undefined;
		if (mode === undefined) return result;
		armed.set(session.fs, { mode, id: session.sandboxId, tenant: session.tenantId, manager: this });
		const signal = sessionLeaseSignal();
		if (mode === "hold") {
			signal?.addEventListener(
				"abort",
				() => console.log(JSON.stringify({ event: "sse_finalization_lease_lost", id: session.sandboxId })),
				{ once: true },
			);
		}
		return result;
	};
	const clearDirty = WorkerFileSystem.prototype.clearDirty;
	WorkerFileSystem.prototype.clearDirty = async function (...args) {
		const fault = armed.get(this);
		if (fault === undefined) return clearDirty.apply(this, args);
		armed.delete(this);
		const result = fault.mode === "hold" ? await clearDirty.apply(this, args) : undefined;
		console.log(JSON.stringify({ event: "sse_finalization_clear_dirty_held", id: fault.id, mode: fault.mode }));
		const released = join(process.env.SSE_FINALIZATION_GATES, fault.id);
		const deadline = Date.now() + 10000;
		while (!existsSync(released)) {
			if (Date.now() >= deadline) throw new Error("SSE finalization release checkpoint timed out");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		if (fault.mode === "reject") {
			await fault.manager.crashWorkerForTest(fault.tenant, fault.id);
			console.log(JSON.stringify({ event: "sse_finalization_owner_terminated", id: fault.id }));
			return clearDirty.apply(this, args);
		}
		console.log(JSON.stringify({ event: "sse_finalization_clear_dirty_released", id: fault.id }));
		return result;
	};
}
