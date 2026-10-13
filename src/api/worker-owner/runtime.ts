import { parentPort, workerData } from "node:worker_threads";
import type { IFileSystem } from "just-bash";
import { loadRedisBlobCacheOptions } from "../../redis/blob-cache-options.js";
import { closeRedisClient, getRedisClient } from "../../redis/client.js";
import { createPostgresSandboxFs } from "../../sql-fs/index.js";
import { RedisBlobCache } from "../../sql-fs/redis-blob-cache.js";
import type { ICoherentFs } from "../../sql-fs/sql-fs.js";
import { LockLostError } from "../distributed-lock.js";
import { readOnlyContext } from "../read-only-context.js";
import {
	type SessionRuntime,
	closeSessionRuntime,
	createSessionRuntime,
	executeSessionRuntime,
} from "../session-runtime/engine.js";
import { ownerCancellation } from "./cancellation.js";
import { budgetWorkerReply } from "./message-budget.js";
import type { WorkerPoolOptions } from "./pool.js";
import {
	OutcomeUnknownError,
	type OwnerCommand,
	type OwnerMetadata,
	type OwnerReply,
	type OwnerRequest,
} from "./protocol.js";

const port = parentPort;
if (port === null) throw new Error("worker owner requires a parent port");

type Resident = {
	readonly generation: number;
	readonly runtime: SessionRuntime;
	readonly owner: string;
	readonly createdAt: string;
};
let resident: Resident | undefined;

function metadata(): OwnerMetadata | undefined {
	if (resident === undefined) return undefined;
	const { runtime } = resident;
	const fs = runtime.fs as ICoherentFs & { getPathCacheBytes(): number };
	return {
		owner: resident.owner,
		createdAt: resident.createdAt,
		cwd: runtime.cwd,
		dirty: fs.wasDirty(),
		poisoned: fs.poisoned(),
		pathCacheBytes: fs.getPathCacheBytes(),
	};
}

async function dispatch(command: OwnerCommand, request: OwnerRequest, signal: AbortSignal): Promise<unknown> {
	if (command.kind === "shutdown") {
		try {
			if (resident !== undefined) await closeSessionRuntime(resident.runtime);
		} finally {
			resident = undefined;
			await closeRedisClient();
		}
		return;
	}
	if (command.kind === "attach") {
		if (resident !== undefined) throw new Error("worker already has a resident filesystem");
		const { identity } = command;
		const options: WorkerPoolOptions = workerData.options;
		const dataRedis = process.env.REDIS_BLOB_CACHE_ENABLED !== "false" ? getRedisClient("data") : undefined;
		const blobCache =
			dataRedis === undefined
				? undefined
				: new RedisBlobCache(dataRedis, identity.tenantId, loadRedisBlobCacheOptions());
		const { fs, resolvedOwner, createdAt } = await createPostgresSandboxFs(
			{
				connectionString: identity.connectionString,
				tenantId: identity.tenantId,
				poolMax: options.pgPoolMax,
				scriptTxBuffer: options.scriptTxBuffer,
				blobCache,
				openExisting: identity.openExisting,
			},
			identity.sandboxId,
			identity.owner,
		);
		try {
			const runtime = createSessionRuntime(fs, identity, options);
			runtime.cwd = identity.cwd;
			resident = { generation: request.generation, runtime, owner: resolvedOwner, createdAt };
		} catch (error) {
			await (fs as IFileSystem & { disconnect(): Promise<void> }).disconnect();
			throw error;
		}
		return;
	}
	if (resident === undefined || resident.generation !== request.generation) {
		throw Object.assign(new Error("ESTALE: worker generation has retired"), { code: "ESTALE" });
	}
	const { runtime } = resident;
	const fs = runtime.fs;
	const coherent = fs as ICoherentFs;
	const words = new Int32Array(request.cancellation);
	const assertLease = (): void => {
		if (Atomics.load(words, 1) !== 0) throw new LockLostError("worker owner lease lost");
	};
	switch (command.kind) {
		case "exec":
			return executeSessionRuntime(runtime, command.script, { ...command.options, signal });
		case "paths":
			return fs.getAllPaths();
		case "reload":
			return coherent.reload();
		case "fresh": {
			const claimed = (await coherent.claimGeneration?.()) === true;
			return (await coherent.ensureFresh()) || claimed;
		}
		case "runtime": {
			const { tenantId, sandboxId, cwd } = runtime;
			const next = createSessionRuntime(
				fs,
				{ tenantId, sandboxId, runtimeOptions: command.runtimeOptions },
				workerData.options,
			);
			next.cwd = cwd;
			resident = { ...resident, runtime: next };
			return;
		}
		case "clearDirty":
			return coherent.clearDirty();
		case "bulkIngest":
			assertLease();
			return coherent.bulkIngest(command.files);
		case "beginScope":
			runtime.scriptTx?.beginScope();
			return;
		case "endScope": {
			try {
				assertLease();
				return await runtime.scriptTx?.endScope();
			} catch (error) {
				await runtime.scriptTx?.abortScope();
				throw error;
			}
		}
		case "abortScope":
			return runtime.scriptTx?.abortScope();
		case "disconnect":
			await closeSessionRuntime(runtime);
			resident = undefined;
			return;
		case "readFile":
			return fs.readFile(...command.args);
		case "readFileBuffer":
			return fs.readFileBuffer(...command.args);
		case "readFileBytes": {
			if (fs.readFileBytes === undefined) throw new Error("worker filesystem lacks byte reads");
			return fs.readFileBytes(...command.args);
		}
		case "writeFile":
			assertLease();
			return fs.writeFile(...command.args);
		case "appendFile":
			assertLease();
			return fs.appendFile(...command.args);
		case "exists":
			return fs.exists(...command.args);
		case "stat":
			return fs.stat(...command.args);
		case "mkdir":
			assertLease();
			return fs.mkdir(...command.args);
		case "createExclusive": {
			assertLease();
			if (fs.createExclusive === undefined) throw new Error("worker filesystem lacks exclusive creation");
			return fs.createExclusive(...command.args);
		}
		case "readdir":
			return fs.readdir(...command.args);
		case "readdirWithFileTypes": {
			if (fs.readdirWithFileTypes === undefined) throw new Error("worker filesystem lacks typed directory reads");
			return fs.readdirWithFileTypes(...command.args);
		}
		case "rm":
			assertLease();
			return fs.rm(...command.args);
		case "cp":
			assertLease();
			return fs.cp(...command.args);
		case "mv":
			assertLease();
			return fs.mv(...command.args);
		case "chmod":
			assertLease();
			return fs.chmod(...command.args);
		case "symlink":
			assertLease();
			return fs.symlink(...command.args);
		case "link":
			assertLease();
			return fs.link(...command.args);
		case "readlink":
			return fs.readlink(...command.args);
		case "lstat":
			return fs.lstat(...command.args);
		case "realpath":
			return fs.realpath(...command.args);
		case "utimes":
			assertLease();
			return fs.utimes(...command.args);
	}
}

port.on("message", (request: OwnerRequest) => {
	void (async () => {
		const controller = new AbortController();
		const words = new Int32Array(request.cancellation);
		const checkAbort = (): void => {
			if (Atomics.load(words, 0) !== 0) controller.abort();
		};
		checkAbort();
		const timer = setInterval(checkAbort, 10);
		const ctx = request.readOnly ? { violated: false } : undefined;
		const scopedFs = resident?.runtime.fs as
			| (IFileSystem & { beginReadOnlyScope(): void; endReadOnlyScope(): void })
			| undefined;
		if (ctx !== undefined) scopedFs?.beginReadOnlyScope();
		let outcome: { ok: true; value: unknown } | { ok: false; error: { name: string; message: string; code?: string } };
		try {
			const run = () => ownerCancellation.run(words, () => dispatch(request.command, request, controller.signal));
			const value = ctx === undefined ? await run() : await readOnlyContext.run(ctx, run);
			outcome = { ok: true, value };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			const code = (err as Error & { code?: string }).code;
			const failure =
				request.command.kind === "exec" && (code === "EDRIVERFAULT" || /^08[0-9A-Z]{3}$/.test(code ?? ""))
					? new OutcomeUnknownError()
					: err;
			outcome = {
				ok: false,
				error: { name: failure.name, message: failure.message, code: (failure as Error & { code?: string }).code },
			};
		} finally {
			clearInterval(timer);
			if (ctx !== undefined) scopedFs?.endReadOnlyScope();
		}
		const memory = process.memoryUsage();
		let reply: OwnerReply = {
			id: request.id,
			generation: request.generation,
			metadata: metadata(),
			readOnlyViolated: ctx?.violated ?? false,
			memory: { heapUsed: memory.heapUsed, external: memory.external, rss: memory.rss },
			...outcome,
		};
		try {
			reply = budgetWorkerReply(reply, request.command, workerData.options.executionLimits.maxWorkerMessageBytes);
		} catch {
			process.exit(1);
		}
		port.postMessage(reply);
		if (resident !== undefined && reply.metadata === undefined) process.exit(1);
		if (request.command.kind === "shutdown") port.close();
	})();
});

port.postMessage({ kind: "ready" });
