import { describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import { makeProbeDialect } from "../fixtures/buffered-dialect.js";
import { deferred } from "./freshness-helpers.js";

describe("live epoch authority during pending writes", () => {
	it.each(["primitive", "durable composite"])(
		"%s compares the reloaded epoch after its writer lock wait",
		async (kind) => {
			const probe = makeProbeDialect();
			if (kind === "durable composite") {
				probe.dialect.retireSandboxGeneration = async () => ({ priorEpoch: probe.version, epoch: probe.version });
			}
			const fs = new SqlFs({ dialect: probe.dialect, sandboxId: "epoch-oracle" });
			await fs.ready();
			const blocked = deferred();
			const resume = deferred();
			vi.mocked(probe.dialect.setSandboxContextWithLock).mockImplementationOnce(async () => {
				blocked.resolve();
				await resume.promise;
			});
			const operation = kind === "primitive" ? fs.chmod("/home/user/file.txt", 0o600) : fs.mkdir("/home/user/new-dir");
			await blocked.promise;
			probe.version = 1n;
			await fs.reload();
			resume.resolve();
			await expect(operation).resolves.toBeUndefined();
			expect(probe.version).toBe(2n);
			if (kind === "primitive") expect((await fs.stat("/home/user/file.txt")).mode).toBe(0o600);
			else expect((await fs.stat("/home/user/new-dir")).isDirectory).toBe(true);
		},
	);
});
