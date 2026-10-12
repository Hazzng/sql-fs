import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { requireMigratedSchema } from "../../../sql-fs/tests/integration/helpers/schema-preconditions.js";
import { SessionManager } from "../../session-manager.js";
import { loadTenantConfig } from "../../tenants.js";
import { loadWorkerPoolOptions } from "../../worker-owner/pool.js";
import type { ShellExecutionLimits } from "../../worker-owner/protocol.js";

const TENANT = "default";

describe.skipIf(!process.env.DATABASE_URL)("worker interpreter and wire budgets against Postgres", () => {
	const managers: SessionManager[] = [];
	const sandboxes: Array<{ manager: SessionManager; id: string }> = [];

	beforeAll(async () => {
		await requireMigratedSchema(process.env.DATABASE_URL!);
	});

	afterEach(async () => {
		for (const { manager, id } of sandboxes.splice(0)) await manager.destroy(TENANT, id);
		await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
	});

	function manager(limits: ShellExecutionLimits, enabled = true): SessionManager {
		const defaults = loadWorkerPoolOptions();
		const instance = new SessionManager({
			tenantConfig: loadTenantConfig(),
			workerEnabled: enabled,
			workerOptions: { ...defaults, count: 1, executionLimits: { ...defaults.executionLimits, ...limits } },
			defenseInDepth: true,
			defenseAuditMode: false,
		});
		managers.push(instance);
		return instance;
	}

	async function sandbox(owner: SessionManager): Promise<string> {
		const id = `worker-budget-${randomUUID()}`;
		sandboxes.push({ manager: owner, id });
		await owner.withSession(TENANT, id, async () => {});
		return id;
	}

	it("bounds actual Bash stdout and keeps the resident usable after output rejection", async () => {
		const owner = manager({ maxOutputSize: 1024 });
		const id = await sandbox(owner);
		const result = await owner.withSession(TENANT, id, (session) =>
			owner.execWithRuntimeThrottle(session, 'printf "%2048s" x'),
		);
		expect(result.exitCode).not.toBe(0);
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024);
		expect(result.stderr).toMatch(/output|limit/i);
		const healthy = await owner.withSession(TENANT, id, (session) =>
			owner.execWithRuntimeThrottle(session, "echo within-budget"),
		);
		expect(healthy).toMatchObject({ exitCode: 0, stdout: "within-budget\n" });
	});

	it.each([false, true])(
		"rejects an oversized inbound binary write (tiny view=%s) before persisting it",
		async (tinyView) => {
			const owner = manager({ maxWorkerMessageBytes: 4096 });
			const id = await sandbox(owner);
			await expect(
				owner.withSession(TENANT, id, (session) =>
					session.fs.writeFile(
						"/too-large.bin",
						tinyView ? new Uint8Array(new ArrayBuffer(8192), 0, 1) : new Uint8Array(8192),
					),
				),
			).rejects.toMatchObject({ code: "EFBIG" });
			await owner.withSessionRead(TENANT, id, async (session) =>
				expect(await session.fs.exists("/too-large.bin")).toBe(false),
			);
			await owner.withSession(TENANT, id, (session) =>
				session.fs.writeFile("/small.bin", Uint8Array.from([0, 255, 128])),
			);
			await owner.withSessionRead(TENANT, id, async (session) =>
				expect([...(await session.fs.readFileBuffer("/small.bin"))]).toEqual([0, 255, 128]),
			);
		},
	);

	it.each(["readFile", "readFileBuffer"] as const)(
		"bounds actual outbound %s values without corrupting persistent bytes",
		async (method) => {
			const seed = manager({}, false);
			const id = await sandbox(seed);
			await seed.withSession(TENANT, id, (session) => session.fs.writeFile("/stored.txt", "x".repeat(8192)));
			const owner = manager({ maxWorkerMessageBytes: 4096 });
			await owner.withSession(TENANT, id, async () => {});
			await expect(
				owner.withSessionRead(TENANT, id, async (session) => await session.fs[method]("/stored.txt")),
			).rejects.toMatchObject({ code: "EFBIG" });
			await owner.withSessionRead(TENANT, id, async (session) =>
				expect((await session.fs.stat("/stored.txt")).size).toBe(8192),
			);
			await seed.withSessionRead(TENANT, id, async (session) =>
				expect(await session.fs.readFile("/stored.txt")).toBe("x".repeat(8192)),
			);
		},
	);

	it("marks completed exec with an oversized result unknown and never repeats its durable append", async () => {
		const owner = manager({ maxWorkerMessageBytes: 4096, maxOutputSize: 16 * 1024 });
		const id = await sandbox(owner);
		await owner.withSession(TENANT, id, (session) => session.fs.writeFile("/counter.txt", "initial\n"));
		let invocations = 0;
		await expect(
			owner.withSession(TENANT, id, (session) => {
				invocations++;
				return owner.execWithRuntimeThrottle(session, 'echo once >> /counter.txt; printf "%8192s" x');
			}),
		).rejects.toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN" });
		expect(invocations).toBe(1);
		await owner.withSessionRead(TENANT, id, async (session) =>
			expect(await session.fs.readFile("/counter.txt")).toBe("initial\nonce\n"),
		);
		const healthy = await owner.withSessionRead(TENANT, id, (session) =>
			owner.execWithRuntimeThrottle(session, "cat /counter.txt"),
		);
		expect(healthy).toMatchObject({ exitCode: 0, stdout: "initial\nonce\n" });
	});
});
