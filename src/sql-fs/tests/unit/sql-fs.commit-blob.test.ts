import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../../types.js";

const now = new Date("2026-01-01T00:00:00Z");

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

/**
 * F6 regression: the CAS blob upsert must be committed in its OWN tx/connection
 * BEFORE the inode/dirent composite, so the long-lived script-tx never holds the
 * hot-blob `ON CONFLICT DO UPDATE` tuple lock for the script duration.
 *
 * The mock records the order of `commitBlob` vs the script-tx-bound composite and
 * the tx handle each receives, so we can assert (a) ordering and (b) that
 * `commitBlob` does NOT run on the composite's transaction handle.
 */
function makeDialect(): {
	dialect: SqlDialect<unknown>;
	calls: string[];
	commitBlobMock: ReturnType<typeof vi.fn>;
	writeFileCompositeMock: ReturnType<typeof vi.fn>;
	upsertBlobMock: ReturnType<typeof vi.fn>;
	compositeTx: { value: unknown };
} {
	const calls: string[] = [];
	const compositeTx: { value: unknown } = { value: undefined };
	// A sentinel tx handle so we can prove commitBlob never receives it.
	const SCRIPT_TX = { __script_tx: true };

	const commitBlobMock = vi.fn(async () => {
		calls.push("commitBlob");
	});
	const writeFileCompositeMock = vi.fn(async (tx: unknown) => {
		calls.push("writeFileComposite");
		compositeTx.value = tx;
		return 10n;
	});
	const upsertBlobMock = vi.fn(async () => {
		calls.push("upsertBlob");
	});

	const dialect: SqlDialect<unknown> = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		// transaction() always passes the SCRIPT_TX sentinel as the tx handle.
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(SCRIPT_TX)),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: vi.fn(async () => [dirEntry("/", 1n), dirEntry("/dir", 2n)]),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		createInode: vi.fn(async () => 10n),
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
		upsertBlob: upsertBlobMock,
		commitBlob: commitBlobMock,
		getBlob: vi.fn(async () => null),
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(async () => []),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
		writeFileComposite: writeFileCompositeMock,
		mkdirComposite: vi.fn(),
		rmComposite: vi.fn(),
		mvComposite: vi.fn(),
	} as unknown as SqlDialect<unknown>;

	return { dialect, calls, commitBlobMock, writeFileCompositeMock, upsertBlobMock, compositeTx };
}

describe("SqlFs writeFile — F6 decoupled blob commit", () => {
	let fs: SqlFs;
	let m: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		m = makeDialect();
		fs = new SqlFs({ dialect: m.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("commits the blob via commitBlob before the inode/dirent composite", async () => {
		await fs.writeFile("/dir/a.txt", "hot bytes");

		expect(m.commitBlobMock).toHaveBeenCalledOnce();
		expect(m.writeFileCompositeMock).toHaveBeenCalledOnce();
		expect(m.calls).toEqual(["commitBlob", "writeFileComposite"]);
	});

	it("does NOT run the in-transaction upsertBlob when commitBlob is available", async () => {
		await fs.writeFile("/dir/a.txt", "hot bytes");

		expect(m.upsertBlobMock).not.toHaveBeenCalled();
	});

	it("does not pass the composite's script-tx handle to commitBlob (separate connection)", async () => {
		await fs.writeFile("/dir/a.txt", "hot bytes");

		// commitBlob's signature has no tx parameter; assert it was called with
		// exactly the (sha256, data) pair and never the composite's tx sentinel.
		const [arg0, arg1, ...rest] = m.commitBlobMock.mock.calls[0]!;
		expect(arg0).toBeInstanceOf(Uint8Array); // sha256
		expect(arg1).toBeInstanceOf(Uint8Array); // data
		expect(rest).toEqual([]);
		expect(m.commitBlobMock.mock.calls[0]).not.toContain(m.compositeTx.value);
	});

	it("dedups: writing identical bytes twice commits the same sha256 both times", async () => {
		await fs.writeFile("/dir/a.txt", "same");
		await fs.writeFile("/dir/b.txt", "same");

		expect(m.commitBlobMock).toHaveBeenCalledTimes(2);
		const sha1 = m.commitBlobMock.mock.calls[0]![0] as Uint8Array;
		const sha2 = m.commitBlobMock.mock.calls[1]![0] as Uint8Array;
		expect(Buffer.from(sha1).toString("hex")).toBe(Buffer.from(sha2).toString("hex"));
	});

	it("appendFile also commits the blob via commitBlob before the composite", async () => {
		m.calls.length = 0;
		await fs.appendFile("/dir/log.txt", "line\n");

		expect(m.commitBlobMock).toHaveBeenCalledOnce();
		expect(m.calls).toEqual(["commitBlob", "writeFileComposite"]);
	});
});
