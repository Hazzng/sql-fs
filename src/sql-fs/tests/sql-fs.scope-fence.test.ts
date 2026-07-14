import { describe, expect, it, vi } from "vitest";
import { SqlFs } from "../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../types.js";

const now = new Date("2026-01-01T00:00:00Z");

function entry(inodeId: bigint, kind: 1 | 2, size = 0): PathCacheEntry {
	return {
		inodeId,
		kind,
		mode: kind === 2 ? 0o755 : 0o644,
		size,
		mtime: now,
		contentSha256: kind === 1 ? new Uint8Array(32).fill(1) : null,
		symlinkTarget: null,
	};
}

function makeDialect(): {
	dialect: SqlDialect<unknown>;
	getSandboxVersion: ReturnType<typeof vi.fn>;
	fenceSandboxWrite: ReturnType<typeof vi.fn>;
} {
	let nextInode = 10n;
	const getSandboxVersion = vi.fn(async () => 7n);
	const fenceSandboxWrite = vi.fn(async () => {});
	const dialect = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
		getSandboxVersion,
		fenceSandboxWrite,
		loadAllPaths: vi.fn(async () => [
			{ path: "/", ...entry(1n, 2) },
			{ path: "/home/user", ...entry(2n, 2) },
			{ path: "/home/user/existing", ...entry(3n, 1, 1) },
		]),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		createInode: vi.fn(async () => {
			nextInode++;
			return nextInode;
		}),
		getInode: vi.fn(),
		updateInode: vi.fn(),
		deleteInode: vi.fn(),
		incrementNlink: vi.fn(),
		decrementNlink: vi.fn(async () => 0),
		insertDirent: vi.fn(),
		upsertDirent: vi.fn(async () => null),
		deleteDirent: vi.fn(async () => 3n),
		listDirents: vi.fn(),
		moveDirent: vi.fn(),
		upsertBlob: vi.fn(),
		getBlob: vi.fn(async () => new Uint8Array(0)),
		getBlobNoTx: vi.fn(async () => new Uint8Array(0)),
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(async () => [2n, 3n]),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
		mkdirComposite: vi.fn(async () => {
			nextInode++;
			return nextInode;
		}),
	} as unknown as SqlDialect<unknown>;
	return { dialect, getSandboxVersion, fenceSandboxWrite };
}

describe("SqlFs script scope epoch fencing", () => {
	it("pins the epoch before lazy tx creation, fences fallback and composite writes once", async () => {
		const { dialect, getSandboxVersion, fenceSandboxWrite } = makeDialect();
		const fs = new SqlFs({ dialect, sandboxId: "scope-fence" });
		await fs.ready();

		fs.beginScriptScope();
		await fs.writeFile("/home/user/fallback", "x");
		await fs.mkdir("/home/user/composite");
		await fs.endScriptScope();

		expect(getSandboxVersion).toHaveBeenCalledOnce();
		expect(fenceSandboxWrite).toHaveBeenCalledOnce();
		expect(fenceSandboxWrite).toHaveBeenCalledWith(expect.anything(), "scope-fence", 7n);
	});
});
