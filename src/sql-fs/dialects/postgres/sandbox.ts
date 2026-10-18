import type postgres from "postgres";
import { createEnoent, translateSqlError } from "../../errors.js";
import type { SandboxGeneration, SandboxListEntry, SandboxMeta } from "../../types.js";
import type { PgTx, SandboxOperations } from "./types.js";

type FenceContext = "existing" | "composite";

export async function takeWriterLock(tx: PgTx, sandboxId: string): Promise<void> {
	await tx`SELECT pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))`;
}

export function fenceAndAdvance(
	tx: PgTx,
	sandboxId: string,
	expectedEpoch?: bigint,
): postgres.PendingQuery<postgres.Row[]> {
	return fenceCtes(tx, sandboxId, expectedEpoch, "existing");
}

export function compositeFenceAndAdvance(
	tx: PgTx,
	sandboxId: string,
	expectedEpoch?: bigint,
): postgres.PendingQuery<postgres.Row[]> {
	return fenceCtes(tx, sandboxId, expectedEpoch, "composite");
}

function fenceCtes(
	tx: PgTx,
	sandboxId: string,
	expectedEpoch: bigint | undefined,
	context: FenceContext,
): postgres.PendingQuery<postgres.Row[]> {
	const epoch = expectedEpoch === undefined ? null : String(expectedEpoch);
	const projection =
		context === "existing"
			? tx`s.version`
			: tx`set_config('app.sandbox_id', ${sandboxId}, true),
			       pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0)),
			       s.version AS epoch`;
	return tx`
			ctx AS (
				SELECT ${projection}
				FROM sandboxes s
				WHERE s.id = ${sandboxId}
				  AND (
					s.version = COALESCE(
						${epoch}::bigint,
						NULLIF(current_setting('app.sandbox_epoch', true), '')::bigint,
						s.version
					)
					OR (
						${epoch}::bigint IS NOT NULL
						AND s.version > ${epoch}::bigint
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
			)
		`;
}

export class PostgresSandbox implements SandboxOperations {
	async setSandboxContext(tx: PgTx, sandboxId: string): Promise<void> {
		// RLS context only — no advisory lock. Read-only paths (cold-start load,
		// cache reload) use this to avoid serializing against unrelated writers.
		await tx`SELECT set_config('app.sandbox_id', ${sandboxId}, true)`;
	}

	async setSandboxContextWithLock(tx: PgTx, sandboxId: string): Promise<void> {
		await takeWriterLock(tx, sandboxId);
		const rows = await tx<{ epoch: string }[]>`
			SELECT set_config('app.sandbox_id', ${sandboxId}, true),
			       set_config('app.sandbox_epoch', s.version::text, true),
			       s.version AS epoch
			FROM sandboxes s
			WHERE s.id = ${sandboxId}
		`;
		// Fake tx handles resolve non-arrays; zero rows on a real conn means gone.
		if (Array.isArray(rows) && rows.length === 0) throw createEnoent(sandboxId);
	}

	async getSandboxEpoch(tx: PgTx, sandboxId: string): Promise<bigint> {
		const rows = await tx<{ version: string }[]>`
			SELECT version FROM sandboxes WHERE id = ${sandboxId}
		`;
		const row = rows[0];
		if (row === undefined) throw createEnoent(sandboxId);
		return BigInt(row.version);
	}

	async retireSandboxGeneration(
		tx: PgTx,
		sandboxId: string,
		assertOwnerLease?: () => void,
	): Promise<SandboxGeneration> {
		await this.setSandboxContextWithLock(tx, sandboxId);
		assertOwnerLease?.();
		const rows = await tx<{ prior_epoch: string; version: string }[]>`
			UPDATE sandboxes SET version = version + 1
			WHERE id = ${sandboxId}
			RETURNING version - 1 AS prior_epoch, version
		`;
		const row = rows[0];
		if (row === undefined) throw createEnoent(sandboxId);
		return { priorEpoch: BigInt(row.prior_epoch), epoch: BigInt(row.version) };
	}

	async createSandbox(
		tx: PgTx,
		sandboxId: string,
		owner = "",
	): Promise<{ rootInodeId: bigint; createdAt: string; epoch: bigint }> {
		// Serialize lifecycle transitions with all composite writers. The first
		// incarnation starts at zero; every recreation advances the tombstone.
		await tx`SELECT pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))`;
		const epochRows = await tx<{ epoch: string }[]>`
			INSERT INTO sandbox_epochs (sandbox_id, epoch)
			VALUES (${sandboxId}, 0)
			ON CONFLICT (sandbox_id) DO UPDATE
			SET epoch = sandbox_epochs.epoch + 1, deleted_at = NOW()
			RETURNING epoch
		`;
		const epochRow = epochRows[0];
		if (!epochRow) throw new Error("createSandbox: failed to allocate epoch");
		const epoch = BigInt(epochRow.epoch);

		const sandboxRows = await tx<{ created_at: Date }[]>`
			INSERT INTO sandboxes (id, root_inode, owner, version)
			VALUES (${sandboxId}, NULL, ${owner}, ${String(epoch)}) RETURNING created_at
		`;
		const sandboxRow = sandboxRows[0];
		if (!sandboxRow) throw new Error("createSandbox: failed to insert sandbox row");
		const createdAt = sandboxRow.created_at.toISOString();

		const rootRows = await tx<{ id: string }[]>`
			INSERT INTO inodes (sandbox_id, kind, mode, size, nlink)
			VALUES (${sandboxId}, 2, ${0o755}, 0, 1)
			RETURNING id
		`;
		const rootRow = rootRows[0];
		if (!rootRow) throw new Error("createSandbox: failed to create root inode");
		const rootInodeId = BigInt(rootRow.id);

		await tx`UPDATE sandboxes SET root_inode = ${String(rootInodeId)} WHERE id = ${sandboxId}`;

		const homeInodeId = await this.#createDirInode(tx, sandboxId, rootInodeId, "home");
		await this.#createDirInode(tx, sandboxId, rootInodeId, "tmp");
		await this.#createDirInode(tx, sandboxId, rootInodeId, "bin");
		await this.#createDirInode(tx, sandboxId, homeInodeId, "user");

		return { rootInodeId, createdAt, epoch };
	}

	async deleteSandbox(tx: PgTx, sandboxId: string): Promise<bigint> {
		await tx`SELECT pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))`;
		const rows = await tx<{ epoch: string }[]>`
			WITH deleted AS (
				DELETE FROM sandboxes
				WHERE id = ${sandboxId}
				RETURNING id, version
			), tombstone AS (
				INSERT INTO sandbox_epochs (sandbox_id, epoch)
				SELECT id, version + 1 FROM deleted
				ON CONFLICT (sandbox_id) DO UPDATE
				SET epoch = GREATEST(sandbox_epochs.epoch, EXCLUDED.epoch), deleted_at = NOW()
				RETURNING epoch
			)
			SELECT epoch FROM tombstone
			UNION ALL
			SELECT epoch FROM sandbox_epochs
			WHERE sandbox_id = ${sandboxId} AND NOT EXISTS (SELECT 1 FROM tombstone)
		`;
		return BigInt(rows[0]?.epoch ?? 0);
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

	async updateSandboxRuntime(
		tx: PgTx,
		sandboxId: string,
		runtime: Partial<Pick<SandboxMeta, "python" | "javascript" | "network">>,
	): Promise<SandboxMeta | null> {
		try {
			await takeWriterLock(tx, sandboxId);
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
				UPDATE sandboxes
				SET python = COALESCE(${runtime.python ?? null}::boolean, python),
					javascript = COALESCE(${runtime.javascript ?? null}::boolean, javascript),
					network = COALESCE(${runtime.network ?? null}::boolean, network),
					version = version + 1
				WHERE id = ${sandboxId}
				RETURNING owner, name, python, javascript, network, created_at
			`;
			const r = rows[0];
			if (r === undefined) return null;
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
}
