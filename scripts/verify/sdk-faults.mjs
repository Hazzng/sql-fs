import { isMainThread } from "node:worker_threads";

const marker = process.env.SDK_VERIFY_MARKER;
if (isMainThread && marker) {
	const { SessionManager } = await import("../../dist/api/session-manager.js");
	const execute = SessionManager.prototype.execWithRuntimeThrottle;
	const crashed = new Set();
	SessionManager.prototype.execWithRuntimeThrottle = async function (session, script, options) {
		const operation = execute.call(this, session, script, options);
		if (!session.owner.startsWith(`${marker}-`)) return operation;
		if (script.includes(`${marker}:hold`)) {
			console.log(JSON.stringify({ event: "sdk_verify_hold_dispatched", sandboxId: session.sandboxId }));
		}
		if (!script.includes(`${marker}:crash`) || crashed.has(session.sandboxId)) return operation;
		crashed.add(session.sandboxId);
		const crash = new Promise((resolve, reject) => {
			setTimeout(() => {
				this.crashWorkerForTest(session.tenantId, session.sandboxId).then(resolve, reject);
			}, 150);
		});
		try {
			return await operation;
		} finally {
			await crash;
			console.log(JSON.stringify({ event: "sdk_verify_worker_terminated", sandboxId: session.sandboxId }));
		}
	};
}
