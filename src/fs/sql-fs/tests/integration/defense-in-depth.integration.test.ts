/**
 * Integration tests: DefenseInDepth + Postgres SqlFs.
 *
 * Proves that the DefenseInDepthBox.runTrustedAsync wrappers prevent
 * WorkerSecurityViolationError for common filesystem operations when
 * defenseInDepth is enabled and auditMode is false.
 *
 * Skipped when DATABASE_URL is not set so CI without a DB still passes.
 */

import { Bash } from "just-bash";
import { afterEach, describe, expect, it } from "vitest";
import { createPostgresSandboxFs, destroyPostgresSandbox } from "../../index.js";

const SKIP = !process.env.DATABASE_URL;

describe.skipIf(SKIP)("defenseInDepth + Postgres SqlFs", () => {
	const url = process.env.DATABASE_URL!;
	const createdSandboxIds: string[] = [];

	function makeSandboxId(): string {
		return `test-did-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	}

	afterEach(async () => {
		for (const id of createdSandboxIds.splice(0)) {
			await destroyPostgresSandbox(url, id).catch(() => {});
		}
	});

	// Helper: creates a fresh SqlFs + Bash with defenseInDepth enabled.
	async function createBash(sandboxId: string): Promise<Bash> {
		const { fs } = await createPostgresSandboxFs({ connectionString: url }, sandboxId);
		return new Bash({ fs, defenseInDepth: { enabled: true, auditMode: false } });
	}

	it("echo-write-read does not throw WorkerSecurityViolationError", async () => {
		const sandboxId = makeSandboxId();
		createdSandboxIds.push(sandboxId);

		const bash = await createBash(sandboxId);
		const result = await bash.exec("echo hi > /tmp/x && cat /tmp/x");

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hi");
	});

	it("mkdir -p and ls succeed", async () => {
		const sandboxId = makeSandboxId();
		createdSandboxIds.push(sandboxId);

		const bash = await createBash(sandboxId);
		const result = await bash.exec("mkdir -p /a/b/c && ls /a/b");

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("c");
	});

	it("rm -rf directory succeeds", async () => {
		const sandboxId = makeSandboxId();
		createdSandboxIds.push(sandboxId);

		const bash = await createBash(sandboxId);
		// Create then remove so rm has something to delete.
		const result = await bash.exec("mkdir -p /tmp/rmme && rm -rf /tmp/rmme && echo done");

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("done");
	});

	it("multiple writes in one exec (script-tx flow) commit cleanly", async () => {
		const sandboxId = makeSandboxId();
		createdSandboxIds.push(sandboxId);

		const bash = await createBash(sandboxId);
		const result = await bash.exec("echo a > /tmp/a && echo b > /tmp/b && echo c > /tmp/c && cat /tmp/a /tmp/b /tmp/c");

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("a\nb\nc");
	});

	it("cold-start prewarm: fresh SqlFs reads file written by previous Bash", async () => {
		const sandboxId = makeSandboxId();
		createdSandboxIds.push(sandboxId);

		// First Bash writes a file.
		const bash1 = await createBash(sandboxId);
		await bash1.exec("echo persisted > /tmp/persist");

		// Second Bash (fresh SqlFs, same sandboxId) reads it back.
		const bash2 = await createBash(sandboxId);
		const result = await bash2.exec("cat /tmp/persist");

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("persisted");
	});
});
