import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../postgres.js";

const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("PostgresDialect.sandboxExists()", () => {
	let dialect: PostgresDialect;
	const testSandboxId = `test-exists-${crypto.randomUUID()}`;

	beforeAll(async () => {
		dialect = new PostgresDialect(DB_URL!);
		await dialect.connect();
	});

	afterAll(async () => {
		try {
			await dialect.transaction(async (tx) => {
				await dialect.deleteSandbox(tx, testSandboxId);
			});
		} catch {
			/* ignore if already gone */
		}
		await dialect.disconnect();
	});

	it("returns false for a sandbox that does not exist", async () => {
		const nonExistentId = `nonexistent-${crypto.randomUUID()}`;
		const exists = await dialect.transaction(async (tx) => {
			return dialect.sandboxExists(tx, nonExistentId);
		});
		expect(exists).toBe(false);
	});

	it("returns true after sandbox is created", async () => {
		await dialect.transaction(async (tx) => {
			await dialect.createSandbox(tx, testSandboxId);
		});

		const exists = await dialect.transaction(async (tx) => {
			return dialect.sandboxExists(tx, testSandboxId);
		});
		expect(exists).toBe(true);
	});

	it("returns false after sandbox is deleted", async () => {
		try {
			await dialect.transaction(async (tx) => {
				await dialect.createSandbox(tx, testSandboxId);
			});
		} catch {
			/* ignore 23505 if already exists */
		}

		await dialect.transaction(async (tx) => {
			await dialect.deleteSandbox(tx, testSandboxId);
		});

		const exists = await dialect.transaction(async (tx) => {
			return dialect.sandboxExists(tx, testSandboxId);
		});
		expect(exists).toBe(false);
	});

	it("does not require sandbox context (no RLS dependency)", async () => {
		const exists = await dialect.transaction(async (tx) => {
			return dialect.sandboxExists(tx, testSandboxId);
		});
		expect(typeof exists).toBe("boolean");
	});
});
