/**
 * #168: the exec file-size ceiling, from the chokepoint that establishes it to the
 * HTTP contract it surfaces under.
 *
 * `execWithRuntimeThrottle` is the single funnel every exec surface (sync, SSE, batch, MCP)
 * goes through, so this asserts the context is set there and — crucially — that it actually
 * reaches the `IFileSystem` bridge *inside* `bash.exec`, which is the whole premise of using
 * AsyncLocalStorage instead of a flag on the session FS.
 */

import { InMemoryFs } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../../sql-fs/sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../../../sql-fs/types.js";
import { clientSafeErrorCode, clientSafeErrorMessage, isRetryableError, mapFsErrorToStatus } from "../../errors.js";
import { type ExecContext, execContext } from "../../exec-context.js";
import { MAX_EXEC_FILE_BYTES } from "../../lib/env.js";
import { SessionManager } from "../../session-manager.js";

const T = "default";

/** Records the exec context observed by each filesystem call bash makes. */
class ProbeFs extends InMemoryFs {
	readonly seen: Array<ExecContext | undefined> = [];

	override async readFile(path: string, options?: Parameters<InMemoryFs["readFile"]>[1]): Promise<string> {
		this.seen.push(execContext.getStore());
		return super.readFile(path, options);
	}

	override async readFileBuffer(path: string): Promise<Uint8Array> {
		this.seen.push(execContext.getStore());
		return super.readFileBuffer(path);
	}
}

describe("execWithRuntimeThrottle establishes the exec file-size context", () => {
	let sm: SessionManager;
	let fs: ProbeFs;
	let sandboxId: string;

	beforeEach(async () => {
		fs = new ProbeFs();
		sm = new SessionManager({ createFs: async () => fs });
		sandboxId = `sb-efbig-${Math.random().toString(36).slice(2)}`;
		await sm.getOrCreate(T, sandboxId);
		await fs.writeFile("/probe.txt", "hello");
		fs.seen.length = 0;
	});

	afterEach(async () => {
		await sm.shutdown();
	});

	it("propagates the ceiling into the IFileSystem calls bash makes", async () => {
		await sm.withSession(T, sandboxId, (session) => sm.execWithRuntimeThrottle(session, "cat /probe.txt"));

		expect(fs.seen.length).toBeGreaterThan(0);
		expect(fs.seen).toContainEqual({ maxFileBytes: MAX_EXEC_FILE_BYTES });
		expect(fs.seen).not.toContainEqual(undefined);
	});

	// Negative guard: the context must be scoped to the exec call, not installed on the
	// session. A direct FS call (the shape the HTTP file routes use) must see no store.
	it("leaves a direct filesystem call outside exec with no context", async () => {
		await fs.readFile("/probe.txt");

		expect(fs.seen.length).toBeGreaterThan(0);
		expect(fs.seen.filter((s) => s !== undefined)).toEqual([]);
	});

	it("does not leak the context past the exec call", async () => {
		await sm.withSession(T, sandboxId, (session) => sm.execWithRuntimeThrottle(session, "cat /probe.txt"));
		fs.seen.length = 0;

		await fs.readFile("/probe.txt");

		expect(fs.seen.length).toBeGreaterThan(0);
		expect(fs.seen.filter((s) => s !== undefined)).toEqual([]);
	});

	it("defaults the ceiling to 8 MiB", () => {
		expect(MAX_EXEC_FILE_BYTES).toBe(8 * 1024 * 1024);
	});
});

describe("EFBIG HTTP contract", () => {
	const efbig = Object.assign(new Error("EFBIG: file too large for sandbox exec, '/big' is 9 bytes"), {
		code: "EFBIG",
	});

	it("maps to 413, the same status the HTTP write caps already return", () => {
		expect(mapFsErrorToStatus(efbig)).toBe(413);
	});

	it("is never advertised retryable — the identical call fails identically", () => {
		expect(isRetryableError(efbig)).toBe(false);
	});

	it("surfaces the code rather than INTERNAL_ERROR", () => {
		expect(clientSafeErrorCode(efbig)).toBe("EFBIG");
	});

	it("surfaces the real message rather than the generic fallback", () => {
		expect(clientSafeErrorMessage(efbig)).toBe(efbig.message);
	});
});

// ── End-to-end through a real SqlFs ──────────────────────────────────────────

const NOW = new Date("2026-01-01T00:00:00Z");

function entry(path: string, inodeId: bigint, kind: 1 | 2, size: number): { path: string } & PathCacheEntry {
	return {
		path,
		inodeId,
		kind,
		mode: kind === 1 ? 0o644 : 0o755,
		size,
		mtime: NOW,
		contentSha256: kind === 1 ? new Uint8Array(32).fill(7) : null,
		symlinkTarget: null,
	};
}

function cappedSqlFs(bigFileBytes: number): SqlFs {
	const dialect = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: vi.fn(async () => [
			entry("/", 1n, 2, 0),
			entry("/home", 2n, 2, 0),
			entry("/home/user", 3n, 2, 0),
			entry("/big.txt", 4n, 1, bigFileBytes),
			entry("/small.txt", 5n, 1, 4),
		]),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		createInode: vi.fn(async () => 50n),
		getInode: vi.fn(),
		updateInode: vi.fn(),
		deleteInode: vi.fn(),
		incrementNlink: vi.fn(),
		decrementNlink: vi.fn(async () => 0),
		insertDirent: vi.fn(),
		upsertDirent: vi.fn(async () => null),
		deleteDirent: vi.fn(),
		listDirents: vi.fn(),
		moveDirent: vi.fn(),
		upsertBlob: vi.fn(),
		getBlob: vi.fn(async () => new Uint8Array(4)),
		getBlobNoTx: vi.fn(async () => new Uint8Array(4)),
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;
	return new SqlFs({ dialect, sandboxId: "s-efbig" });
}

describe("an exec that trips the ceiling fails with EFBIG, not bash's phantom ENOENT", () => {
	let sm: SessionManager;
	const sandboxId = "sb-efbig-e2e";

	beforeEach(async () => {
		sm = new SessionManager({
			createFs: async () => {
				const fs = cappedSqlFs(MAX_EXEC_FILE_BYTES + 1);
				await fs.ready();
				return fs;
			},
		});
		await sm.getOrCreate(T, sandboxId);
	});

	afterEach(async () => {
		await sm.shutdown();
	});

	// The load-bearing assertion of this whole change: just-bash catches the FS rejection
	// and reports `cat: /big.txt: No such file or directory` with exit 1. Without the
	// context re-throw the request would 200 with a stderr line that is actively false.
	it("re-throws the recorded EFBIG rather than returning bash's exit-1 result", async () => {
		const run = sm.withSession(T, sandboxId, (session) => sm.execWithRuntimeThrottle(session, "cat /big.txt"));

		await expect(run).rejects.toMatchObject({ code: "EFBIG" });
	});

	it("carries the full remediation message out to the caller", async () => {
		const err = await sm
			.withSession(T, sandboxId, (session) => sm.execWithRuntimeThrottle(session, "wc -l /big.txt"))
			.then(() => undefined)
			.catch((e: Error) => e);

		expect(err?.message).toContain("the per-file exec limit is 8388608 bytes");
		expect(err?.message).toContain("MAX_EXEC_FILE_BYTES");
		expect(err?.message).not.toContain("No such file or directory");
	});

	it("maps to 413 for the HTTP layer", async () => {
		const err = await sm
			.withSession(T, sandboxId, (session) => sm.execWithRuntimeThrottle(session, "cat /big.txt"))
			.then(() => undefined)
			.catch((e: Error) => e);

		expect(err).toBeInstanceOf(Error);
		expect(mapFsErrorToStatus(err as Error)).toBe(413);
		expect(clientSafeErrorCode(err)).toBe("EFBIG");
	});

	// Negative guard: an under-cap script must be completely untouched — same result, no
	// error, no context residue. Without this a cap that rejected everything would pass.
	it("leaves an under-cap script alone", async () => {
		const result = await sm.withSession(T, sandboxId, (session) =>
			sm.execWithRuntimeThrottle(session, "wc -c /small.txt"),
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
	});
});
