/**
 * Postgres dialect for SqlFs.
 * US-004: connection and sandbox context (connect, disconnect, transaction, setSandboxContext)
 * Subsequent stories fill in the stub methods below.
 */

import { createHash } from "node:crypto";
import postgres from "postgres";
import { createEnoent, translateSqlError } from "../errors.js";
import type { RedisBlobCache } from "../redis-blob-cache.js";
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
	readonly #blobCache: RedisBlobCache | undefined;

	constructor(connectionString: string, blobCache?: RedisBlobCache) {
		this.connectionString = connectionString;
		this.#blobCache = blobCache;
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
		// RLS context only — no advisory lock. Read-only paths (cold-start load,
		// cache reload) use this to avoid serializing against unrelated writers.
		await tx`SELECT set_config('app.sandbox_id', ${sandboxId}, true)`;
	}

	async setSandboxContextWithLock(tx: PgTx, sandboxId: string): Promise<void> {
		await tx`SELECT set_config('app.sandbox_id', ${sandboxId}, true)`;
		// Cross-replica write serialization at the DB layer.
		// Transaction-scoped; auto-released on COMMIT/ROLLBACK.
		// Works with transaction-mode pooling (Neon/pgbouncer) — session-scoped would not.
		await tx`SELECT pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))`;
	}

	// ── Private helpers ───────────────────────────────────────────────────────────

	private db(): postgres.Sql {
		if (!this.pool) throw new Error("PostgresDialect: not connected");
		return this.pool;
	}

	// ── Stubs — implemented in subsequent user stories ────────────────────────────

	// US-005
	async createSandbox(tx: PgTx, sandboxId: string): Promise<{ rootInodeId: bigint }> {
		// 1. Insert sandbox row first (root_inode is NULL initially) to satisfy FK
		await tx`INSERT INTO sandboxes (id, root_inode) VALUES (${sandboxId}, NULL)`;

		// 2. Insert root directory inode (kind=2, mode=0o755)
		const rootRows = await tx<{ id: string }[]>`
			INSERT INTO inodes (sandbox_id, kind, mode, size, nlink)
			VALUES (${sandboxId}, 2, ${0o755}, 0, 1)
			RETURNING id
		`;
		const rootRow = rootRows[0];
		if (!rootRow) throw new Error("createSandbox: failed to create root inode");
		const rootInodeId = BigInt(rootRow.id);

		// 3. Update sandbox with root_inode reference
		await tx`UPDATE sandboxes SET root_inode = ${String(rootInodeId)} WHERE id = ${sandboxId}`;

		// 3. Create default directories under root: /home, /tmp, /bin
		const homeInodeId = await this.#createDirInode(tx, sandboxId, rootInodeId, "home");
		await this.#createDirInode(tx, sandboxId, rootInodeId, "tmp");
		await this.#createDirInode(tx, sandboxId, rootInodeId, "bin");

		// 4. Create /home/user under /home
		await this.#createDirInode(tx, sandboxId, homeInodeId, "user");

		return { rootInodeId };
	}

	async deleteSandbox(tx: PgTx, sandboxId: string): Promise<void> {
		// Acquire advisory lock before any destructive SQL so in-flight writes
		// (from other replicas or code paths that bypass withSession) serialize first.
		await tx`SELECT pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))`;
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
		tx: PgTx,
		oldParentId: bigint,
		oldName: string,
		newParentId: bigint,
		newName: string,
	): Promise<void> {
		// If destination already exists, delete it first (within the same transaction)
		await tx`
			DELETE FROM dirents
			WHERE parent_inode_id = ${String(newParentId)} AND name = ${newName}
		`;

		// Move the source dirent via a single UPDATE
		const rows = await tx<{ inode_id: string }[]>`
			UPDATE dirents
			SET parent_inode_id = ${String(newParentId)}, name = ${newName}
			WHERE parent_inode_id = ${String(oldParentId)} AND name = ${oldName}
			RETURNING inode_id
		`;

		if (rows.length === 0) throw createEnoent(oldName);
	}

	// US-013
	async upsertBlob(tx: PgTx, sha256: Uint8Array, data: Uint8Array): Promise<void> {
		await tx`
			INSERT INTO blobs (sha256, data, size)
			VALUES (${sha256}, ${data}, ${data.length})
			ON CONFLICT (sha256) DO NOTHING
		`;
		if (this.#blobCache) {
			await this.#blobCache.set(sha256, data);
		}
	}

	async getBlob(tx: PgTx, sha256: Uint8Array): Promise<Uint8Array | null> {
		if (this.#blobCache) {
			const cached = await this.#blobCache.get(sha256);
			if (cached !== null) return cached;
		}
		const rows = await tx<{ data: Buffer }[]>`SELECT data FROM blobs WHERE sha256 = ${sha256}`;
		const data = rows[0]?.data;
		if (!data) return null;
		const bytes = new Uint8Array(data);
		if (this.#blobCache) {
			await this.#blobCache.set(sha256, bytes);
		}
		return bytes;
	}

	// US-014
	async gcOrphanBlobs(tx: PgTx): Promise<number> {
		const rows = await tx<{ sha256: Buffer }[]>`
			DELETE FROM blobs
			WHERE sha256 NOT IN (
				SELECT content_sha256 FROM inodes WHERE content_sha256 IS NOT NULL
			)
			RETURNING sha256
		`;
		return rows.length;
	}

	// US-015
	async loadAllPaths(tx: PgTx): Promise<Array<{ path: string } & PathCacheEntry>> {
		const rows = await tx<
			{
				inode_id: string;
				kind: number;
				mode: number;
				size: string;
				mtime: Date;
				content_sha256: Buffer | null;
				symlink_target: string | null;
				path: string;
			}[]
		>`
			WITH RECURSIVE tree AS (
				SELECT
					i.id AS inode_id,
					i.kind,
					i.mode,
					i.size,
					i.mtime,
					i.content_sha256,
					i.symlink_target,
					'/'::text AS path
				FROM sandboxes s
				JOIN inodes i ON i.id = s.root_inode
				WHERE s.id = current_setting('app.sandbox_id')

				UNION ALL

				SELECT
					i.id AS inode_id,
					i.kind,
					i.mode,
					i.size,
					i.mtime,
					i.content_sha256,
					i.symlink_target,
					CASE WHEN t.path = '/' THEN '/' || d.name ELSE t.path || '/' || d.name END AS path
				FROM tree t
				JOIN dirents d ON d.parent_inode_id = t.inode_id
				JOIN inodes i ON i.id = d.inode_id
			)
			SELECT inode_id, kind, mode, size, mtime, content_sha256, symlink_target, path
			FROM tree
		`;
		return rows.map((r) => ({
			path: r.path,
			inodeId: BigInt(r.inode_id),
			kind: r.kind as InodeKind,
			mode: r.mode,
			size: Number(r.size),
			mtime: r.mtime,
			contentSha256: r.content_sha256,
			symlinkTarget: r.symlink_target,
		}));
	}

	// US-016
	async loadSubtreeInodes(tx: PgTx, rootInodeId: bigint): Promise<bigint[]> {
		const rows = await tx<{ id: string }[]>`
			WITH RECURSIVE subtree AS (
				SELECT id FROM inodes WHERE id = ${String(rootInodeId)}

				UNION ALL

				SELECT i.id
				FROM inodes i
				JOIN dirents d ON d.inode_id = i.id
				JOIN subtree s ON s.id = d.parent_inode_id
			)
			SELECT id FROM subtree
		`;
		return rows.map((r) => BigInt(r.id));
	}

	// US-017
	async bulkIngest(tx: PgTx, files: BulkIngestFile[]): Promise<void> {
		if (files.length === 0) return;

		// Get sandbox_id and root_inode via current session context
		const ctxRows = await tx<{ id: string; root_inode: string }[]>`
			SELECT id, root_inode FROM sandboxes WHERE id = current_setting('app.sandbox_id')
		`;
		const ctxRow = ctxRows[0];
		if (!ctxRow?.root_inode) throw new Error("bulkIngest: sandbox not found or has no root inode");
		const sandboxId = ctxRow.id;
		const rootInodeId = BigInt(ctxRow.root_inode);

		// Build path → inodeId map starting from the root
		const dirMap = new Map<string, bigint>();
		dirMap.set("/", rootInodeId);

		// Collect all unique ancestor directory paths, sorted shallow-first
		const dirPaths = new Set<string>();
		for (const f of files) {
			const parts = f.path.split("/").filter(Boolean);
			for (let i = 1; i < parts.length; i++) {
				dirPaths.add(`/${parts.slice(0, i).join("/")}`);
			}
		}
		const sortedDirPaths = [...dirPaths].sort((a, b) => {
			const da = a.split("/").filter(Boolean).length;
			const db = b.split("/").filter(Boolean).length;
			return da - db;
		});

		// Ensure each directory exists, creating it if missing
		for (const dirPath of sortedDirPaths) {
			if (dirMap.has(dirPath)) continue;
			const parts = dirPath.split("/").filter(Boolean);
			const name = parts[parts.length - 1]!;
			const parentPath = parts.length === 1 ? "/" : `/${parts.slice(0, -1).join("/")}`;
			const parentInodeId = dirMap.get(parentPath);
			if (!parentInodeId) throw new Error(`bulkIngest: parent dir ${parentPath} not found`);

			// Check if dir already exists in DB
			const existing = await tx<{ inode_id: string }[]>`
				SELECT inode_id FROM dirents
				WHERE parent_inode_id = ${String(parentInodeId)} AND name = ${name}
			`;
			if (existing[0]) {
				dirMap.set(dirPath, BigInt(existing[0].inode_id));
				continue;
			}

			// Create dir inode + dirent
			const dirInodeRows = await tx<{ id: string }[]>`
				INSERT INTO inodes (sandbox_id, kind, mode, size)
				VALUES (${sandboxId}, 2, ${0o755}, 0)
				RETURNING id
			`;
			const dirInodeRow = dirInodeRows[0];
			if (!dirInodeRow) throw new Error(`bulkIngest: failed to create dir inode for ${dirPath}`);
			const dirInodeId = BigInt(dirInodeRow.id);

			await tx`
				INSERT INTO dirents (parent_inode_id, name, inode_id, sandbox_id)
				VALUES (${String(parentInodeId)}, ${name}, ${String(dirInodeId)}, ${sandboxId})
			`;
			dirMap.set(dirPath, dirInodeId);
		}

		// Compute sha256 for every file
		const filesWithHash = files.map((f) => ({
			path: f.path,
			content: f.content,
			mode: f.mode,
			sha256: Buffer.from(createHash("sha256").update(f.content).digest()),
		}));

		// Multi-row INSERT unique blobs, dedup via ON CONFLICT DO NOTHING
		const uniqueBlobs = new Map<string, { sha256: Buffer; data: Uint8Array; size: number }>();
		for (const f of filesWithHash) {
			const key = f.sha256.toString("hex");
			if (!uniqueBlobs.has(key)) {
				uniqueBlobs.set(key, { sha256: f.sha256, data: f.content, size: f.content.length });
			}
		}
		if (uniqueBlobs.size > 0) {
			const blobRows = [...uniqueBlobs.values()];
			await tx`INSERT INTO blobs ${tx(blobRows)} ON CONFLICT (sha256) DO NOTHING`;
		}

		// Multi-row INSERT file inodes, RETURNING ids in insertion order
		const inodeInserts = filesWithHash.map((f) => ({
			sandbox_id: sandboxId,
			kind: 1,
			mode: f.mode,
			size: f.content.length,
			content_sha256: f.sha256,
		}));
		const insertedInodes = await tx<{ id: string }[]>`INSERT INTO inodes ${tx(inodeInserts)} RETURNING id`;

		// Multi-row INSERT dirents linking each file inode to its parent dir
		const direntInserts = filesWithHash.map((f, i) => {
			const parts = f.path.split("/").filter(Boolean);
			const name = parts[parts.length - 1]!;
			const parentPath = parts.length === 1 ? "/" : `/${parts.slice(0, -1).join("/")}`;
			const parentInodeId = dirMap.get(parentPath);
			if (!parentInodeId) throw new Error(`bulkIngest: parent dir not found for ${f.path}`);
			const inodeId = insertedInodes[i]!.id;
			return {
				parent_inode_id: String(parentInodeId),
				name,
				inode_id: inodeId,
				sandbox_id: sandboxId,
			};
		});
		await tx`INSERT INTO dirents ${tx(direntInserts)} ON CONFLICT DO NOTHING`;
	}

	// US-018
	async resolvePath(tx: PgTx, path: string, followLast: boolean): Promise<bigint> {
		try {
			const rows = await tx<{ inode_id: string }[]>`
				SELECT fs_resolve(${path}, ${followLast}) AS inode_id
			`;
			const row = rows[0];
			if (!row) throw createEnoent(path);
			return BigInt(row.inode_id);
		} catch (err) {
			throw translateSqlError(err, path);
		}
	}
}
