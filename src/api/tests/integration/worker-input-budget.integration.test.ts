import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { requireMigratedSchema } from "../../../sql-fs/tests/integration/helpers/schema-preconditions.js";
import { SessionManager } from "../../session-manager.js";
import { loadTenantConfig } from "../../tenants.js";
import { loadWorkerPoolOptions } from "../../worker-owner/pool.js";

describe.skipIf(!process.env.DATABASE_URL)("worker aggregate filesystem input budget", () => {
	let manager: SessionManager | undefined;
	let sandboxId: string;

	beforeAll(async () => {
		await requireMigratedSchema(process.env.DATABASE_URL ?? "");
	});

	afterEach(async () => {
		if (manager === undefined) return;
		await manager.destroy("default", sandboxId);
		await manager.shutdown();
	});

	async function setup(): Promise<SessionManager> {
		manager = new SessionManager({
			tenantConfig: loadTenantConfig(),
			workerEnabled: true,
			workerOptions: loadWorkerPoolOptions({ SQL_FS_WORKER_INPUT_BYTES: "128", SQL_FS_WORKER_COUNT: "1" }),
		});
		sandboxId = `worker-input-${randomUUID()}`;
		await manager.withSession(
			"default",
			sandboxId,
			async (session) => {
				await session.fs.writeFile("/home/user/a", "😀".repeat(20));
				await session.fs.writeFile("/home/user/b", "😀".repeat(20));
			},
			{ python: true, javascript: true, network: false },
			"worker-input-owner",
		);
		return manager;
	}

	it.each([
		["wc", "wc -c /home/user/a /home/user/b"],
		["substitution", 'a=$(</home/user/a); b=$(</home/user/b); printf \'%s%s\' "$a" "$b"'],
		["cached repeated read", "wc -c /home/user/a; wc -c /home/user/a"],
		["read-modify-write append", "echo x >> /home/user/a; echo y >> /home/user/a"],
		[
			"JavaScript bridge",
			`js-exec -c 'const fs=require("fs"); console.log(fs.readFileSync("/home/user/a").length+fs.readFileSync("/home/user/b").length)'`,
		],
		[
			"Python bridge",
			`python3 -c 'print(len(open("/home/user/a","rb").read())+len(open("/home/user/b","rb").read()))'`,
		],
	])("rejects aggregate reads through %s and rolls back the buffered prefix", async (_name, script) => {
		const current = await setup();
		await expect(
			current.withSessionOrRehydrate("default", sandboxId, (session) =>
				current.execWithRuntimeThrottle(session, `echo rollback > /home/user/prefix; ${script}`),
			),
		).rejects.toMatchObject({ code: "EEXEC_INPUT_LIMIT" });
		await current.withSessionRead("default", sandboxId, async (session) => {
			expect(await session.fs.exists("/home/user/prefix")).toBe(false);
			expect(await session.fs.readFile("/home/user/a")).toBe("😀".repeat(20));
			expect((await current.execWithRuntimeThrottle(session, "wc -c /home/user/a")).stdout).toBe("80 /home/user/a\n");
		});
	});

	it("combines UTF-8 stdin bytes with filesystem reads before the next allocation", async () => {
		const current = await setup();
		await expect(
			current.withSessionOrRehydrate("default", sandboxId, (session) =>
				current.execWithRuntimeThrottle(session, "echo rollback > /home/user/prefix; wc -c /home/user/a", {
					stdin: "😀".repeat(13),
				}),
			),
		).rejects.toMatchObject({ code: "EEXEC_INPUT_LIMIT" });
		await current.withSessionRead("default", sandboxId, async (session) => {
			expect(await session.fs.exists("/home/user/prefix")).toBe(false);
			expect(
				(await current.execWithRuntimeThrottle(session, "wc -c /home/user/a", { stdin: "😀".repeat(12) })).exitCode,
			).toBe(0);
		});
	});
});
