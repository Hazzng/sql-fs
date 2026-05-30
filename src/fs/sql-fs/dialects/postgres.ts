/**
 * Postgres dialect for SqlFs.
 * US-004: connection and sandbox context (connect, disconnect, transaction, setSandboxContext)
 * Subsequent stories fill in the stub methods below.
 */

import { createHash } from "node:crypto";
import postgres from "postgres";
import { runTrustedDbAsync } from "../defense.js";
import { createEisdir, createEnoent, createEnotdir, translateSqlError } from "../errors.js";
import type { RedisBlobCache } from "../redis-blob-cache.js";
import {
	type BulkIngestFile,
	type CreateInodeOpts,
	type DirentRow,
	INODE_KIND,
	type InodeKind,
	type InodeRow,
	type PathCacheEntry,
	type SandboxListEntry,
	type SandboxMeta,
	type SqlDialect,
	type UpdateInodeOpts,
} from "../types.js";

/** Transaction handle type used throughout this dialect. */
type PgTx = postgres.TransactionSql;

/**
 * Reads a positive integer env var, returns the fallback when unset / malformed.
 * Used for pool tuning so deploys can override without code changes.
 */
function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

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
		// Bound the pool: each PostgresDialect instance is owned by one warm
		// session, so a tiny `max` is sufficient. Without these caps a runaway
		// session could exhaust the upstream Postgres connection limit
		// (especially Neon, where pooler endpoints have small per-tenant caps).
		const max = envInt("PG_POOL_MAX", 2);
		const idleTimeout = envInt("PG_POOL_IDLE_TIMEOUT_S", 30);
		const connectTimeout = envInt("PG_POOL_CONNECT_TIMEOUT_S", 30);
		const maxLifetime = envInt("PG_POOL_MAX_LIFETIME_S", 60 * 30);
		this.pool = await runTrustedDbAsync(() =>
			Promise.resolve(
				postgres(this.connectionString, {
					prepare: false,
					max,
					idle_timeout: idleTimeout,
					connect_timeout: connectTimeout,
					max_lifetime: maxLifetime,
				}),
			),
		);
	}

	async disconnect(): Promise<void> {
		await runTrustedDbAsync(() => this.pool?.end() ?? Promise.resolve());
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
		await tx`SELECT set_config('app.sandbox_id', ${sandboxId}, true), pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))`;
	}

	// ── Composite write operations ────────────────────────────────────────────────

	async mkdirComposite(tx: PgTx, sandboxId: string, parentId: bigint, name: string, mode: number): Promise<bigint> {
		const rows = await tx<{ id: string }[]>`
			WITH ctx AS (
				SELECT set_config('app.sandbox_id', ${sandboxId}, true),
				       pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))
			),
			new_inode AS (
				INSERT INTO inodes (sandbox_id, kind, mode, size)
				SELECT ${sandboxId}, 2, ${mode}, 0 FROM ctx
				RETURNING id
			)
			INSERT INTO dirents (parent_inode_id, name, inode_id, sandbox_id)
			SELECT ${String(parentId)}, ${name}, new_inode.id, ${sandboxId}
			FROM new_inode
			RETURNING inode_id AS id
		`;
		const row = rows[0];
		if (!row) throw new Error("mkdirComposite: INSERT returned no rows");
		return BigInt(row.id);
	}

	async rmComposite(tx: PgTx, sandboxId: string, parentId: bigint, name: string): Promise<bigint> {
		const rows = await tx<{ removed_inode_id: string }[]>`
			WITH ctx AS (
				SELECT set_config('app.sandbox_id', ${sandboxId}, true),
				       pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))
			),
			removed_dirent AS (
				DELETE FROM dirents
				WHERE parent_inode_id = ${String(parentId)} AND name = ${name}
					AND (SELECT 1 FROM ctx) IS NOT NULL
				RETURNING inode_id
			),
			decremented AS (
				UPDATE inodes
				SET nlink = nlink - 1
				FROM removed_dirent
				WHERE inodes.id = removed_dirent.inode_id
				RETURNING inodes.id, inodes.nlink
			),
			cleaned AS (
				DELETE FROM inodes
				WHERE id IN (SELECT id FROM decremented WHERE nlink <= 0)
			)
			SELECT inode_id AS removed_inode_id FROM removed_dirent
		`;
		const row = rows[0];
		if (!row) throw createEnoent(name);
		return BigInt(row.removed_inode_id);
	}

	async writeFileComposite(
		tx: PgTx,
		sandboxId: string,
		parentId: bigint,
		name: string,
		mode: number,
		size: number,
		sha256: Uint8Array,
		data: Uint8Array,
	): Promise<bigint> {
		const rows = await tx<{ new_inode_id: string }[]>`
			WITH ctx AS (
				SELECT set_config('app.sandbox_id', ${sandboxId}, true),
				       pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))
			),
			blob_insert AS (
				INSERT INTO blobs (sha256, data, size)
				SELECT ${sha256}, ${data}, ${size} FROM ctx
				ON CONFLICT (sha256) DO NOTHING
			),
			new_inode AS (
				INSERT INTO inodes (sandbox_id, kind, mode, size, content_sha256)
				VALUES (${sandboxId}, 1, ${mode}, ${size}, ${sha256})
				RETURNING id
			),
			old_dirent AS (
				SELECT inode_id FROM dirents
				WHERE parent_inode_id = ${String(parentId)} AND name = ${name}
			),
			upserted AS (
				INSERT INTO dirents (parent_inode_id, name, inode_id, sandbox_id)
				SELECT ${String(parentId)}, ${name}, new_inode.id, ${sandboxId}
				FROM new_inode
				ON CONFLICT (parent_inode_id, name) DO UPDATE SET inode_id = EXCLUDED.inode_id
				RETURNING inode_id
			),
			decremented AS (
				UPDATE inodes
				SET nlink = nlink - 1
				FROM old_dirent
				WHERE inodes.id = old_dirent.inode_id
				RETURNING inodes.id, inodes.nlink
			),
			cleaned AS (
				DELETE FROM inodes
				WHERE id IN (SELECT id FROM decremented WHERE nlink <= 0)
			)
			SELECT id AS new_inode_id FROM new_inode
		`;
		const row = rows[0];
		if (!row) throw new Error("writeFileComposite: INSERT returned no rows");
		if (this.#blobCache !== undefined) {
			void this.#blobCache.set(sha256, data);
		}
		return BigInt(row.new_inode_id);
	}

	async mvComposite(
		tx: PgTx,
		sandboxId: string,
		oldParentId: bigint,
		oldName: string,
		newParentId: bigint,
		newName: string,
	): Promise<void> {
		// Audit M10: a single wCTE that both DELETEs the destination dirent and
		// UPDATEs the source dirent into that same (parent_inode_id, name) slot
		// raises a spurious unique_violation (→ EEXIST) — Postgres checks the PK
		// for the UPDATE against a snapshot where the to-be-deleted row still
		// exists. Split into two statements within the SAME transaction: statement
		// 1 frees the destination slot (and cleans its inode), statement 2 renames
		// the source into it. Statement 1's effects are visible to statement 2, so
		// the rename can no longer collide. Atomicity is preserved by the tx.
		await tx`
			WITH ctx AS (
				SELECT set_config('app.sandbox_id', ${sandboxId}, true),
				       pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))
			),
			old_dest AS (
				DELETE FROM dirents
				WHERE parent_inode_id = ${String(newParentId)} AND name = ${newName}
					AND (SELECT 1 FROM ctx) IS NOT NULL
				RETURNING inode_id
			),
			decremented AS (
				UPDATE inodes
				SET nlink = nlink - 1
				FROM old_dest
				WHERE inodes.id = old_dest.inode_id
				RETURNING inodes.id, inodes.nlink
			)
			DELETE FROM inodes
			WHERE id IN (SELECT id FROM decremented WHERE nlink <= 0)
		`;
		const rows = await tx<{ inode_id: string }[]>`
			UPDATE dirents
			SET parent_inode_id = ${String(newParentId)}, name = ${newName}
			WHERE parent_inode_id = ${String(oldParentId)} AND name = ${oldName}
			RETURNING inode_id
		`;
		if (rows.length === 0) throw createEnoent(oldName);
	}

	// ── Private helpers ───────────────────────────────────────────────────────────

	private db(): postgres.Sql {
		if (!this.pool) throw new Error("PostgresDialect: not connected");
		return this.pool;
	}

	// ── Stubs — implemented in subsequent user stories ────────────────────────────

	// US-005
	async createSandbox(tx: PgTx, sandboxId: string, owner = ""): Promise<{ rootInodeId: bigint; createdAt: string }> {
		// 1. Insert sandbox row first (root_inode is NULL initially) to satisfy FK.
		//    RETURNING created_at gives us the DB-generated timestamp for byte-for-byte
		//    agreement between POST response, GET, and LIST.
		const sandboxRows = await tx<{ created_at: Date }[]>`
			INSERT INTO sandboxes (id, root_inode, owner) VALUES (${sandboxId}, NULL, ${owner}) RETURNING created_at
		`;
		const sandboxRow = sandboxRows[0];
		if (!sandboxRow) throw new Error("createSandbox: failed to insert sandbox row");
		const createdAt = sandboxRow.created_at.toISOString();

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

		// 4. Create default directories under root: /home, /tmp, /bin
		const homeInodeId = await this.#createDirInode(tx, sandboxId, rootInodeId, "home");
		await this.#createDirInode(tx, sandboxId, rootInodeId, "tmp");
		await this.#createDirInode(tx, sandboxId, rootInodeId, "bin");

		// 5. Create /home/user under /home
		await this.#createDirInode(tx, sandboxId, homeInodeId, "user");

		return { rootInodeId, createdAt };
	}

	async deleteSandbox(tx: PgTx, sandboxId: string): Promise<void> {
		// Acquire advisory lock before any destructive SQL so in-flight writes
		// (from other replicas or code paths that bypass withSession) serialize first.
		await tx`SELECT pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))`;
		await tx`DELETE FROM sandboxes WHERE id = ${sandboxId}`;
	}

	async sandboxExists(tx: PgTx, sandboxId: string): Promise<boolean> {
		try {
			const rows = await tx<{ exists: boolean }[]>`
				SELECT EXISTS(SELECT 1 FROM sandboxes WHERE id = ${sandboxId}) AS exists
			`;
			return rows[0]?.exists ?? false;
		} catch (err) {
			throw translateSqlError(err, sandboxId);
		}
	}

	async getSandboxMeta(tx: PgTx, sandboxId: string): Promise<SandboxMeta | null> {
		try {
			const rows = await tx<
				{
					owner: string | null;
					name: string | null;
					python: boolean;
					javascript: boolean;
					network: boolean;
					created_at: Date;
				}[]
			>`
				SELECT owner, name, python, javascript, network, created_at FROM sandboxes WHERE id = ${sandboxId}
			`;
			if (rows.length === 0) return null;
			const r = rows[0]!;
			return {
				owner: r.owner,
				name: r.name,
				python: r.python,
				javascript: r.javascript,
				network: r.network,
				createdAt: r.created_at.toISOString(),
			};
		} catch (err) {
			throw translateSqlError(err, sandboxId);
		}
	}

	async updateSandboxMeta(tx: PgTx, sandboxId: string, meta: SandboxMeta): Promise<void> {
		let rows: Array<{ id: string }>;
		try {
			rows = await tx<{ id: string }[]>`
				UPDATE sandboxes
				SET owner = ${meta.owner}, name = ${meta.name}, python = ${meta.python}, javascript = ${meta.javascript}, network = ${meta.network ?? false}
				WHERE id = ${sandboxId}
				RETURNING id
			`;
		} catch (err) {
			throw translateSqlError(err, sandboxId);
		}
		if (rows.length === 0) {
			throw Object.assign(new Error(`ENOENT: sandbox ${sandboxId} not found`), {
				code: "ENOENT",
			});
		}
	}

	async listSandboxes(tx: PgTx, owner?: string): Promise<SandboxListEntry[]> {
		try {
			const rows =
				owner !== undefined
					? await tx<
							{
								id: string;
								name: string | null;
								owner: string | null;
								created_at: Date;
								python: boolean;
								javascript: boolean;
								network: boolean;
							}[]
						>`SELECT id, name, owner, created_at, python, javascript, network FROM sandboxes WHERE owner = ${owner} ORDER BY created_at DESC`
					: await tx<
							{
								id: string;
								name: string | null;
								owner: string | null;
								created_at: Date;
								python: boolean;
								javascript: boolean;
								network: boolean;
							}[]
						>`SELECT id, name, owner, created_at, python, javascript, network FROM sandboxes ORDER BY created_at DESC`;
			return rows.map((r) => ({
				id: r.id,
				name: r.name,
				owner: r.owner,
				createdAt: r.created_at,
				python: r.python,
				javascript: r.javascript,
				network: r.network,
			}));
		} catch (err) {
			throw translateSqlError(err, "listSandboxes");
		}
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
		// Fire-and-forget: don't hold the PG transaction (and the per-sandbox
		// advisory lock acquired in setSandboxContext) open on Redis latency.
		// RedisBlobCache.set() swallows its own errors so this promise cannot
		// reject. Safe under races: blobs are content-addressable and the PG
		// insert is ON CONFLICT DO NOTHING, so a concurrent SET with identical
		// bytes is a no-op.
		if (this.#blobCache !== undefined) {
			void this.#blobCache.set(sha256, data);
		}
	}

	async getBlob(tx: PgTx, sha256: Uint8Array): Promise<Uint8Array | null> {
		if (this.#blobCache !== undefined) {
			const cached = await this.#blobCache.get(sha256);
			if (cached !== null) return cached;
		}
		const rows = await tx<{ data: Buffer }[]>`SELECT data FROM blobs WHERE sha256 = ${sha256}`;
		const data = rows[0]?.data;
		if (!data) return null;
		const bytes = new Uint8Array(data);
		// Fire-and-forget backfill — see upsertBlob. The next reader hits Redis;
		// if the SET hasn't finished yet they pay one more PG round-trip, which
		// is strictly better than holding the advisory lock on every writer.
		if (this.#blobCache !== undefined) {
			void this.#blobCache.set(sha256, bytes);
		}
		return bytes;
	}

	async getBlobNoTx(sha256: Uint8Array): Promise<Uint8Array | null> {
		if (this.#blobCache !== undefined) {
			const cached = await this.#blobCache.get(sha256);
			if (cached !== null) return cached;
		}
		const rows = await this.db()<{ data: Buffer }[]>`
			SELECT data FROM blobs WHERE sha256 = ${sha256}
		`;
		const data = rows[0]?.data;
		if (!data) return null;
		const bytes = new Uint8Array(data);
		if (this.#blobCache !== undefined) {
			void this.#blobCache.set(sha256, bytes);
		}
		return bytes;
	}

	async getBlobsForSandbox(sandboxId: string, maxBytes: number): Promise<Array<{ inodeId: bigint; data: Uint8Array }>> {
		if (maxBytes <= 0) return [];

		// If RLS is later added to `inodes` requiring app.sandbox_id, this query
		// will need to set that context first; today the WHERE filter suffices.
		const metaRows = await this.db()<{ inode_id: string; content_sha256: Buffer; size: string }[]>`
			WITH ranked AS (
				SELECT
					i.id              AS inode_id,
					i.content_sha256  AS content_sha256,
					i.size            AS size,
					SUM(i.size) OVER (ORDER BY i.size ASC, i.id ASC) AS running_total
				FROM inodes i
				WHERE i.sandbox_id = ${sandboxId}
					AND i.kind = ${INODE_KIND.FILE}
					AND i.content_sha256 IS NOT NULL
			)
			SELECT inode_id, content_sha256, size
			FROM ranked
			WHERE running_total <= ${maxBytes}
			ORDER BY size ASC, inode_id ASC
		`;

		if (metaRows.length === 0) return [];

		const shas = metaRows.map((r) => new Uint8Array(r.content_sha256));
		const shaHexes = shas.map((s) => Buffer.from(s).toString("hex"));

		const redisHits =
			this.#blobCache !== undefined
				? await this.#blobCache.mget(shas)
				: (shas.map(() => null) as Array<Uint8Array | null>);

		const missByHex = new Map<string, Uint8Array>();
		for (let i = 0; i < shas.length; i++) {
			if (redisHits[i] === null) missByHex.set(shaHexes[i]!, shas[i]!);
		}

		const pgHits = new Map<string, Uint8Array>();
		if (missByHex.size > 0) {
			const missHexes = [...missByHex.keys()];
			const pgRows = await this.db()<{ sha256: Buffer; data: Buffer }[]>`
				SELECT b.sha256, b.data
				FROM blobs b
				JOIN unnest(${missHexes}::text[]) AS v(sha256_hex)
					ON b.sha256 = decode(v.sha256_hex, 'hex')
			`;
			for (const r of pgRows) {
				const hex = Buffer.from(r.sha256).toString("hex");
				const bytes = new Uint8Array(r.data);
				pgHits.set(hex, bytes);
				// Fire-and-forget Redis backfill — see getBlob.
				if (this.#blobCache !== undefined) {
					const sha = missByHex.get(hex);
					if (sha !== undefined) void this.#blobCache.set(sha, bytes);
				}
			}
		}

		const out: Array<{ inodeId: bigint; data: Uint8Array }> = [];
		for (let i = 0; i < metaRows.length; i++) {
			const bytes = redisHits[i] ?? pgHits.get(shaHexes[i]!);
			if (bytes === undefined) continue; // referential-integrity gap; rare
			out.push({ inodeId: BigInt(metaRows[i]!.inode_id), data: bytes });
		}
		return out;
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
	async bulkIngest(tx: PgTx, files: BulkIngestFile[]): Promise<Map<string, PathCacheEntry>> {
		const result = new Map<string, PathCacheEntry>();
		if (files.length === 0) return result;

		const ctxRows = await tx<{ id: string; root_inode: string }[]>`
			SELECT id, root_inode FROM sandboxes WHERE id = current_setting('app.sandbox_id')
		`;
		const ctxRow = ctxRows[0];
		if (!ctxRow?.root_inode) throw new Error("bulkIngest: sandbox not found or has no root inode");
		const sandboxId = ctxRow.id;
		const rootInodeId = BigInt(ctxRow.root_inode);

		// ── Phase A: resolve/create ancestor directories by depth level ──────────

		const dirMap = new Map<string, bigint>();
		dirMap.set("/", rootInodeId);

		const dirsByDepth = new Map<number, Set<string>>();
		for (const f of files) {
			const parts = f.path.split("/").filter(Boolean);
			for (let i = 1; i < parts.length; i++) {
				const dirPath = `/${parts.slice(0, i).join("/")}`;
				const depth = i;
				let set = dirsByDepth.get(depth);
				if (!set) {
					set = new Set();
					dirsByDepth.set(depth, set);
				}
				set.add(dirPath);
			}
		}
		const sortedDepths = [...dirsByDepth.keys()].sort((a, b) => a - b);

		for (const depth of sortedDepths) {
			const dirsAtDepth = dirsByDepth.get(depth)!;

			const candidates: Array<{
				dirPath: string;
				name: string;
				parentInodeId: bigint;
			}> = [];
			for (const dirPath of dirsAtDepth) {
				if (dirMap.has(dirPath)) continue;
				const parts = dirPath.split("/").filter(Boolean);
				const name = parts[parts.length - 1]!;
				const parentPath = parts.length === 1 ? "/" : `/${parts.slice(0, -1).join("/")}`;
				const parentInodeId = dirMap.get(parentPath);
				if (!parentInodeId) throw new Error(`bulkIngest: parent dir ${parentPath} not found`);
				candidates.push({ dirPath, name, parentInodeId });
			}

			if (candidates.length === 0) continue;

			const checkValues = candidates.map((c) => [String(c.parentInodeId), c.name]);
			const existingRows = await tx<
				{
					parent_inode_id: string;
					name: string;
					inode_id: string;
					kind: number;
				}[]
			>`
				SELECT d.parent_inode_id, d.name, d.inode_id, i.kind
				FROM dirents d
				JOIN inodes i ON i.id = d.inode_id
				JOIN (VALUES ${tx(checkValues)}) AS v(pid, nm)
					ON d.parent_inode_id = v.pid::bigint AND d.name = v.nm
			`;

			const candidateByKey = new Map<string, (typeof candidates)[0]>();
			for (const c of candidates) candidateByKey.set(`${String(c.parentInodeId)}:${c.name}`, c);

			for (const row of existingRows) {
				const match = candidateByKey.get(`${row.parent_inode_id}:${row.name}`);
				if (row.kind !== INODE_KIND.DIRECTORY) {
					throw createEnotdir(match?.dirPath ?? row.name);
				}
				if (match) dirMap.set(match.dirPath, BigInt(row.inode_id));
			}

			const toCreate = candidates.filter((c) => !dirMap.has(c.dirPath));
			if (toCreate.length === 0) continue;

			const dirInodeInserts = toCreate.map((_c) => ({
				sandbox_id: sandboxId,
				kind: INODE_KIND.DIRECTORY,
				mode: 0o755,
				size: 0,
			}));
			const createdDirInodes = await tx<{ id: string; mtime: string }[]>`
				INSERT INTO inodes ${tx(dirInodeInserts)} RETURNING id, mtime
			`;

			const dirDirentInserts = toCreate.map((c, i) => ({
				parent_inode_id: String(c.parentInodeId),
				name: c.name,
				inode_id: createdDirInodes[i]!.id,
				sandbox_id: sandboxId,
			}));
			await tx`INSERT INTO dirents ${tx(dirDirentInserts)}`;

			for (let i = 0; i < toCreate.length; i++) {
				const c = toCreate[i]!;
				const row = createdDirInodes[i]!;
				const inodeId = BigInt(row.id);
				dirMap.set(c.dirPath, inodeId);
				result.set(c.dirPath, {
					inodeId,
					kind: INODE_KIND.DIRECTORY,
					mode: 0o755,
					size: 0,
					mtime: new Date(row.mtime),
					contentSha256: null,
					symlinkTarget: null,
				});
			}
		}

		// ── Phase B: detect existing file dirents for overwrite handling ──────────

		const filesWithHash = files.map((f) => {
			const parts = f.path.split("/").filter(Boolean);
			const name = parts[parts.length - 1]!;
			const parentPath = parts.length === 1 ? "/" : `/${parts.slice(0, -1).join("/")}`;
			return {
				path: f.path,
				content: f.content,
				mode: f.mode,
				sha256: Buffer.from(createHash("sha256").update(f.content).digest()),
				name,
				parentPath,
				parentInodeId: dirMap.get(parentPath)!,
			};
		});

		const fileCheckValues = filesWithHash.map((f) => [String(f.parentInodeId), f.name]);
		const existingFileDirents = await tx<
			{
				parent_inode_id: string;
				name: string;
				inode_id: string;
				kind: number;
			}[]
		>`
			SELECT d.parent_inode_id, d.name, d.inode_id, i.kind
			FROM dirents d
			JOIN inodes i ON i.id = d.inode_id
			JOIN (VALUES ${tx(fileCheckValues)}) AS v(pid, nm)
				ON d.parent_inode_id = v.pid::bigint AND d.name = v.nm
		`;

		const existingFileMap = new Map<string, bigint>();
		for (const row of existingFileDirents) {
			if (row.kind === INODE_KIND.DIRECTORY) {
				const match = filesWithHash.find((f) => String(f.parentInodeId) === row.parent_inode_id && f.name === row.name);
				throw createEisdir(match?.path ?? row.name);
			}
			existingFileMap.set(`${row.parent_inode_id}:${row.name}`, BigInt(row.inode_id));
		}

		// ── Phase C: bulk insert blobs ────────────────────────────────────────────

		const uniqueBlobs = new Map<string, { sha256: Buffer; data: Uint8Array; size: number }>();
		for (const f of filesWithHash) {
			const key = f.sha256.toString("hex");
			if (!uniqueBlobs.has(key)) {
				uniqueBlobs.set(key, {
					sha256: f.sha256,
					data: f.content,
					size: f.content.length,
				});
			}
		}
		if (uniqueBlobs.size > 0) {
			const blobRows = [...uniqueBlobs.values()];
			await tx`INSERT INTO blobs ${tx(blobRows)} ON CONFLICT (sha256) DO NOTHING`;
		}

		// ── Phase D: bulk insert file inodes ─────────────────────────────────────

		const inodeInserts = filesWithHash.map((f) => ({
			sandbox_id: sandboxId,
			kind: INODE_KIND.FILE,
			mode: f.mode,
			size: f.content.length,
			content_sha256: f.sha256,
		}));
		const insertedInodes = await tx<{ id: string; mtime: string }[]>`
			INSERT INTO inodes ${tx(inodeInserts)} RETURNING id, mtime
		`;

		// ── Phase E: link dirents — upsert for overwrites, clean up old inodes ───

		const toUpdate: Array<[string, string, string]> = [];
		const oldInodeIds: bigint[] = [];
		const toInsert: Array<{
			parent_inode_id: string;
			name: string;
			inode_id: string;
			sandbox_id: string;
		}> = [];

		for (let i = 0; i < filesWithHash.length; i++) {
			const f = filesWithHash[i]!;
			const newInodeId = insertedInodes[i]!.id;
			const key = `${String(f.parentInodeId)}:${f.name}`;
			const oldInodeId = existingFileMap.get(key);

			if (oldInodeId !== undefined) {
				toUpdate.push([String(f.parentInodeId), f.name, newInodeId]);
				oldInodeIds.push(oldInodeId);
			} else {
				toInsert.push({
					parent_inode_id: String(f.parentInodeId),
					name: f.name,
					inode_id: newInodeId,
					sandbox_id: sandboxId,
				});
			}
		}

		if (toUpdate.length > 0) {
			await tx`
				UPDATE dirents d
				SET inode_id = v.new_id::bigint
				FROM (VALUES ${tx(toUpdate)}) AS v(pid, nm, new_id)
				WHERE d.parent_inode_id = v.pid::bigint AND d.name = v.nm
			`;
			// Count occurrences of each old inode — hardlinks may cause duplicates
			const nlinkDecrements = new Map<string, number>();
			for (const id of oldInodeIds) {
				const key = String(id);
				nlinkDecrements.set(key, (nlinkDecrements.get(key) ?? 0) + 1);
			}
			const decrementValues = [...nlinkDecrements.entries()].map(([id, cnt]) => [id, String(cnt)]);
			await tx`
				UPDATE inodes i
				SET nlink = i.nlink - v.cnt::int
				FROM (VALUES ${tx(decrementValues)}) AS v(inode_id, cnt)
				WHERE i.id = v.inode_id::bigint
			`;
			const oldIdStrings = [...nlinkDecrements.keys()];
			await tx`DELETE FROM inodes WHERE id IN ${tx(oldIdStrings)} AND nlink <= 0`;
		}

		if (toInsert.length > 0) {
			await tx`INSERT INTO dirents ${tx(toInsert)}`;
		}

		// ── Phase F: build result cache entries from INSERT RETURNING data ────────

		for (let i = 0; i < filesWithHash.length; i++) {
			const f = filesWithHash[i]!;
			const row = insertedInodes[i]!;
			result.set(f.path, {
				inodeId: BigInt(row.id),
				kind: INODE_KIND.FILE,
				mode: f.mode,
				size: f.content.length,
				mtime: new Date(row.mtime),
				contentSha256: f.sha256,
				symlinkTarget: null,
			});
		}

		return result;
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
