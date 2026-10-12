import { createHash } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDialect } from "../../../sql-fs/dialects/postgres.js";
import { SqlFs } from "../../../sql-fs/sql-fs.js";
import { requireMigratedSchema } from "../../../sql-fs/tests/integration/helpers/schema-preconditions.js";
import { RuntimeBridgeFixture } from "./helpers/runtime-bridge.js";

describe.skipIf(!process.env.DATABASE_URL)("bounded worker Python bridge with an operator 64 MiB file override", () => {
	let fixture: RuntimeBridgeFixture | undefined;

	beforeAll(async () => {
		await requireMigratedSchema(process.env.DATABASE_URL ?? "");
	});

	beforeEach(() => vi.stubEnv("MAX_EXEC_FILE_BYTES", "67108864"));

	afterEach(async () => {
		try {
			await fixture?.close();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("reads 49 MiB and safely reuses both runtimes without changing file bytes", async () => {
		fixture = new RuntimeBridgeFixture();
		await fixture.ready();
		const size = 49 * 1024 * 1024;
		const sha256 = await fixture.put(size);
		const result = await fixture.exec(`python3 -c 'print(len(open("/home/user/input","rb").read()))'`);
		expect(result.stderr).toBe("");
		expect(result).toMatchObject({ exitCode: 0, stdout: `${size}\n` });
		await fixture.verifyAndReuse(sha256);
	});

	it("rejects a read above configured bridge capacity without retrying open or exhausting descriptors", async () => {
		const capacity = 16 * 1024 * 1024;
		fixture = new RuntimeBridgeFixture(capacity);
		await fixture.ready();
		const sha256 = await fixture.put(capacity + 1);
		const result = await fixture.exec(`python3 -c 'print(len(open("/home/user/input","rb").read()))'`);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("File too large");
		expect(result.stderr).not.toContain("Too many open files");
		await fixture.verifyAndReuse(sha256);
	});

	it("reads, hashes and commits a 49 MiB Python copy with an uncapped worker filesystem", async () => {
		fixture = new RuntimeBridgeFixture(64 * 1024 * 1024, null);
		await fixture.ready();
		const manager = fixture.manager;
		const size = 49 * 1024 * 1024;
		const hash = await fixture.put(size);
		const result = await fixture.manager.withSessionOrRehydrate("default", fixture.sandboxId, (session) =>
			manager.execWithRuntimeThrottle(
				session,
				`command=py; command=\${command}thon3; $command -c 'import hashlib; data=open("/home/user/input","rb").read(); open("/home/user/copied","wb").write(data); print(len(data)); print(hashlib.sha256(data).hexdigest())'`,
			),
		);
		expect(result).toMatchObject({ exitCode: 0, stderr: "", stdout: `${size}\n${hash}\n` });
		const dialect = new PostgresDialect(process.env.DATABASE_URL ?? "");
		await dialect.connect();
		try {
			const fs = new SqlFs({ dialect, sandboxId: fixture.sandboxId, contentCacheMaxBytes: 1 });
			await fs.ready();
			const copied = await fs.readFileBuffer("/home/user/copied");
			expect(copied.length).toBe(size);
			expect(createHash("sha256").update(copied).digest("hex")).toBe(hash);
		} finally {
			await dialect.disconnect();
		}
		await fixture.verifyAndReuse(hash);
	});

	it("enforces an independent Python bridge ceiling in an uncapped worker", async () => {
		const capacity = 16 * 1024 * 1024;
		fixture = new RuntimeBridgeFixture(64 * 1024 * 1024, null, capacity);
		await fixture.ready();
		const hash = await fixture.put(capacity + 1);
		const result = await fixture.exec('python3 -c \'open("/home/user/input","rb").read()\'');
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("File too large");
		await fixture.verifyAndReuse(hash);
	});
});
