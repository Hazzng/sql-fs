/**
 * Fake dialect for the buffered script-tx tests (#166).
 *
 * Records WHEN each transaction opens and closes, and the order of the dialect
 * calls inside it. That timing is the whole point of #166: a test that only checks
 * the final filesystem state passes identically whether the mutations were applied
 * eagerly on a script-long transaction or buffered and replayed at the end.
 */

import { vi } from "vitest";
import type { PathCacheEntry, SqlDialect } from "../../types.js";

const EPOCH_DATE = new Date("2026-01-01T00:00:00Z");

export interface TxWindow {
	readonly openedAt: number;
	closedAt: number | undefined;
}

export interface DialectProbe {
	dialect: SqlDialect<unknown>;
	/** One entry per `transaction()` call, in open order. */
	readonly windows: TxWindow[];
	/** Dialect method names in call order, across all transactions. */
	readonly calls: string[];
	/** Inode ids handed out by the fake, in creation order. */
	readonly createdIds: bigint[];
	/** `data` argument each `writeFileComposite` call received. */
	readonly compositeData: Array<Uint8Array | undefined>;
	/** `parentId` argument each `writeFileComposite`/`mkdirComposite` call received. */
	readonly compositeParents: bigint[];
	/** Live sandbox version, as `getSandboxEpoch` reports it. */
	version: bigint;
	/** When set, `transaction()` rejects with it instead of running the callback. */
	failTransaction: Error | undefined;
}

function dirRow(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: EPOCH_DATE, contentSha256: null, symlinkTarget: null };
}

function fileRow(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return {
		path,
		inodeId,
		kind: 1,
		mode: 0o644,
		size: 5,
		mtime: EPOCH_DATE,
		contentSha256: new Uint8Array(32).fill(0xab),
		symlinkTarget: null,
	};
}

/** Default tree: `/`, `/home`, `/home/user`, `/home/user/file.txt`. */
export const DEFAULT_TREE: Array<{ path: string } & PathCacheEntry> = [
	dirRow("/", 1n),
	dirRow("/home", 2n),
	dirRow("/home/user", 3n),
	fileRow("/home/user/file.txt", 4n),
];

export function makeProbeDialect(tree: Array<{ path: string } & PathCacheEntry> = DEFAULT_TREE): DialectProbe {
	const probe: DialectProbe = {
		dialect: undefined as unknown as SqlDialect<unknown>,
		windows: [],
		calls: [],
		createdIds: [],
		compositeData: [],
		compositeParents: [],
		version: 0n,
		failTransaction: undefined,
	};
	let nextInodeId = 1000n;
	const mint = (): bigint => {
		nextInodeId += 1n;
		probe.createdIds.push(nextInodeId);
		return nextInodeId;
	};
	const note = (name: string): void => {
		probe.calls.push(name);
	};

	probe.dialect = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
			if (probe.failTransaction !== undefined) throw probe.failTransaction;
			const window: TxWindow = { openedAt: Date.now(), closedAt: undefined };
			probe.windows.push(window);
			try {
				return await fn({});
			} finally {
				window.closedAt = Date.now();
			}
		}),
		setSandboxContext: vi.fn(async () => note("setSandboxContext")),
		setSandboxContextWithLock: vi.fn(async () => note("setSandboxContextWithLock")),
		loadAllPaths: vi.fn(async () => tree),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		getSandboxEpoch: vi.fn(async () => probe.version),
		createInode: vi.fn(async () => {
			note("createInode");
			probe.version += 1n;
			return mint();
		}),
		getInode: vi.fn(),
		updateInode: vi.fn(async () => {
			note("updateInode");
			probe.version += 1n;
		}),
		deleteInode: vi.fn(async () => note("deleteInode")),
		incrementNlink: vi.fn(async () => {
			note("incrementNlink");
			probe.version += 1n;
		}),
		decrementNlink: vi.fn(async () => {
			note("decrementNlink");
			return 0;
		}),
		insertDirent: vi.fn(async () => note("insertDirent")),
		upsertDirent: vi.fn(async () => {
			note("upsertDirent");
			return null;
		}),
		deleteDirent: vi.fn(async () => {
			note("deleteDirent");
			probe.version += 1n;
			return 4n;
		}),
		listDirents: vi.fn(),
		moveDirent: vi.fn(async () => {
			note("moveDirent");
			probe.version += 1n;
		}),
		upsertBlob: vi.fn(async () => note("upsertBlob")),
		commitBlob: vi.fn(async () => note("commitBlob")),
		getBlob: vi.fn(async () => new Uint8Array(0)),
		getBlobNoTx: vi.fn(async () => new Uint8Array(0)),
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(async () => []),
		bulkIngest: vi.fn(async () => new Map<string, PathCacheEntry>()),
		resolvePath: vi.fn(),
		writeFileComposite: vi.fn(
			async (
				_tx: unknown,
				_sandboxId: string,
				parentId: bigint,
				_name: string,
				_mode: number,
				_size: number,
				_sha: Uint8Array,
				data?: Uint8Array,
			) => {
				note("writeFileComposite");
				probe.compositeData.push(data);
				probe.compositeParents.push(parentId);
				probe.version += 1n;
				return mint();
			},
		),
		mkdirComposite: vi.fn(async (_tx: unknown, _sandboxId: string, parentId: bigint) => {
			note("mkdirComposite");
			probe.compositeParents.push(parentId);
			probe.version += 1n;
			return mint();
		}),
		rmComposite: vi.fn(async () => {
			note("rmComposite");
			probe.version += 1n;
			return 4n;
		}),
		mvComposite: vi.fn(async () => {
			note("mvComposite");
			probe.version += 1n;
		}),
	} as unknown as SqlDialect<unknown>;

	return probe;
}

/** Buffer config used by every buffered test unless the cap itself is the subject. */
export const BUFFER_ON = { enabled: true, maxOps: 50_000, maxBytes: 32 * 1024 * 1024 } as const;
