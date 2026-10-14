import { describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../../sql-fs/sql-fs.js";
import type { SqlDialect } from "../../../sql-fs/types.js";
import { clientSafeErrorCode, clientSafeErrorMessage, isRetryableError, mapFsErrorToStatus } from "../../errors.js";
import { consumeExecInput, type ExecContext, execContext } from "../../exec-context.js";

function context(inputLimitBytes: number): ExecContext {
	return { maxFileBytes: 1024, inputLimitBytes, inputBytes: 0 };
}

describe("aggregate exec filesystem input", () => {
	it("accepts the exact byte boundary and preserves the first rejection", () => {
		const current = context(8);
		consumeExecInput(current, 4, "/a");
		consumeExecInput(current, 4, "/b");
		expect(current.inputBytes).toBe(8);
		expect(() => consumeExecInput(current, 1, "/c")).toThrow("aggregate limit is 8 bytes");
		const error = current.exceeded!;
		expect(() => consumeExecInput(current, 0, "/d")).toThrow(error);
		expect(current.inputBytes).toBe(8);
		expect(clientSafeErrorCode(error)).toBe("EEXEC_INPUT_LIMIT");
		expect(clientSafeErrorMessage(error)).toBe(error.message);
		expect(mapFsErrorToStatus(error)).toBe(413);
		expect(isRetryableError(error)).toBe(false);
	});

	it("keeps legacy and direct file calls outside the aggregate budget", () => {
		expect(() => consumeExecInput(undefined, 100, "/a")).not.toThrow();
		const current = { maxFileBytes: 8 };
		expect(() => consumeExecInput(current, 100, "/a")).not.toThrow();
		expect(current).toEqual({ maxFileBytes: 8 });
	});

	it("charges cached text, binary and parallel reads once per file access before fetching rejected bytes", async () => {
		const bytes = new TextEncoder().encode("😀😀");
		const getBlobNoTx = vi.fn(async () => bytes);
		const getBlob = vi.fn(async () => bytes);
		const paths = [
			{ path: "/", inodeId: 1n, kind: 2, size: 0 },
			{ path: "/a", inodeId: 2n, kind: 1, size: bytes.byteLength },
			{ path: "/b", inodeId: 3n, kind: 1, size: bytes.byteLength },
		].map((entry) => ({
			...entry,
			mode: 0o755,
			mtime: new Date(),
			contentSha256: entry.kind === 1 ? new Uint8Array(32).fill(Number(entry.inodeId)) : null,
			symlinkTarget: null,
		}));
		const dialect = {
			connect: vi.fn(),
			disconnect: vi.fn(),
			transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
			setSandboxContext: vi.fn(),
			getSandboxEpoch: vi.fn(async () => 0n),
			loadAllPaths: vi.fn(async () => paths),
			getBlobsForSandbox: vi.fn(async () => []),
			getBlobNoTx,
			getBlob,
		} as unknown as SqlDialect<unknown>;
		const fs = new SqlFs({ dialect, sandboxId: "input-budget" });
		await fs.ready();
		await fs.readFile("/a");
		expect(getBlobNoTx).toHaveBeenCalledTimes(1);
		const current = context(8);
		const results = await execContext.run(current, () =>
			Promise.allSettled([fs.readFile("/a"), fs.readFileBuffer("/b")]),
		);
		expect(results[0]).toMatchObject({ status: "fulfilled", value: "😀😀" });
		expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "EEXEC_INPUT_LIMIT" } });
		expect(getBlobNoTx).toHaveBeenCalledTimes(1);
		expect(current.inputBytes).toBe(8);
		await expect(execContext.run(context(8), () => fs.readFileBuffer("/a"))).resolves.toEqual(bytes);
		await expect(fs.readFile("/b")).resolves.toBe("😀😀");
		const appendContext = context(7);
		await expect(execContext.run(appendContext, () => fs.appendFile("/b", "x"))).rejects.toMatchObject({
			code: "EEXEC_INPUT_LIMIT",
		});
		expect(getBlob).not.toHaveBeenCalled();
		expect(appendContext.inputBytes).toBe(0);
		const emptyAppendContext = context(1);
		await expect(execContext.run(emptyAppendContext, () => fs.appendFile("/b", ""))).resolves.toBeUndefined();
		expect(emptyAppendContext.inputBytes).toBe(0);
		expect(getBlob).not.toHaveBeenCalled();
		await fs.disconnect();
	});
});
