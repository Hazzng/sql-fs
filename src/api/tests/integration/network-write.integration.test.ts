/**
 * Integration: the `networkWrite` capability against a real Postgres.
 *
 * Creates a sandbox through the HTTP route, reads it back from the list route,
 * and rehydrates it on a second SessionManager (a cold replica) to prove the
 * flag survives in `sandboxes.network_write` (migration 0008).
 *
 * Skips when DATABASE_URL is unset.
 */

import { Hono } from "hono";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../../sql-fs/dialects/postgres.js";
import type { SandboxListEntry, SandboxMeta } from "../../../sql-fs/types.js";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { HTTP_WRITE_ENV_VAR } from "../../commands/pip-command.js";
import { sandboxRoutes } from "../../routes/sandboxes.js";
import { SessionManager } from "../../session-manager.js";

const SKIP = !process.env.DATABASE_URL;
const AUTH_SECRET = "network-write-integration-secret-32bytes";
const OWNER = `nw-owner-${Date.now()}`;

describe.skipIf(SKIP)("networkWrite capability (integration)", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	const created: string[] = [];

	function makeSessionManager(): SessionManager {
		return new SessionManager({
			tenantConfig: {
				tenantIds: ["default"],
				hasTenant: (tenantId: string) => tenantId === "default",
				getConnectionString: () => process.env.DATABASE_URL!,
			},
			getSandboxMetaFn: (_tenant, sandboxId): Promise<SandboxMeta | null> =>
				dialect.transaction((tx) => dialect.getSandboxMeta(tx, sandboxId)),
			persistSandboxMetaFn: (_tenant, sandboxId, meta): Promise<void> =>
				dialect.transaction((tx) => dialect.updateSandboxMeta(tx, sandboxId, meta)),
			listSandboxesFn: (_tenant, owner): Promise<SandboxListEntry[]> =>
				dialect.transaction((tx) => dialect.listSandboxes(tx, owner)),
		});
	}

	function makeApp(sessionManager: SessionManager) {
		const app = new Hono<{ Variables: AuthVariables }>();
		app.use("/v1/*", authMiddleware);
		app.route("/v1/sandboxes", sandboxRoutes(sessionManager));
		return app;
	}

	async function token(): Promise<string> {
		return new SignJWT({ sub: OWNER }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(AUTH_SECRET));
	}

	let manager: SessionManager;

	beforeAll(async () => {
		process.env.AUTH_SECRET = AUTH_SECRET;
		await dialect.connect();
		manager = makeSessionManager();
	});

	afterAll(async () => {
		try {
			await manager.shutdown();
			for (const id of created) {
				await dialect.transaction((tx) => dialect.deleteSandbox(tx, id));
			}
		} finally {
			await dialect.disconnect();
			process.env.AUTH_SECRET = "";
		}
	});

	it("persists networkWrite through create, list and a cold rehydrate", async () => {
		const app = makeApp(manager);
		const bearer = await token();

		const createRes = await app.request("/v1/sandboxes", {
			method: "POST",
			headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
			body: JSON.stringify({ python: true, network: true, networkWrite: true }),
		});
		expect(createRes.status).toBe(201);
		const created1 = (await createRes.json()) as { id: string; network: boolean; networkWrite: boolean };
		created.push(created1.id);
		expect(created1.networkWrite).toBe(true);

		const listRes = await app.request("/v1/sandboxes", { headers: { Authorization: `Bearer ${bearer}` } });
		expect(listRes.status).toBe(200);
		const listed = (await listRes.json()) as { sandboxes: { id: string; networkWrite: boolean }[] };
		expect(listed.sandboxes.find((s) => s.id === created1.id)?.networkWrite).toBe(true);

		// A fresh manager has no warm session: the flag must come back from the DB.
		const cold = makeSessionManager();
		try {
			const meta = await cold.getSandboxMeta("default", created1.id);
			expect(meta?.networkWrite).toBe(true);
			const runtime = await cold.withSessionOrRehydrate(
				"default",
				created1.id,
				async (session) => session.runtimeOptions,
			);
			expect(runtime.networkWrite).toBe(true);
			expect(runtime.network).toBe(true);
		} finally {
			await cold.shutdown();
		}
	});

	it("defaults to false and never exports the env var for a plain network sandbox", async () => {
		const app = makeApp(manager);
		const bearer = await token();

		const createRes = await app.request("/v1/sandboxes", {
			method: "POST",
			headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
			body: JSON.stringify({ network: true }),
		});
		expect(createRes.status).toBe(201);
		const body = (await createRes.json()) as { id: string; networkWrite: boolean };
		created.push(body.id);
		expect(body.networkWrite).toBe(false);

		const meta = await manager.getSandboxMeta("default", body.id);
		expect(meta?.networkWrite).toBe(false);

		const env = await manager.withSessionOrRehydrate(
			"default",
			body.id,
			async (session) => (await session.bash.exec("env")).stdout,
		);
		expect(env).not.toContain(HTTP_WRITE_ENV_VAR);
	});

	it("rejects networkWrite without network", async () => {
		const app = makeApp(manager);
		const bearer = await token();

		const res = await app.request("/v1/sandboxes", {
			method: "POST",
			headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
			body: JSON.stringify({ networkWrite: true }),
		});

		expect(res.status).toBe(400);
		expect((await res.json()) as { details: string[] }).toEqual({
			error: "validation_error",
			code: "INVALID_INPUT",
			details: ["networkWrite requires network: true (the sandbox has no outbound access without it)"],
		});
	});
});
