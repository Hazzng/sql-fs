/**
 * Unit tests for readFile/readFileBuffer symlink semantics.
 * US-042a: Final-component symlinks are followed; ELOOP and broken symlinks throw.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = new Date("2026-01-01T00:00:00Z");
const fileContent = new TextEncoder().encode("hello via symlink");
const sha256 = new Uint8Array(32).fill(0xcc);

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function fileEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return {
		path,
		inodeId,
		kind: 1,
		mode: 0o644,
		size: fileContent.length,
		mtime: now,
		contentSha256: sha256,
		symlinkTarget: null,
	};
}

function symlinkEntry(path: string, inodeId: bigint, target: string): { path: string } & PathCacheEntry {
	return {
		path,
		inodeId,
		kind: 3,
		mode: 0o777,
		size: target.length,
		mtime: now,
		contentSha256: null,
		symlinkTarget: target,
	};
}

// ── Shared setup ──────────────────────────────────────────────────────────────

function makeFs(
	paths: Array<{ path: string } & PathCacheEntry>,
	resolvePathImpl: (path: string) => Promise<bigint>,
): { fs: SqlFs; getBlobMock: ReturnType<typeof vi.fn>; resolvePathMock: ReturnType<typeof vi.fn> } {
	const getBlobMock = vi.fn(async () => fileContent as Uint8Array | null);
	const resolvePathMock = vi.fn((_tx: unknown, path: string, _followLast: boolean) => resolvePathImpl(path));

	const dialect: SqlDialect<unknown> = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: vi.fn(async () => paths),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		createInode: vi.fn(),
		getInode: vi.fn(),
		updateInode: vi.fn(),
		deleteInode: vi.fn(),
		incrementNlink: vi.fn(),
		decrementNlink: vi.fn(),
		insertDirent: vi.fn(),
		upsertDirent: vi.fn(),
		deleteDirent: vi.fn(),
		listDirents: vi.fn(),
		moveDirent: vi.fn(),
		upsertBlob: vi.fn(),
		getBlob: vi.fn(),
		getBlobNoTx: getBlobMock,
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(),
		bulkIngest: vi.fn(),
		resolvePath: resolvePathMock,
	} as unknown as SqlDialect<unknown>;

	const fs = new SqlFs({ dialect, sandboxId: "s1", allowSymlinks: true });
	return { fs, getBlobMock, resolvePathMock };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SqlFs.readFile — symlink semantics (US-042a)", () => {
	const fileInodeId = 10n;
	const linkInodeId = 20n;

	let fs: SqlFs;
	let getBlobMock: ReturnType<typeof vi.fn>;
	let resolvePathMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		const result = makeFs(
			[dirEntry("/", 1n), fileEntry("/actual.txt", fileInodeId), symlinkEntry("/link.txt", linkInodeId, "/actual.txt")],
			async (path) => {
				if (path === "/link.txt") return fileInodeId; // resolves to /actual.txt's inode
				throw Object.assign(new Error("ENOENT"), { code: "FS002" });
			},
		);
		fs = result.fs;
		getBlobMock = result.getBlobMock;
		resolvePathMock = result.resolvePathMock;
		await fs.ready();
	});

	it("readFile on symlink reads the target file content", async () => {
		const content = await fs.readFile("/link.txt");
		expect(content).toBe("hello via symlink");
	});

	it("readFile on symlink calls resolvePath with followLast=true", async () => {
		await fs.readFile("/link.txt");
		expect(resolvePathMock).toHaveBeenCalledWith(expect.anything(), "/link.txt", true);
	});

	it("readFile on symlink calls getBlobNoTx with target's contentSha256", async () => {
		await fs.readFile("/link.txt");
		expect(getBlobMock).toHaveBeenCalledWith(sha256);
	});

	it("readFile on symlink caches content under the resolved (target) inodeId", async () => {
		await fs.readFile("/link.txt");
		// Content should be cached under fileInodeId (target), not linkInodeId (symlink)
		expect(fs._contentCacheHas(fileInodeId)).toBe(true);
		expect(fs._contentCacheHas(linkInodeId)).toBe(false);
	});

	it("second readFile on same symlink uses cache (getBlob not called again)", async () => {
		await fs.readFile("/link.txt");
		await fs.readFile("/link.txt");
		expect(getBlobMock).toHaveBeenCalledOnce();
	});

	it("readFile on regular file still works (no resolvePath called)", async () => {
		await fs.readFile("/actual.txt");
		expect(resolvePathMock).not.toHaveBeenCalled();
	});
});

describe("SqlFs.readFile — broken symlink and ELOOP (US-042a)", () => {
	it("readFile on broken symlink throws ENOENT", async () => {
		// Symlink target is NOT in pathCache
		const { fs } = makeFs([dirEntry("/", 1n), symlinkEntry("/broken.txt", 5n, "/missing.txt")], async () => {
			// resolvePath returns an inode that doesn't exist in pathCache
			return 999n;
		});
		await fs.ready();
		await expect(fs.readFile("/broken.txt")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("readFile on symlink loop throws ELOOP", async () => {
		const loopError = Object.assign(new Error("ELOOP"), { code: "ELOOP" });
		const { fs } = makeFs([dirEntry("/", 1n), symlinkEntry("/loop.txt", 5n, "/loop.txt")], async () => {
			throw loopError;
		});
		await fs.ready();
		await expect(fs.readFile("/loop.txt")).rejects.toMatchObject({ code: "ELOOP" });
	});
});

describe("SqlFs.readFileBuffer — symlink semantics (US-042a)", () => {
	const fileInodeId = 10n;
	const linkInodeId = 20n;

	let fs: SqlFs;
	let getBlobMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		const result = makeFs(
			[dirEntry("/", 1n), fileEntry("/actual.bin", fileInodeId), symlinkEntry("/link.bin", linkInodeId, "/actual.bin")],
			async (path) => {
				if (path === "/link.bin") return fileInodeId;
				throw Object.assign(new Error("ENOENT"), { code: "FS002" });
			},
		);
		fs = result.fs;
		getBlobMock = result.getBlobMock;
		await fs.ready();
	});

	it("readFileBuffer on symlink returns target file bytes", async () => {
		const bytes = await fs.readFileBuffer("/link.bin");
		expect(bytes).toEqual(fileContent);
	});

	it("readFileBuffer on symlink caches content under resolved inodeId", async () => {
		await fs.readFileBuffer("/link.bin");
		expect(fs._contentCacheHas(fileInodeId)).toBe(true);
		expect(fs._contentCacheHas(linkInodeId)).toBe(false);
	});

	it("second readFileBuffer on symlink uses cache (no extra getBlob call)", async () => {
		await fs.readFileBuffer("/link.bin");
		await fs.readFileBuffer("/link.bin");
		expect(getBlobMock).toHaveBeenCalledOnce();
	});
});
