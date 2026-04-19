/**
 * Postgres dialect for SqlFs.
 * US-004: connection and sandbox context (connect, disconnect, transaction, setSandboxContext)
 * Subsequent stories fill in the stub methods below.
 */

import postgres from "postgres";
import type {
	BulkIngestFile,
	CreateInodeOpts,
	DirentRow,
	InodeRow,
	PathCacheEntry,
	SqlDialect,
	UpdateInodeOpts,
} from "../types.js";

/** Transaction handle type used throughout this dialect. */
type PgTx = postgres.TransactionSql;

export class PostgresDialect implements SqlDialect<PgTx> {
	private pool: postgres.Sql | null = null;
	private readonly connectionString: string;

	constructor(connectionString: string) {
		this.connectionString = connectionString;
	}

	// ── Connection ────────────────────────────────────────────────────────────────

	async connect(): Promise<void> {
		this.pool = postgres(this.connectionString, { prepare: false });
	}

	async disconnect(): Promise<void> {
		await this.pool?.end();
		this.pool = null;
	}

	// ── Transactions ──────────────────────────────────────────────────────────────

	async transaction<T>(fn: (tx: PgTx) => Promise<T>): Promise<T> {
		return this.db().begin(fn) as Promise<T>;
	}

	// ── Sandbox context ───────────────────────────────────────────────────────────

	async setSandboxContext(tx: PgTx, sandboxId: string): Promise<void> {
		await tx`SELECT set_config('app.sandbox_id', ${sandboxId}, true)`;
	}

	// ── Private helpers ───────────────────────────────────────────────────────────

	private db(): postgres.Sql {
		if (!this.pool) throw new Error("PostgresDialect: not connected");
		return this.pool;
	}

	// ── Stubs — implemented in subsequent user stories ────────────────────────────

	// US-005
	async createSandbox(tx: PgTx, sandboxId: string): Promise<{ rootInodeId: bigint }> {
		// 1. Insert root directory inode (kind=2, mode=0o755)
		const rootRows = await tx<{ id: string }[]>`
			INSERT INTO inodes (sandbox_id, kind, mode, size, nlink)
			VALUES (${sandboxId}, 2, ${0o755}, 0, 1)
			RETURNING id
		`;
		const rootRow = rootRows[0];
		if (!rootRow) throw new Error("createSandbox: failed to create root inode");
		const rootInodeId = BigInt(rootRow.id);

		// 2. Register sandbox row, setting root_inode
		await tx`INSERT INTO sandboxes (id, root_inode) VALUES (${sandboxId}, ${String(rootInodeId)})`;

		// 3. Create default directories under root: /home, /tmp, /bin
		const homeInodeId = await this.#createDirInode(tx, sandboxId, rootInodeId, "home");
		await this.#createDirInode(tx, sandboxId, rootInodeId, "tmp");
		await this.#createDirInode(tx, sandboxId, rootInodeId, "bin");

		// 4. Create /home/user under /home
		await this.#createDirInode(tx, sandboxId, homeInodeId, "user");

		return { rootInodeId };
	}

	async deleteSandbox(tx: PgTx, sandboxId: string): Promise<void> {
		await tx`DELETE FROM sandboxes WHERE id = ${sandboxId}`;
	}

	/** Inserts a kind=2 inode and links it under `parentInodeId` with `name`. Returns new inode id. */
	async #createDirInode(tx: PgTx, sandboxId: string, parentInodeId: bigint, name: string): Promise<bigint> {
		const rows = await tx<{ id: string }[]>`
			INSERT INTO inodes (sandbox_id, kind, mode, size, nlink)
			VALUES (${sandboxId}, 2, ${0o755}, 0, 1)
			RETURNING id
		`;
		const row = rows[0];
		if (!row) throw new Error(`createSandbox: failed to create inode for /${name}`);
		const inodeId = BigInt(row.id);
		await tx`
			INSERT INTO dirents (parent_inode_id, name, inode_id, sandbox_id)
			VALUES (${String(parentInodeId)}, ${name}, ${String(inodeId)}, ${sandboxId})
		`;
		return inodeId;
	}

	// US-006
	async createInode(_tx: PgTx, _opts: CreateInodeOpts): Promise<bigint> {
		throw new Error("not implemented");
	}

	async getInode(_tx: PgTx, _inodeId: bigint): Promise<InodeRow | null> {
		throw new Error("not implemented");
	}

	async updateInode(_tx: PgTx, _inodeId: bigint, _updates: UpdateInodeOpts): Promise<void> {
		throw new Error("not implemented");
	}

	async deleteInode(_tx: PgTx, _inodeId: bigint): Promise<void> {
		throw new Error("not implemented");
	}

	// US-007
	async incrementNlink(_tx: PgTx, _inodeId: bigint): Promise<void> {
		throw new Error("not implemented");
	}

	async decrementNlink(_tx: PgTx, _inodeId: bigint): Promise<number> {
		throw new Error("not implemented");
	}

	// US-008
	async insertDirent(_tx: PgTx, _parentId: bigint, _name: string, _inodeId: bigint): Promise<void> {
		throw new Error("not implemented");
	}

	// US-009
	async upsertDirent(_tx: PgTx, _parentId: bigint, _name: string, _inodeId: bigint): Promise<bigint | null> {
		throw new Error("not implemented");
	}

	// US-010
	async deleteDirent(_tx: PgTx, _parentId: bigint, _name: string): Promise<bigint> {
		throw new Error("not implemented");
	}

	// US-011
	async listDirents(_tx: PgTx, _parentId: bigint): Promise<DirentRow[]> {
		throw new Error("not implemented");
	}

	// US-012
	async moveDirent(
		_tx: PgTx,
		_oldParentId: bigint,
		_oldName: string,
		_newParentId: bigint,
		_newName: string,
	): Promise<void> {
		throw new Error("not implemented");
	}

	// US-013
	async upsertBlob(_tx: PgTx, _sha256: Uint8Array, _data: Uint8Array): Promise<void> {
		throw new Error("not implemented");
	}

	async getBlob(_tx: PgTx, _sha256: Uint8Array): Promise<Uint8Array | null> {
		throw new Error("not implemented");
	}

	// US-014
	async gcOrphanBlobs(_tx: PgTx): Promise<number> {
		throw new Error("not implemented");
	}

	// US-015
	async loadAllPaths(_tx: PgTx): Promise<Array<{ path: string } & PathCacheEntry>> {
		throw new Error("not implemented");
	}

	// US-016
	async loadSubtreeInodes(_tx: PgTx, _rootInodeId: bigint): Promise<bigint[]> {
		throw new Error("not implemented");
	}

	// US-017
	async bulkIngest(_tx: PgTx, _files: BulkIngestFile[]): Promise<void> {
		throw new Error("not implemented");
	}

	// US-018
	async resolvePath(_tx: PgTx, _path: string, _followLast: boolean): Promise<bigint> {
		throw new Error("not implemented");
	}
}
