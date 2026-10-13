import { createEnoent, createEstale, translateSqlError } from "../../errors.js";
import type { CreateInodeOpts, DirentRow, InodeKind, InodeRow, PathCacheEntry, UpdateInodeOpts } from "../../types.js";
import type { PostgresBlobs } from "./blobs.js";
import { epochParam, fenceAndAdvance, takeWriterLock } from "./sandbox.js";
import type { NamespaceOperations, PgTx } from "./types.js";

export class PostgresNamespace implements NamespaceOperations {
	constructor(private readonly blobs: Pick<PostgresBlobs, "backfill">) {}
	async mkdirComposite(
		tx: PgTx,
		sandboxId: string,
		parentId: bigint,
		name: string,
		mode: number,
		expectedEpoch?: bigint,
	): Promise<bigint> {
		await takeWriterLock(tx, sandboxId);
		const rows = await tx<{ fenced: number; id: string | null }[]>`
			WITH ctx AS (
				SELECT set_config('app.sandbox_id', ${sandboxId}, true),
				       pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0)),
				       s.version AS epoch
				FROM sandboxes s
				WHERE s.id = ${sandboxId}
				  AND (
					s.version = COALESCE(
						${epochParam(expectedEpoch)}::bigint,
						NULLIF(current_setting('app.sandbox_epoch', true), '')::bigint,
						s.version
					)
					OR (
						${epochParam(expectedEpoch)}::bigint IS NOT NULL
						AND s.version > ${epochParam(expectedEpoch)}::bigint
						AND s.version = NULLIF(current_setting('app.sandbox_epoch', true), '')::bigint
					)
				  )
			),
			advanced AS (
				UPDATE sandboxes s
				SET version = s.version + 1
				FROM ctx
				WHERE s.id = ${sandboxId}
				RETURNING s.version
			),
			epoch AS (
				SELECT set_config('app.sandbox_epoch', version::text, true) FROM advanced
			),
			new_inode AS (
				INSERT INTO inodes (sandbox_id, kind, mode, size)
				SELECT ${sandboxId}, 2, ${mode}, 0 FROM epoch
				RETURNING id
			),
			inserted AS (
				INSERT INTO dirents (parent_inode_id, name, inode_id, sandbox_id)
				SELECT ${String(parentId)}, ${name}, new_inode.id, ${sandboxId}
				FROM new_inode
				RETURNING inode_id AS id
			)
			SELECT (SELECT count(*) FROM epoch)::int AS fenced, (SELECT id FROM inserted) AS id
			FROM sandboxes WHERE id = ${sandboxId}
		`;
		const row = rows[0];
		if (row?.fenced === 0) throw createEstale(sandboxId);
		if (!row || row.id === null) throw new Error("mkdirComposite: INSERT returned no rows");
		return BigInt(row.id);
	}

	async rmComposite(
		tx: PgTx,
		sandboxId: string,
		parentId: bigint,
		name: string,
		expectedEpoch?: bigint,
	): Promise<bigint> {
		await takeWriterLock(tx, sandboxId);
		const rows = await tx<{ fenced: number; removed_inode_id: string | null }[]>`
			WITH ctx AS (
				SELECT set_config('app.sandbox_id', ${sandboxId}, true),
				       pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0)),
				       s.version AS epoch
				FROM sandboxes s
				WHERE s.id = ${sandboxId}
				  AND (
					s.version = COALESCE(
						${epochParam(expectedEpoch)}::bigint,
						NULLIF(current_setting('app.sandbox_epoch', true), '')::bigint,
						s.version
					)
					OR (
						${epochParam(expectedEpoch)}::bigint IS NOT NULL
						AND s.version > ${epochParam(expectedEpoch)}::bigint
						AND s.version = NULLIF(current_setting('app.sandbox_epoch', true), '')::bigint
					)
				  )
			),
			advanced AS (
				UPDATE sandboxes s
				SET version = s.version + 1
				FROM ctx
				WHERE s.id = ${sandboxId}
				RETURNING s.version
			),
			epoch AS (
				SELECT set_config('app.sandbox_epoch', version::text, true) FROM advanced
			),
			removed_dirent AS (
				DELETE FROM dirents
				WHERE parent_inode_id = ${String(parentId)} AND name = ${name}
					AND (SELECT 1 FROM epoch) IS NOT NULL
				RETURNING inode_id
			),
			-- Delete and decrement are split into two mutually-exclusive CTEs
			-- (by the snapshot nlink) so each inode row is touched exactly once.
			-- Postgres applies ONLY the UPDATE when a row is both updated and deleted
			-- in one statement, which would leave an nlink=0 inode tombstone that
			-- still references content_sha256 and pins its blob against GC.
			deleted_inode AS (
				DELETE FROM inodes
				WHERE id IN (SELECT inode_id FROM removed_dirent)
					AND nlink <= 1
			),
			decremented AS (
				UPDATE inodes
				SET nlink = nlink - 1
				WHERE id IN (SELECT inode_id FROM removed_dirent)
					AND nlink > 1
			)
			SELECT (SELECT count(*) FROM epoch)::int AS fenced,
			       (SELECT inode_id FROM removed_dirent) AS removed_inode_id
			FROM sandboxes WHERE id = ${sandboxId}
		`;
		const row = rows[0];
		if (row?.fenced === 0) throw createEstale(sandboxId);
		if (!row || row.removed_inode_id === null) throw createEnoent(name);
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
		data?: Uint8Array,
		expectedEpoch?: bigint,
	): Promise<bigint> {
		// F6: the CAS blob is committed by `commitBlob` in its own short tx BEFORE
		// this composite runs, so there is no `blob_insert` CTE here — the
		// script-tx must not hold the hot-blob `ON CONFLICT DO UPDATE` tuple lock.
		await takeWriterLock(tx, sandboxId);
		const rows = await tx<{ fenced: number; new_inode_id: string | null }[]>`
			WITH ctx AS (
				SELECT set_config('app.sandbox_id', ${sandboxId}, true),
				       pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0)),
				       s.version AS epoch
				FROM sandboxes s
				WHERE s.id = ${sandboxId}
				  AND (
					s.version = COALESCE(
						${epochParam(expectedEpoch)}::bigint,
						NULLIF(current_setting('app.sandbox_epoch', true), '')::bigint,
						s.version
					)
					OR (
						${epochParam(expectedEpoch)}::bigint IS NOT NULL
						AND s.version > ${epochParam(expectedEpoch)}::bigint
						AND s.version = NULLIF(current_setting('app.sandbox_epoch', true), '')::bigint
					)
				  )
			),
			advanced AS (
				UPDATE sandboxes s
				SET version = s.version + 1
				FROM ctx
				WHERE s.id = ${sandboxId}
				RETURNING s.version
			),
			epoch AS (
				SELECT set_config('app.sandbox_epoch', version::text, true) FROM advanced
			),
			new_inode AS (
				INSERT INTO inodes (sandbox_id, kind, mode, size, content_sha256)
				SELECT ${sandboxId}, 1, ${mode}, ${size}, ${sha256} FROM epoch
				RETURNING id
			),
			old_dirent AS (
				SELECT inode_id FROM dirents
				WHERE parent_inode_id = ${String(parentId)} AND name = ${name}
				  AND (SELECT 1 FROM ctx) IS NOT NULL
			),
			upserted AS (
				INSERT INTO dirents (parent_inode_id, name, inode_id, sandbox_id)
				SELECT ${String(parentId)}, ${name}, new_inode.id, ${sandboxId}
				FROM new_inode
				ON CONFLICT (parent_inode_id, name) DO UPDATE SET inode_id = EXCLUDED.inode_id
				RETURNING inode_id
			),
			-- Drop the replaced inode in two mutually-exclusive statements (see
			-- rmComposite): a combined update+delete of the same row applies only
			-- the UPDATE, leaving an nlink=0 tombstone that pins the old blob.
			deleted_old_inode AS (
				DELETE FROM inodes
				WHERE id IN (SELECT inode_id FROM old_dirent)
					AND nlink <= 1
			),
			decremented AS (
				UPDATE inodes
				SET nlink = nlink - 1
				WHERE id IN (SELECT inode_id FROM old_dirent)
					AND nlink > 1
			)
			SELECT (SELECT count(*) FROM epoch)::int AS fenced, (SELECT id FROM new_inode) AS new_inode_id
			FROM sandboxes WHERE id = ${sandboxId}
		`;
		const row = rows[0];
		if (row?.fenced === 0) throw createEstale(sandboxId);
		if (!row || row.new_inode_id === null) throw new Error("writeFileComposite: INSERT returned no rows");
		// Omitted `data` means the caller already backfilled (see the interface note).
		if (data !== undefined) this.blobs.backfill(sha256, data);
		return BigInt(row.new_inode_id);
	}

	async mvComposite(
		tx: PgTx,
		sandboxId: string,
		oldParentId: bigint,
		oldName: string,
		newParentId: bigint,
		newName: string,
		expectedEpoch?: bigint,
	): Promise<void> {
		// Audit M10: a single wCTE that both DELETEs the destination dirent and
		// UPDATEs the source dirent into that same (parent_inode_id, name) slot
		// raises a spurious unique_violation (→ EEXIST) — Postgres checks the PK
		// for the UPDATE against a snapshot where the to-be-deleted row still
		// exists. Split into two statements within the SAME transaction: statement
		// 1 frees the destination slot (and cleans its inode), statement 2 renames
		// the source into it. Statement 1's effects are visible to statement 2, so
		// the rename can no longer collide. Atomicity is preserved by the tx.
		// Both statements fence and advance the version; the tx-local epoch
		// refresh in SqlFs absorbs the double bump.
		await takeWriterLock(tx, sandboxId);
		const destinationRows = await tx<{ fenced: number }[]>`
			WITH ctx AS (
				SELECT set_config('app.sandbox_id', ${sandboxId}, true),
				       pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0)),
				       s.version AS epoch
				FROM sandboxes s
				WHERE s.id = ${sandboxId}
				  AND (
					s.version = COALESCE(
						${epochParam(expectedEpoch)}::bigint,
						NULLIF(current_setting('app.sandbox_epoch', true), '')::bigint,
						s.version
					)
					OR (
						${epochParam(expectedEpoch)}::bigint IS NOT NULL
						AND s.version > ${epochParam(expectedEpoch)}::bigint
						AND s.version = NULLIF(current_setting('app.sandbox_epoch', true), '')::bigint
					)
				  )
			),
			advanced AS (
				UPDATE sandboxes s
				SET version = s.version + 1
				FROM ctx
				WHERE s.id = ${sandboxId}
				RETURNING s.version
			),
			epoch AS (
				SELECT set_config('app.sandbox_epoch', version::text, true) FROM advanced
			),
			old_dest AS (
				DELETE FROM dirents
				WHERE parent_inode_id = ${String(newParentId)} AND name = ${newName}
					AND (SELECT 1 FROM epoch) IS NOT NULL
				RETURNING inode_id
			),
			-- Split delete/decrement by snapshot nlink so the overwritten
			-- destination inode is touched exactly once (see rmComposite): a
			-- combined update+delete applies only the UPDATE, leaving an nlink=0
			-- tombstone that pins the destination's old blob against GC.
			deleted_dest_inode AS (
				DELETE FROM inodes
				WHERE id IN (SELECT inode_id FROM old_dest)
					AND nlink <= 1
			),
			decremented AS (
				UPDATE inodes
				SET nlink = nlink - 1
				WHERE id IN (SELECT inode_id FROM old_dest)
					AND nlink > 1
			)
			SELECT (SELECT count(*) FROM epoch)::int AS fenced
			FROM sandboxes WHERE id = ${sandboxId}
			`;
		if (destinationRows[0]?.fenced === 0) throw createEstale(sandboxId);
		if (!destinationRows[0]) throw createEnoent(oldName);
		// Re-take for snapshot ordering; re-entrant within this tx.
		await takeWriterLock(tx, sandboxId);
		const rows = await tx<{ fenced: number; inode_id: string | null }[]>`
			WITH ctx AS (
				SELECT set_config('app.sandbox_id', ${sandboxId}, true),
				       pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0)),
				       s.version AS epoch
				FROM sandboxes s
				WHERE s.id = ${sandboxId}
				  AND (
					s.version = COALESCE(
						${epochParam(expectedEpoch)}::bigint,
						NULLIF(current_setting('app.sandbox_epoch', true), '')::bigint,
						s.version
					)
					OR (
						${epochParam(expectedEpoch)}::bigint IS NOT NULL
						AND s.version > ${epochParam(expectedEpoch)}::bigint
						AND s.version = NULLIF(current_setting('app.sandbox_epoch', true), '')::bigint
					)
				  )
			),
			advanced AS (
				UPDATE sandboxes s
				SET version = s.version + 1
				FROM ctx
				WHERE s.id = ${sandboxId}
				RETURNING s.version
			),
			epoch AS (
				SELECT set_config('app.sandbox_epoch', version::text, true) FROM advanced
			),
			moved AS (
				UPDATE dirents
				SET parent_inode_id = ${String(newParentId)}, name = ${newName}
				WHERE parent_inode_id = ${String(oldParentId)} AND name = ${oldName}
				  AND (SELECT 1 FROM epoch) IS NOT NULL
				RETURNING inode_id
			)
			SELECT (SELECT count(*) FROM epoch)::int AS fenced, (SELECT inode_id FROM moved) AS inode_id
			FROM sandboxes WHERE id = ${sandboxId}
		`;
		const row = rows[0];
		if (row?.fenced === 0) throw createEstale(sandboxId);
		if (!row || row.inode_id === null) throw createEnoent(oldName);
	}

	async createInode(tx: PgTx, opts: CreateInodeOpts, expectedEpoch?: bigint): Promise<bigint> {
		const rows = await tx<{ fenced: number; id: string | null }[]>`
			WITH ${fenceAndAdvance(tx, opts.sandboxId, expectedEpoch)},
			inserted AS (
				INSERT INTO inodes (sandbox_id, kind, mode, size, content_sha256, symlink_target)
				SELECT ${opts.sandboxId}, ${opts.kind}, ${opts.mode}, ${opts.size}, ${opts.contentSha256 ?? null}, ${opts.symlinkTarget ?? null}
				FROM epoch
				RETURNING id
			)
			SELECT (SELECT count(*) FROM epoch)::int AS fenced, (SELECT id FROM inserted) AS id
		`;
		const row = rows[0];
		if (!row) throw new Error("createInode: INSERT returned no rows");
		if (row.fenced === 0) throw createEstale(opts.sandboxId);
		if (row.id === null) throw new Error("createInode: INSERT returned no rows");
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

	async updateInode(
		tx: PgTx,
		inodeId: bigint,
		updates: UpdateInodeOpts,
		sandboxId: string,
		expectedEpoch?: bigint,
	): Promise<void> {
		const patch: Record<string, string | number | Date | Uint8Array | null> = Object.create(null);
		if (updates.mode !== undefined) patch.mode = updates.mode;
		if (updates.size !== undefined) patch.size = updates.size;
		if (updates.mtime !== undefined) patch.mtime = updates.mtime;
		if ("contentSha256" in updates) patch.content_sha256 = updates.contentSha256 ?? null;

		// No patch is no mutation: bumping here would advance the epoch for a no-op.
		if (Object.keys(patch).length === 0) return;

		const rows = await tx<{ fenced: number }[]>`
			WITH ${fenceAndAdvance(tx, sandboxId, expectedEpoch)},
			updated AS (
				UPDATE inodes SET ${tx(patch)}
				WHERE id = ${String(inodeId)} AND (SELECT 1 FROM epoch) IS NOT NULL
			)
			SELECT (SELECT count(*) FROM epoch)::int AS fenced
		`;
		// A missing inode stays a silent no-op, as before; only the fence throws.
		if (rows[0]?.fenced === 0) throw createEstale(sandboxId);
	}

	async deleteInode(tx: PgTx, inodeId: bigint): Promise<void> {
		await tx`DELETE FROM inodes WHERE id = ${String(inodeId)}`;
	}

	async incrementNlink(tx: PgTx, inodeId: bigint, sandboxId: string, expectedEpoch?: bigint): Promise<void> {
		const rows = await tx<{ fenced: number }[]>`
			WITH ${fenceAndAdvance(tx, sandboxId, expectedEpoch)},
			bumped AS (
				UPDATE inodes SET nlink = nlink + 1
				WHERE id = ${String(inodeId)} AND (SELECT 1 FROM epoch) IS NOT NULL
			)
			SELECT (SELECT count(*) FROM epoch)::int AS fenced
		`;
		if (rows[0]?.fenced === 0) throw createEstale(sandboxId);
	}

	async decrementNlink(tx: PgTx, inodeId: bigint): Promise<number> {
		const rows = await tx<{ nlink: number }[]>`
			UPDATE inodes SET nlink = nlink - 1 WHERE id = ${String(inodeId)} RETURNING nlink
		`;
		const row = rows[0];
		if (!row) throw new Error(`decrementNlink: inode ${inodeId} not found`);
		return row.nlink;
	}

	async insertDirent(tx: PgTx, parentId: bigint, name: string, inodeId: bigint): Promise<void> {
		await tx`
			INSERT INTO dirents (parent_inode_id, name, inode_id, sandbox_id)
			SELECT ${String(parentId)}, ${name}, ${String(inodeId)}, sandbox_id
			FROM inodes
			WHERE id = ${String(parentId)}
		`;
	}

	async upsertDirent(tx: PgTx, parentId: bigint, name: string, inodeId: bigint): Promise<bigint | null> {
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

	async deleteDirent(
		tx: PgTx,
		parentId: bigint,
		name: string,
		sandboxId: string,
		expectedEpoch?: bigint,
	): Promise<bigint> {
		const rows = await tx<{ fenced: number; inode_id: string | null }[]>`
			WITH ${fenceAndAdvance(tx, sandboxId, expectedEpoch)},
			removed AS (
				DELETE FROM dirents
				WHERE parent_inode_id = ${String(parentId)} AND name = ${name}
					AND (SELECT 1 FROM epoch) IS NOT NULL
				RETURNING inode_id
			)
			SELECT (SELECT count(*) FROM epoch)::int AS fenced, (SELECT inode_id FROM removed) AS inode_id
		`;
		const row = rows[0];
		if (row?.fenced === 0) throw createEstale(sandboxId);
		if (!row || row.inode_id === null) throw createEnoent(name);
		return BigInt(row.inode_id);
	}

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

	async moveDirent(
		tx: PgTx,
		oldParentId: bigint,
		oldName: string,
		newParentId: bigint,
		newName: string,
		sandboxId: string,
		expectedEpoch?: bigint,
	): Promise<void> {
		// DELETE and UPDATE cannot share one WITH: data-modifying CTEs see the same
		// snapshot, so the UPDATE would unique-conflict on a dest that still exists.
		// Fence the DELETE first; the UPDATE only runs after the pin is accepted.
		const fenced = await tx<{ fenced: number }[]>`
			WITH ${fenceAndAdvance(tx, sandboxId, expectedEpoch)},
			cleared AS (
				DELETE FROM dirents
				WHERE parent_inode_id = ${String(newParentId)} AND name = ${newName}
					AND (SELECT 1 FROM epoch) IS NOT NULL
			)
			SELECT (SELECT count(*) FROM epoch)::int AS fenced
		`;
		if (fenced[0]?.fenced === 0) throw createEstale(sandboxId);

		const moved = await tx<{ inode_id: string }[]>`
			UPDATE dirents
			SET parent_inode_id = ${String(newParentId)}, name = ${newName}
			WHERE parent_inode_id = ${String(oldParentId)} AND name = ${oldName}
			RETURNING inode_id
		`;
		if (!moved[0]) throw createEnoent(oldName);
	}

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
