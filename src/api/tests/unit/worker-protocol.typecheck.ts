import type { BashExecResult } from "just-bash";
import type { WorkerFileSystem } from "../../worker-owner/filesystem.js";
import type { WorkerOwnerPool } from "../../worker-owner/pool.js";
import type { OwnerEffectPolicy, OwnerHandlers } from "../../worker-owner/protocol.js";

export function checkWorkerProtocolTypes(
	pool: WorkerOwnerPool,
	fs: WorkerFileSystem,
	handlers: OwnerHandlers,
	policy: OwnerEffectPolicy,
): void {
	const paths: Promise<string[]> = pool.send({ kind: "paths" });
	const fresh: Promise<boolean> = fs.call({ kind: "fresh" });
	const exec: Promise<BashExecResult> = pool.send({ kind: "exec", script: "true", options: {} });
	const write: Promise<void> = fs.call({ kind: "writeFile", args: ["/file", "bytes"] });
	// @ts-expect-error The command determines the reply type.
	const wrongReply: Promise<number> = pool.send({ kind: "readFile", args: ["/file"] });
	// @ts-expect-error Callers cannot select a result type.
	void pool.send<BashExecResult>({ kind: "exec", script: "true", options: {} });
	// @ts-expect-error Synchronous filesystem methods are not protocol commands.
	void fs.call({ kind: "getAllPaths" });
	// @ts-expect-error A handler must return the declared result for its command.
	const wrongHandler: OwnerHandlers["readFile"] = async () => 123;
	const { paths: pathsHandler, ...remainingHandlers } = handlers;
	// @ts-expect-error Every supported command requires a handler.
	const missingHandler: OwnerHandlers = remainingHandlers;
	const { paths: pathsPolicy, ...remainingPolicy } = policy;
	// @ts-expect-error Every supported command requires an effect policy.
	const missingPolicy: OwnerEffectPolicy = remainingPolicy;
	void [paths, fresh, exec, write, wrongReply, wrongHandler, pathsHandler, missingHandler, pathsPolicy, missingPolicy];
}
