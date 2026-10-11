import { createHash } from "node:crypto";
import { vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import type { PathCacheEntry, SqlDialect, TransactionOptions } from "../../types.js";

export function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

export function file(path: string, value: string, inodeId = 2n): { path: string } & PathCacheEntry {
	return {
		path,
		inodeId,
		kind: 1,
		mode: 0o644,
		size: Buffer.byteLength(value, "utf8"),
		mtime: new Date(0),
		contentSha256: createHash("sha256").update(value).digest(),
		symlinkTarget: null,
	};
}

export const root: { path: string } & PathCacheEntry = {
	path: "/",
	inodeId: 1n,
	kind: 2,
	mode: 0o755,
	size: 0,
	mtime: new Date(0),
	contentSha256: null,
	symlinkTarget: null,
};

interface Snapshot {
	epoch: bigint;
	rows: Array<{ path: string } & PathCacheEntry>;
}

export function fixture() {
	const state = { epoch: 1n, rows: [root, file("/value", "old")], failCommit: false };
	const probes = vi.fn(async (tx: Snapshot) => tx.epoch);
	const paths = vi.fn(async (tx: Snapshot) => tx.rows);
	const prewarm = vi.fn(async (): Promise<Array<{ inodeId: bigint; data: Uint8Array }>> => []);
	const blob = vi.fn(async (sha: Uint8Array): Promise<Uint8Array> => {
		const value = ["old", "new"].find((value) =>
			Buffer.from(file("/value", value).contentSha256!).equals(Buffer.from(sha)),
		);
		if (value === undefined) throw new Error("unknown hash");
		return new TextEncoder().encode(value);
	});
	const transaction = vi.fn(async <T>(fn: (tx: Snapshot) => Promise<T>, options?: TransactionOptions): Promise<T> => {
		const snapshot =
			options?.isolationLevel === "repeatable read" ? { epoch: state.epoch, rows: [...state.rows] } : state;
		const result = await fn(snapshot);
		if (state.failCommit) throw new Error("commit failed");
		return result;
	});
	const dialect = {
		transaction,
		setSandboxContext: vi.fn(),
		getSandboxEpoch: probes,
		loadAllPaths: paths,
		getBlobsForSandbox: prewarm,
		getBlobNoTx: blob,
		disconnect: vi.fn(),
	} as unknown as SqlDialect<Snapshot>;
	const fs = new SqlFs({ dialect, sandboxId: "freshness" });
	return { fs, state, probes, paths, prewarm, blob, transaction };
}
