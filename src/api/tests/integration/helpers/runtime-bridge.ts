import { createHash, randomUUID } from "node:crypto";
import { expect } from "vitest";
import { PostgresDialect } from "../../../../sql-fs/dialects/postgres.js";
import { SqlFs } from "../../../../sql-fs/sql-fs.js";
import { SessionManager } from "../../../session-manager.js";
import { loadTenantConfig } from "../../../tenants.js";
import { loadWorkerPoolOptions } from "../../../worker-owner/pool.js";

export class RuntimeBridgeFixture {
	readonly manager: SessionManager;
	readonly sandboxId = `worker-bridge-${randomUUID()}`;

	constructor(
		maxStringLength = 64 * 1024 * 1024,
		execFileLimitBytes: number | null = 64 * 1024 * 1024,
		maxPythonBridgeBytes = 64 * 1024 * 1024,
	) {
		const options = loadWorkerPoolOptions({ SQL_FS_WORKER_COUNT: "1", MAX_EXEC_FILE_BYTES: "67108864" });
		this.manager = new SessionManager({
			tenantConfig: loadTenantConfig(),
			workerEnabled: true,
			workerOptions: {
				...options,
				execFileLimitBytes,
				executionLimits: { ...options.executionLimits, maxStringLength, maxPythonBridgeBytes },
			},
		});
	}

	async ready(): Promise<void> {
		await this.manager.withSession(
			"default",
			this.sandboxId,
			async () => undefined,
			{ python: true, javascript: true, network: false },
			"worker-bridge-owner",
		);
	}

	async put(size: number, markers: readonly (readonly [number, number])[] = []): Promise<string> {
		const bytes = new Uint8Array(size).fill(97);
		for (const [offset, value] of markers) bytes[offset] = value;
		await this.manager.withSessionOrRehydrate("default", this.sandboxId, (session) =>
			session.fs.writeFile("/home/user/input", bytes),
		);
		return createHash("sha256").update(bytes).digest("hex");
	}

	async exec(script: string) {
		return this.manager.withSessionRead("default", this.sandboxId, (session) =>
			this.manager.execWithRuntimeThrottle(session, script),
		);
	}

	async verifyAndReuse(sha256: string): Promise<void> {
		const dialect = new PostgresDialect(process.env.DATABASE_URL ?? "");
		await dialect.connect();
		try {
			const fs = new SqlFs({ dialect, sandboxId: this.sandboxId, contentCacheMaxBytes: 1 });
			await fs.ready();
			expect(
				createHash("sha256")
					.update(await fs.readFileBuffer("/home/user/input"))
					.digest("hex"),
			).toBe(sha256);
		} finally {
			await dialect.disconnect();
		}
		await this.manager.withSessionRead("default", this.sandboxId, async (session) => {
			expect(
				createHash("sha256")
					.update(await session.fs.readFileBuffer("/home/user/input"))
					.digest("hex"),
			).toBe(sha256);
		});
		expect(await this.exec("python3 -c 'print(7)'")).toMatchObject({ exitCode: 0, stdout: "7\n" });
		expect(await this.exec("js-exec -c 'console.log(9)'")).toMatchObject({ exitCode: 0, stdout: "9\n" });
	}

	async close(): Promise<void> {
		try {
			await this.manager.destroy("default", this.sandboxId);
		} finally {
			await this.manager.shutdown();
		}
	}
}
