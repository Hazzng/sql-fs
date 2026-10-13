import { parentPort, workerData } from "node:worker_threads";
import type { IFileSystem } from "just-bash";
import { ownerCancellation } from "../../execution/owner-cancellation.js";
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
import { budgetWorkerReply } from "./message-budget.js";
import type { WorkerPoolOptions } from "./pool.js";
import {
	OutcomeUnknownError,
	type OwnerCommand,
	type OwnerCommandKind,
	type OwnerHandlers,
	type OwnerMetadata,
	type OwnerReply,
	type OwnerRequest,
	type OwnerResult,
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

async function shutdownOwner(): Promise<void> {
	try {
		if (resident !== undefined) await closeSessionRuntime(resident.runtime);
	} finally {
		resident = undefined;
		await closeRedisClient();
	}
	return;
}

async function attachOwner(command: OwnerCommand<"attach">, request: OwnerRequest): Promise<void> {
	if (resident !== undefined) throw new Error("worker already has a resident filesystem");
	const { identity } = command;
	const options: WorkerPoolOptions = workerData.options;
	const dataRedis = process.env.REDIS_BLOB_CACHE_ENABLED !== "false" ? getRedisClient("data") : undefined;
	const blobCache =
		dataRedis === undefined ? undefined : new RedisBlobCache(dataRedis, identity.tenantId, loadRedisBlobCacheOptions());
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

function residentFor(request: OwnerRequest): Resident {
	if (resident === undefined || resident.generation !== request.generation) {
		throw Object.assign(new Error("ESTALE: worker generation has retired"), { code: "ESTALE" });
	}
	return resident;
}

function assertLease(request: OwnerRequest): void {
	if (Atomics.load(new Int32Array(request.cancellation), 1) !== 0) {
		throw new LockLostError("worker owner lease lost");
	}
}

const handlers: OwnerHandlers = {
	shutdown: shutdownOwner,
	attach: attachOwner,
	exec: async (command, request, signal) => {
		return executeSessionRuntime(residentFor(request).runtime, command.script, { ...command.options, signal });
	},
	paths: async (_command, request) => residentFor(request).runtime.fs.getAllPaths(),
	reload: async (_command, request) => (residentFor(request).runtime.fs as ICoherentFs).reload(),
	fresh: async (_command, request) => {
		const coherent = residentFor(request).runtime.fs as ICoherentFs;
		const claimed = (await coherent.claimGeneration?.()) === true;
		return (await coherent.ensureFresh()) || claimed;
	},
	runtime: async (command, request) => {
		const current = residentFor(request);
		const { fs, tenantId, sandboxId, cwd } = current.runtime;
		const next = createSessionRuntime(
			fs,
			{ tenantId, sandboxId, runtimeOptions: command.runtimeOptions },
			workerData.options,
		);
		next.cwd = cwd;
		resident = { ...current, runtime: next };
	},
	clearDirty: async (_command, request) => (residentFor(request).runtime.fs as ICoherentFs).clearDirty(),
	bulkIngest: async (command, request) => {
		const coherent = residentFor(request).runtime.fs as ICoherentFs;
		assertLease(request);
		return coherent.bulkIngest(command.files);
	},
	beginScope: async (_command, request) => {
		await residentFor(request).runtime.scriptTx?.beginScope();
	},
	endScope: async (_command, request) => {
		const { runtime } = residentFor(request);
		try {
			assertLease(request);
			return await runtime.scriptTx?.endScope();
		} catch (error) {
			try {
				await runtime.scriptTx?.abortScope();
			} catch {}
			throw error;
		}
	},
	abortScope: async (_command, request) => residentFor(request).runtime.scriptTx?.abortScope(),
	disconnect: async (_command, request) => {
		await closeSessionRuntime(residentFor(request).runtime);
		resident = undefined;
	},
	readFile: async (command, request) => residentFor(request).runtime.fs.readFile(...command.args),
	readFileBuffer: async (command, request) => residentFor(request).runtime.fs.readFileBuffer(...command.args),
	readFileBytes: async (command, request) => {
		const { fs } = residentFor(request).runtime;
		if (fs.readFileBytes === undefined) throw new Error("worker filesystem lacks byte reads");
		return fs.readFileBytes(...command.args);
	},
	writeFile: async (command, request) => {
		const { fs } = residentFor(request).runtime;
		assertLease(request);
		return fs.writeFile(...command.args);
	},
	appendFile: async (command, request) => {
		const { fs } = residentFor(request).runtime;
		assertLease(request);
		return fs.appendFile(...command.args);
	},
	exists: async (command, request) => residentFor(request).runtime.fs.exists(...command.args),
	stat: async (command, request) => residentFor(request).runtime.fs.stat(...command.args),
	mkdir: async (command, request) => {
		const { fs } = residentFor(request).runtime;
		assertLease(request);
		return fs.mkdir(...command.args);
	},
	createExclusive: async (command, request) => {
		const { fs } = residentFor(request).runtime;
		assertLease(request);
		if (fs.createExclusive === undefined) throw new Error("worker filesystem lacks exclusive creation");
		return fs.createExclusive(...command.args);
	},
	readdir: async (command, request) => residentFor(request).runtime.fs.readdir(...command.args),
	readdirWithFileTypes: async (command, request) => {
		const { fs } = residentFor(request).runtime;
		if (fs.readdirWithFileTypes === undefined) throw new Error("worker filesystem lacks typed directory reads");
		return fs.readdirWithFileTypes(...command.args);
	},
	rm: async (command, request) => {
		const { fs } = residentFor(request).runtime;
		assertLease(request);
		return fs.rm(...command.args);
	},
	cp: async (command, request) => {
		const { fs } = residentFor(request).runtime;
		assertLease(request);
		return fs.cp(...command.args);
	},
	mv: async (command, request) => {
		const { fs } = residentFor(request).runtime;
		assertLease(request);
		return fs.mv(...command.args);
	},
	chmod: async (command, request) => {
		const { fs } = residentFor(request).runtime;
		assertLease(request);
		return fs.chmod(...command.args);
	},
	symlink: async (command, request) => {
		const { fs } = residentFor(request).runtime;
		assertLease(request);
		return fs.symlink(...command.args);
	},
	link: async (command, request) => {
		const { fs } = residentFor(request).runtime;
		assertLease(request);
		return fs.link(...command.args);
	},
	readlink: async (command, request) => residentFor(request).runtime.fs.readlink(...command.args),
	lstat: async (command, request) => residentFor(request).runtime.fs.lstat(...command.args),
	realpath: async (command, request) => residentFor(request).runtime.fs.realpath(...command.args),
	utimes: async (command, request) => {
		const { fs } = residentFor(request).runtime;
		assertLease(request);
		return fs.utimes(...command.args);
	},
};

async function dispatch<K extends OwnerCommandKind>(
	command: OwnerCommand<K>,
	request: OwnerRequest,
	signal: AbortSignal,
): Promise<OwnerResult<K>> {
	return handlers[command.kind](command, request, signal);
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
