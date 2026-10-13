import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import { BUFFER_ON, DEFAULT_TREE, makeProbeDialect } from "../fixtures/buffered-dialect.js";

describe("cached reads during scope failure", () => {
	it.each(["readFile", "readFileBuffer", "readFileBytes"] as const)(
		"rejects %s if the scope is condemned while prewarm fills the cache",
		async (method) => {
			const bytes = new TextEncoder().encode("cached bytes");
			const sha = createHash("sha256").update(bytes).digest();
			const tree = DEFAULT_TREE.map((entry) =>
				entry.inodeId === 4n ? { ...entry, size: bytes.length, contentSha256: sha } : entry,
			);
			const probe = makeProbeDialect(tree);
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			vi.spyOn(probe.dialect, "getBlobsForSandbox").mockImplementation(async () => {
				await gate;
				return [{ inodeId: 4n, data: bytes }];
			});
			const blobRead = vi.spyOn(probe.dialect, "getBlobNoTx");
			const blobWrite = vi.spyOn(probe.dialect, "commitBlob");
			const fs = new SqlFs({ dialect: probe.dialect, sandboxId: "cached-verdict", scriptTxBuffer: BUFFER_ON });
			await fs.ready();
			fs.beginScriptScope();
			const pending = fs[method]("/home/user/file.txt");
			const verdict = expect(pending).rejects.toMatchObject({ code: "EDRIVERFAULT" });
			await Promise.resolve();
			await Promise.resolve();
			try {
				const fault = Object.assign(new Error("driver connection lost"), { code: "EDRIVERFAULT" });
				blobWrite.mockRejectedValueOnce(fault);
				await expect(fs.writeFile("/home/user/failed", "lost")).rejects.toBe(fault);
				release();
				await verdict;
				expect(blobRead).not.toHaveBeenCalled();
				await expect(fs.endScriptScope()).rejects.toBe(fault);
				expect(await fs.exists("/home/user/failed")).toBe(false);
			} finally {
				release();
			}
		},
	);
});
