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
	async createSandbox(_tx: PgTx, _sandboxId: string): Promise<{ rootInodeId: bigint }> {
		throw new Error("not implemented");
	}

	async deleteSandbox(_tx: PgTx, _sandboxId: string): Promise<void> {
		throw new Error("not implemented");
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
