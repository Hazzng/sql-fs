/**
 * Postgres dialect for SqlFs.
 * US-004: connection and sandbox context (connect, disconnect, transaction, setSandboxContext)
 * Subsequent stories fill in the stub methods below.
 */

import postgres from "postgres";
import { createEnoent } from "../errors.js";
import type {
	BulkIngestFile,
	CreateInodeOpts,
	DirentRow,
	InodeKind,
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
	async createInode(tx: PgTx, opts: CreateInodeOpts): Promise<bigint> {
		const rows = await tx<{ id: string }[]>`
			INSERT INTO inodes (sandbox_id, kind, mode, size, content_sha256, symlink_target)
			VALUES (${opts.sandboxId}, ${opts.kind}, ${opts.mode}, ${opts.size}, ${opts.contentSha256 ?? null}, ${opts.symlinkTarget ?? null})
			RETURNING id
		`;
		const row = rows[0];
		if (!row) throw new Error("createInode: INSERT returned no rows");
		return BigInt(row.id);
	}

	async getInode(tx: PgTx, inodeId: bigint): Promise<InodeRow | null> {
		const rows = await tx<
			{
				id: string;
				sandbox_id: string;
				kind: number;
				mode: number;
				size: string;
				mtime: Date;
				nlink: number;
				content_sha256: Buffer | null;
				symlink_target: string | null;
			}[]
		>`
			SELECT id, sandbox_id, kind, mode, size, mtime, nlink, content_sha256, symlink_target
			FROM inodes
			WHERE id = ${String(inodeId)}
		`;
		const row = rows[0];
		if (!row) return null;
		return {
			id: BigInt(row.id),
			sandboxId: row.sandbox_id,
			kind: row.kind as InodeKind,
			mode: row.mode,
			size: Number(row.size),
			mtime: row.mtime,
			nlink: row.nlink,
			contentSha256: row.content_sha256,
			symlinkTarget: row.symlink_target,
		};
	}

	async updateInode(tx: PgTx, inodeId: bigint, updates: UpdateInodeOpts): Promise<void> {
		// Build a snake_case patch object for postgres.js dynamic sql(obj) helper
		const patch: Record<string, string | number | Date | Uint8Array | null> = Object.create(null);
		if (updates.mode !== undefined) patch.mode = updates.mode;
		if (updates.size !== undefined) patch.size = updates.size;
		if (updates.mtime !== undefined) patch.mtime = updates.mtime;
		if ("contentSha256" in updates) patch.content_sha256 = updates.contentSha256 ?? null;

		if (Object.keys(patch).length === 0) return;

		await tx`UPDATE inodes SET ${tx(patch)} WHERE id = ${String(inodeId)}`;
	}

	async deleteInode(tx: PgTx, inodeId: bigint): Promise<void> {
		await tx`DELETE FROM inodes WHERE id = ${String(inodeId)}`;
	}

	// US-007
	async incrementNlink(tx: PgTx, inodeId: bigint): Promise<void> {
		await tx`UPDATE inodes SET nlink = nlink + 1 WHERE id = ${String(inodeId)}`;
	}

	async decrementNlink(tx: PgTx, inodeId: bigint): Promise<number> {
		const rows = await tx<{ nlink: number }[]>`
			UPDATE inodes SET nlink = nlink - 1 WHERE id = ${String(inodeId)} RETURNING nlink
		`;
		const row = rows[0];
		if (!row) throw new Error(`decrementNlink: inode ${inodeId} not found`);
		return row.nlink;
	}

	// US-008
	async insertDirent(tx: PgTx, parentId: bigint, name: string, inodeId: bigint): Promise<void> {
		// Derive sandbox_id from the parent inode to avoid needing it as a parameter.
		await tx`
			INSERT INTO dirents (parent_inode_id, name, inode_id, sandbox_id)
			SELECT ${String(parentId)}, ${name}, ${String(inodeId)}, sandbox_id
			FROM inodes
			WHERE id = ${String(parentId)}
		`;
	}

	// US-009
	async upsertDirent(tx: PgTx, parentId: bigint, name: string, inodeId: bigint): Promise<bigint | null> {
		// Capture the old inode_id (if any) before the upsert, then return it after.
		const rows = await tx<{ old_inode_id: string | null }[]>`
			WITH existing AS (
				SELECT inode_id FROM dirents
				WHERE parent_inode_id = ${String(parentId)} AND name = ${name}
			)
			INSERT INTO dirents (parent_inode_id, name, inode_id, sandbox_id)
			SELECT ${String(parentId)}, ${name}, ${String(inodeId)}, sandbox_id
			FROM inodes WHERE id = ${String(parentId)}
			ON CONFLICT (parent_inode_id, name) DO UPDATE SET inode_id = EXCLUDED.inode_id
			RETURNING (SELECT inode_id FROM existing) AS old_inode_id
		`;
		const row = rows[0];
		if (!row) throw new Error("upsertDirent: INSERT returned no rows");
		return row.old_inode_id !== null ? BigInt(row.old_inode_id) : null;
	}

	// US-010
	async deleteDirent(tx: PgTx, parentId: bigint, name: string): Promise<bigint> {
		const rows = await tx<{ inode_id: string }[]>`
			DELETE FROM dirents
			WHERE parent_inode_id = ${String(parentId)} AND name = ${name}
			RETURNING inode_id
		`;
		const row = rows[0];
		if (!row) throw createEnoent(name);
		return BigInt(row.inode_id);
	}

	// US-011
	async listDirents(tx: PgTx, parentId: bigint): Promise<DirentRow[]> {
		const rows = await tx<{ parent_inode_id: string; name: string; inode_id: string }[]>`
			SELECT d.parent_inode_id, d.name, d.inode_id
			FROM dirents d
			JOIN inodes i ON i.id = d.inode_id
			WHERE d.parent_inode_id = ${String(parentId)}
			ORDER BY d.name
		`;
		return rows.map((r) => ({
			parentInodeId: BigInt(r.parent_inode_id),
			name: r.name,
			inodeId: BigInt(r.inode_id),
		}));
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
