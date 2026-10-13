import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDialect } from "../../../sql-fs/dialects/postgres.js";
import { SqlFs } from "../../../sql-fs/sql-fs.js";
import { requireMigratedSchema } from "../../../sql-fs/tests/integration/helpers/schema-preconditions.js";
import { isRetryableError, mapFsErrorToStatus } from "../../errors.js";
import { type RuntimeOptions, SessionManager } from "../../session-manager.js";
import { loadTenantConfig } from "../../tenants.js";
import { loadWorkerPoolOptions } from "../../worker-owner/pool.js";

function checkpoint() {
	let resolve: () => void = () => {};
	const reached = new Promise<void>((done) => {
		resolve = done;
	});
	return { reached, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Runtime quota checkpoint was not reached");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe.skipIf(!process.env.DATABASE_URL)("worker runtime backpressure after a request prefix", () => {
	let manager: SessionManager | undefined;
	const ids: string[] = [];

	beforeAll(async () => {
		await requireMigratedSchema(process.env.DATABASE_URL ?? "");
	});

	beforeEach(() => vi.stubEnv("MAX_PYTHON_QUEUE", "0"));

	afterEach(async () => {
		try {
			for (const id of ids.splice(0)) await manager?.destroy("default", id);
		} finally {
			await manager?.shutdown();
			vi.unstubAllEnvs();
		}
	});

	async function create(owner: SessionManager, runtime: RuntimeOptions): Promise<string> {
		const id = `worker-prefix-${randomUUID()}`;
		ids.push(id);
		await owner.withSession("default", id, async () => {}, runtime);
		return id;
	}

	it.each(["write", "direct-file", "readonly-network"] as const)(
		"never advertises replay after an acknowledged %s prefix",
		async (mode) => {
			const owner = new SessionManager({
				tenantConfig: loadTenantConfig(),
				workerEnabled: true,
				workerOptions: loadWorkerPoolOptions({
					...process.env,
					SQL_FS_WORKER_COUNT: "4",
					SQL_FS_WORKER_ACTIVE_TENANT_MAX: "3",
					SQL_FS_WORKER_HEAP_MB: "256",
					SQL_FS_WORKER_MAX_PG_CONNECTIONS: "8",
					SQL_FS_WORKER_QUEUE_WAIT_MS: "5000",
				}),
				maxConcurrentPython: 1,
				defenseInDepth: true,
				defenseAuditMode: false,
			});
			manager = owner;
			const readonly = mode === "readonly-network";
			const id = await create(owner, { python: true, javascript: false, network: readonly });
			const competitorId = await create(owner, { python: true, javascript: false, network: false });
			const requests: { method?: string; body: string }[] = [];
			const respond = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
				let body = "";
				for await (const chunk of request) body += chunk.toString();
				requests.push({ method: request.method, body });
				response.end("applied");
			};
			const server = createServer((request, response) => {
				void respond(request, response).catch((error: unknown) => {
					response.destroy(error instanceof Error ? error : new Error("HTTP proof handler failed"));
				});
			});
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const address = server.address();
			if (address === null || typeof address === "string") throw new Error("HTTP proof listener has no port");
			const prefixReady = checkpoint();
			const continueRequest = checkpoint();
			const admitted = readonly ? owner.withSessionRead.bind(owner) : owner.withSessionOrRehydrate.bind(owner);
			const operation = admitted("default", id, async (session) => {
				if (mode === "direct-file") {
					await session.fs.appendFile("/home/user/prefix", "applied\n");
				} else {
					const script = readonly
						? `curl -sS -X POST --data applied http://127.0.0.1:${address.port}/effect`
						: "echo applied >> /home/user/prefix";
					expect(await owner.execWithRuntimeThrottle(session, script)).toMatchObject({ exitCode: 0 });
				}
				prefixReady.resolve();
				await continueRequest.reached;
				return owner.execWithRuntimeThrottle(session, "echo suffix");
			});
			const outcome = operation.then(
				(result) => ({ result, error: undefined }),
				(error: unknown) => ({ result: undefined, error }),
			);
			let competitor: Promise<unknown> | undefined;
			try {
				await Promise.race([
					prefixReady.reached,
					outcome.then(({ error }) => {
						if (error !== undefined) throw error;
					}),
				]);
				competitor = owner.withSessionRead("default", competitorId, (session) =>
					owner.execWithRuntimeThrottle(session, "sleep 2; echo competitor"),
				);
				await until(() => owner.getWorkerMetrics()?.pythonActive === 1);
				const beforeDispatch = await owner
					.withSessionRead("default", competitorId, (session) => owner.execWithRuntimeThrottle(session, "echo none"))
					.then(
						() => undefined,
						(error: unknown) => error,
					);
				expect(beforeDispatch).toMatchObject({ code: "ERUNTIME_BUSY" });
				expect(isRetryableError(beforeDispatch)).toBe(true);
				continueRequest.resolve();
				const { error } = await outcome;
				if (!(error instanceof Error)) throw new Error("Expected a coded request failure after the prefix");
				console.log(
					JSON.stringify({
						case: "runtime-busy-after-prefix",
						mode,
						code: (error as { code?: string }).code,
						retryable: isRetryableError(error),
						externalPosts: requests.length,
					}),
				);
				expect(error).toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN" });
				expect(isRetryableError(error)).toBe(false);
				expect(mapFsErrorToStatus(error)).toBe(503);
				expect(await competitor).toMatchObject({ exitCode: 0, stdout: "competitor\n" });
				const dialect = new PostgresDialect(process.env.DATABASE_URL ?? "");
				await dialect.connect();
				try {
					const fresh = new SqlFs({ dialect, sandboxId: id, contentCacheMaxBytes: 1 });
					await fresh.ready();
					if (readonly) {
						expect(requests).toEqual([{ method: "POST", body: "applied" }]);
						expect(await fresh.exists("/home/user/prefix")).toBe(false);
					} else {
						expect(await fresh.readFile("/home/user/prefix")).toBe("applied\n");
						expect(requests).toEqual([]);
					}
				} finally {
					await dialect.disconnect();
				}
				expect(
					await owner.withSessionRead("default", id, (session) =>
						owner.execWithRuntimeThrottle(session, "echo healthy"),
					),
				).toMatchObject({ exitCode: 0, stdout: "healthy\n" });
				expect(owner.getWorkerMetrics()).toMatchObject({
					restarts: 0,
					unknownOutcomes: 0,
					pythonActive: 0,
					pythonQueued: 0,
				});
			} finally {
				continueRequest.resolve();
				await outcome;
				await competitor;
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		},
		15000,
	);
});
