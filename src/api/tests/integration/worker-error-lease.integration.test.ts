import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Worker } from "node:worker_threads";
import { Hono } from "hono";
import { Redis } from "ioredis";
import { SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresDialect } from "../../../sql-fs/dialects/postgres.js";
import { SqlFs } from "../../../sql-fs/sql-fs.js";
import { requireMigratedSchema } from "../../../sql-fs/tests/integration/helpers/schema-preconditions.js";
import { type AuthVariables, createAuthMiddleware } from "../../auth.js";
import { execLockKey } from "../../distributed-lock.js";
import { rwLockKeys } from "../../distributed-rw-lock.js";
import { apiErrorHandler } from "../../errors.js";
import { execRoutes } from "../../routes/exec.js";
import { sessionLeaseSignal } from "../../session-lease-context.js";
import { SessionManager } from "../../session-manager.js";
import { loadTenantConfig } from "../../tenants.js";
import { loadWorkerPoolOptions } from "../../worker-owner/pool.js";
import type { OwnerEvent, OwnerRequest } from "../../worker-owner/protocol.js";

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
		if (Date.now() >= deadline) throw new Error("Worker lease checkpoint was not reached");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe.skipIf(!process.env.DATABASE_URL || !process.env.REDIS_URL)(
	"worker errors after definitive lease loss",
	() => {
		let manager: SessionManager | undefined;
		let redis: Redis | undefined;
		let id: string | undefined;

		beforeAll(async () => {
			await requireMigratedSchema(process.env.DATABASE_URL ?? "");
		});

		afterEach(async () => {
			vi.restoreAllMocks();
			try {
				if (id !== undefined) await manager?.destroy("default", id);
			} finally {
				await manager?.shutdown();
				await redis?.quit();
				vi.unstubAllEnvs();
			}
		});

		it("retires each replacement generation once within a nested admitted request", async () => {
			const workers = new Set<Worker>();
			const originalOn = Worker.prototype.on;
			vi.spyOn(Worker.prototype, "on").mockImplementation(function (this: Worker, event, listener) {
				workers.add(this);
				return originalOn.call(this, event, listener);
			});
			const started = checkpoint();
			const originalPost = Worker.prototype.postMessage;
			vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, message, transferList) {
				originalPost.call(this, message, transferList);
				const request = message as OwnerRequest;
				if (request.command?.kind === "exec" && request.command.script === "sleep 30") started.resolve();
			});
			const owner = new SessionManager({
				tenantConfig: loadTenantConfig(),
				workerEnabled: true,
				workerOptions: { ...loadWorkerPoolOptions(), count: 1 },
			});
			manager = owner;
			const sandboxId = `worker-nested-generation-${randomUUID()}`;
			id = sandboxId;
			await owner.withSession("default", sandboxId, async () => {});
			await expect(
				owner.withSessionRead("default", sandboxId, async () => {
					const first = owner.withSessionRead("default", sandboxId, (session) =>
						owner.execWithRuntimeThrottle(session, "sleep 30"),
					);
					const failed = expect(first).rejects.toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN" });
					await started.reached;
					await owner.crashWorkerForTest("default", sandboxId);
					await failed;
					expect([...workers].every((worker) => worker.threadId === -1)).toBe(true);
					return owner.withSessionRead("default", sandboxId, async (session) => {
						expect(await owner.execWithRuntimeThrottle(session, "echo replacement")).toMatchObject({
							stdout: "replacement\n",
						});
						throw Object.assign(new Error("replacement lease lost"), { code: "ELOCKLOST" });
					});
				}),
			).rejects.toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN" });
			expect(workers.size).toBe(2);
			expect([...workers].every((worker) => worker.threadId === -1)).toBe(true);
			expect(owner.getWorkerMetrics()?.unknownOutcomes).toBe(2);
			await owner.withSessionRead("default", sandboxId, async (session) => {
				expect((await owner.execWithRuntimeThrottle(session, "echo healthy")).stdout).toBe("healthy\n");
			});
		});

		it.each([
			{ mode: "shared", readOnly: true, rwlockEnabled: true },
			{ mode: "exclusive", readOnly: false, rwlockEnabled: true },
			{ mode: "legacy", readOnly: true, rwlockEnabled: false },
		])("never advertises replay of an external POST after a held input error ($mode)", async (policy) => {
			const held = checkpoint();
			let armed = false;
			let releaseReply: () => void = () => {};
			const originalOn = Worker.prototype.on;
			vi.spyOn(Worker.prototype, "on").mockImplementation(function (this: Worker, event, listener) {
				if (event !== "message") return originalOn.call(this, event, listener);
				return originalOn.call(this, event, (reply: OwnerEvent) => {
					if (armed && "error" in reply && reply.error.code === "EEXEC_INPUT_LIMIT") {
						armed = false;
						releaseReply = () => listener(reply);
						held.resolve();
						return;
					}
					listener(reply);
				});
			});
			const authSecret = "worker-lease-proof-secret-at-least-32-bytes";
			vi.stubEnv("AUTH_SECRET", authSecret);
			const tenantConfig = loadTenantConfig();
			const connection = new Redis(process.env.REDIS_URL ?? "");
			redis = connection;
			const owner = new SessionManager({
				tenantConfig,
				redis: connection,
				rwlockEnabled: policy.rwlockEnabled,
				workerEnabled: true,
				workerOptions: {
					...loadWorkerPoolOptions({
						SQL_FS_WORKER_INPUT_BYTES: "128",
						JUST_BASH_DEFENSE_IN_DEPTH: "true",
						JUST_BASH_DEFENSE_AUDIT_MODE: "false",
					}),
					count: 1,
					cancelGraceMs: 5000,
				},
				execLockOptions: { leaseMs: 5000, readerLeaseMs: 5000, renewMs: 20, acquireTimeoutMs: 2000 },
				defenseInDepth: true,
				defenseAuditMode: false,
			});
			manager = owner;
			const sandboxId = `worker-lease-error-${randomUUID()}`;
			id = sandboxId;
			const subject = `worker-lease-owner-${randomUUID()}`;
			await owner.withSession(
				"default",
				sandboxId,
				async (session) => {
					await session.fs.writeFile("/home/user/a", "a".repeat(70));
					await session.fs.writeFile("/home/user/b", "b".repeat(70));
				},
				{ python: false, javascript: false, network: true },
				subject,
			);
			let leaseSignal: AbortSignal | undefined;
			const originalExec = owner.execWithRuntimeThrottle;
			vi.spyOn(owner, "execWithRuntimeThrottle").mockImplementation((session, script, options) => {
				leaseSignal = sessionLeaseSignal();
				return originalExec.call(owner, session, script, options);
			});
			const app = new Hono<{ Variables: AuthVariables }>();
			app.use("/v1/*", createAuthMiddleware(tenantConfig));
			app.route("/v1/sandboxes", execRoutes(owner));
			app.onError(apiErrorHandler);
			const token = await new SignJWT({ sub: subject })
				.setProtectedHeader({ alg: "HS256" })
				.sign(new TextEncoder().encode(authSecret));
			const execute = async (script: string) =>
				app.request(`/v1/sandboxes/${sandboxId}/exec-sync`, {
					method: "POST",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
					body: JSON.stringify({ script, readOnly: policy.readOnly, timeoutMs: 10000 }),
				});
			const control = await execute("wc -c /home/user/a /home/user/b");
			expect(control.status).toBe(413);
			expect(await control.json()).toMatchObject({ code: "EEXEC_INPUT_LIMIT", retryable: false });
			const posts: { method?: string; body: string }[] = [];
			const respond = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
				let body = "";
				for await (const chunk of request) body += chunk.toString();
				posts.push({ method: request.method, body });
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
			armed = true;
			const operation = execute(
				`curl -sS -X POST --data applied http://127.0.0.1:${address.port}/effect; wc -c /home/user/a /home/user/b`,
			);
			try {
				await Promise.race([
					held.reached,
					operation.then(() => {
						throw new Error("Execution returned before its error reply was held");
					}),
				]);
				expect(posts).toEqual([{ method: "POST", body: "applied" }]);
				const key = policy.rwlockEnabled
					? policy.readOnly
						? rwLockKeys("default", sandboxId).readers
						: rwLockKeys("default", sandboxId).writer
					: execLockKey("default", sandboxId);
				await connection.del(key);
				await until(() => leaseSignal?.aborted === true);
				releaseReply();
				const response = await operation;
				const body = await response.json();
				console.log(JSON.stringify({ case: "held-input-error-after-post-and-lease-loss", mode: policy.mode, body }));
				expect(response.status).toBe(503);
				expect(body).toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN", retryable: false });
				expect(owner.getWorkerMetrics()?.unknownOutcomes).toBe(1);
				const dialect = new PostgresDialect(process.env.DATABASE_URL ?? "");
				await dialect.connect();
				try {
					const fresh = new SqlFs({ dialect, sandboxId, contentCacheMaxBytes: 1 });
					await fresh.ready();
					for (const [path, content] of [
						["/home/user/a", "a".repeat(70)],
						["/home/user/b", "b".repeat(70)],
					] as const) {
						const bytes = await fresh.readFileBuffer(path);
						expect(createHash("sha256").update(bytes).digest("hex")).toBe(
							createHash("sha256").update(content).digest("hex"),
						);
					}
				} finally {
					await dialect.disconnect();
				}
				const healthy = await execute("wc -c /home/user/a; echo recovered");
				expect(healthy.status).toBe(200);
				expect(await healthy.json()).toMatchObject({ exitCode: 0, stdout: "70 /home/user/a\nrecovered\n" });
				expect(posts).toEqual([{ method: "POST", body: "applied" }]);
			} finally {
				releaseReply();
				await operation;
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		});
	},
);
