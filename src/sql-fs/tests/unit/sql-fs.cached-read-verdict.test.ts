import { describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import { FileContents } from "../../state/file-contents.js";
import { BUFFER_ON, makeProbeDialect } from "../fixtures/buffered-dialect.js";

describe("cached reads during scope failure", () => {
	it.each(["readFile", "readFileBuffer", "readFileBytes"] as const)(
		"rejects %s if the scope is condemned before cached bytes return",
		async (method) => {
			const probe = makeProbeDialect();
			const fs = new SqlFs({ dialect: probe.dialect, sandboxId: "cached-verdict", scriptTxBuffer: BUFFER_ON });
			await fs.ready();
			fs.beginScriptScope();
			await fs.writeFile("/home/user/buffered", "uncommitted");
			let release!: () => void;
			let entered!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const waiting = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const originalRead = FileContents.prototype.read;
			const read = vi.spyOn(FileContents.prototype, "read").mockImplementationOnce(async function (
				this: FileContents,
				path,
				entry,
			) {
				const bytes = await originalRead.call(this, path, entry);
				entered();
				await gate;
				return bytes;
			});
			try {
				const pending = fs[method]("/home/user/buffered");
				const verdict = expect(pending).rejects.toMatchObject({ code: "EDRIVERFAULT" });
				await waiting;
				const fault = Object.assign(new Error("driver connection lost"), { code: "EDRIVERFAULT" });
				vi.mocked(probe.dialect.commitBlob!).mockRejectedValueOnce(fault);
				await expect(fs.writeFile("/home/user/failed", "lost")).rejects.toBe(fault);
				release();
				await verdict;
				expect(probe.dialect.getBlobNoTx).not.toHaveBeenCalled();
				await expect(fs.endScriptScope()).rejects.toBe(fault);
				expect(await fs.exists("/home/user/buffered")).toBe(false);
			} finally {
				release();
				read.mockRestore();
			}
		},
	);
});
