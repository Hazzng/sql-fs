import { AsyncLocalStorage } from "node:async_hooks";
import { request as hostRequest } from "node:http";
import { isMainThread, threadId, workerData } from "node:worker_threads";

const prefix = process.env.INPUT_VERIFY_PREFIX;
if (!isMainThread && workerData?.runtime?.endsWith("/api/worker-owner/runtime.js") && prefix) {
	const [{ SqlFs }, { execContext }] = await Promise.all([
		import("../../dist/sql-fs/sql-fs.js"),
		import("../../dist/api/exec-context.js"),
	]);
	const delegated = new AsyncLocalStorage();
	const contextIds = new WeakMap();
	let nextContextId = 0;
	for (const method of ["readFile", "readFileBuffer", "readFileBytes"]) {
		const original = SqlFs.prototype[method];
		SqlFs.prototype[method] = async function (path, ...options) {
			const marker = typeof path === "string" && path.startsWith(prefix) ? path.slice(prefix.length) : "";
			const match = marker.match(/^(\d{1,5})-(rejected|healthy)$/);
			if (!match) return original.call(this, path, ...options);
			const existing = delegated.getStore()?.get(path);
			if (existing) {
				existing.readCalls++;
				return original.call(this, path, ...options);
			}
			const port = Number(match[1]);
			if (port < 1 || port > 65535) throw new Error("Invalid input verification barrier port");
			const checkpoint = { readCalls: 0 };
			return delegated.run(new Map([...(delegated.getStore() ?? []), [path, checkpoint]]), async () => {
				checkpoint.readCalls++;
				const value = await original.call(this, path, ...options);
				const bytes = typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
				const context = execContext.getStore();
				if (bytes !== 0 || context?.inputLimitBytes === undefined) {
					throw new Error("Input verification requires an empty marker read inside an exec input context");
				}
				if (!contextIds.has(context)) contextIds.set(context, ++nextContextId);
				await new Promise((resolve, reject) => {
					const request = hostRequest({
						host: "127.0.0.1",
						port,
						path: `/${match[2]}`,
						agent: false,
						headers: {
							"X-Input-Verify-Thread": String(threadId),
							"X-Input-Verify-Context": String(contextIds.get(context)),
							"X-Input-Verify-Read-Calls": String(checkpoint.readCalls),
							"X-Input-Verify-Bytes": String(context.inputBytes ?? 0),
							"X-Input-Verify-Limit": String(context.inputLimitBytes),
							"X-Input-Verify-Sandbox": context.sandboxId,
						},
					}, (response) => {
						response.on("error", reject);
						response.on("end", () => {
							if (response.statusCode !== 200) reject(new Error("Input verification barrier rejected its marker read"));
							else resolve();
						});
						response.resume();
					});
					request.setTimeout(15000, () => request.destroy(new Error("Input verification barrier timed out")));
					request.on("error", reject);
					request.end();
				});
				return value;
			});
		};
	}
}
