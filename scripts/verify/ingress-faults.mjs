import { isMainThread } from "node:worker_threads";

if (isMainThread && process.env.INGRESS_VERIFY_DELETE_ID && process.env.INGRESS_VERIFY_BARRIER) {
	const { SessionManager } = await import("../../dist/api/session-manager.js");
	const destroy = SessionManager.prototype.destroy;
	SessionManager.prototype.destroy = async function (tenant, id) {
		const found = await destroy.call(this, tenant, id);
		if (id === process.env.INGRESS_VERIFY_DELETE_ID) {
			const response = await fetch(`${process.env.INGRESS_VERIFY_BARRIER}/${id}`, {
				signal: AbortSignal.timeout(10000),
			});
			if (response.status !== 204) throw new Error("Ingress delete barrier failed");
		}
		return found;
	};
}
