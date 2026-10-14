import type postgres from "postgres";
import { runTrustedDbAsync } from "../../defense.js";
import type { RedisBlobCache } from "../../redis-blob-cache.js";
import { INODE_KIND } from "../../types.js";
import type { BlobOperations, PgTx } from "./types.js";

export interface BlobBatchRow {
	readonly sha256: Uint8Array;
	readonly data: Uint8Array;
	readonly size: number;
}

export class PostgresBlobs implements BlobOperations {
	readonly #blobCache: RedisBlobCache | undefined;
	constructor(
		private readonly db: () => postgres.Sql,
		blobCache?: RedisBlobCache,
	) {
		this.#blobCache = blobCache;
	}
	backfill(sha256: Uint8Array, data: Uint8Array): void {
		if (this.#blobCache !== undefined) void this.#blobCache.set(sha256, data);
	}
	async commitBatch(blobRows: BlobBatchRow[]): Promise<void> {
		const db = this.db();
		await runTrustedDbAsync(
			() => db`INSERT INTO blobs ${db(blobRows)} ON CONFLICT (sha256) DO UPDATE SET last_referenced_at = now()`,
		);
		if (this.#blobCache !== undefined) {
			for (const b of blobRows) void this.#blobCache.set(new Uint8Array(b.sha256), b.data);
		}
	}
	async upsertBlob(tx: PgTx, sha256: Uint8Array, data: Uint8Array): Promise<void> {
		await tx`
			INSERT INTO blobs (sha256, data, size)
			VALUES (${sha256}, ${data}, ${data.length})
			ON CONFLICT (sha256) DO UPDATE SET last_referenced_at = now()
		`;
		// Fire-and-forget: don't hold the PG transaction (and the per-sandbox
		// advisory lock acquired in setSandboxContext) open on Redis latency.
		// RedisBlobCache.set() swallows its own errors so this promise cannot
		// reject. Safe under races: blobs are content-addressable and the PG
		// insert is ON CONFLICT DO UPDATE (touch-only — it bumps
		// last_referenced_at but never rewrites data/size), so a concurrent SET
		// with identical bytes is a no-op.
		if (this.#blobCache !== undefined) {
			void this.#blobCache.set(sha256, data);
		}
	}

	async commitBlob(sha256: Uint8Array, data: Uint8Array): Promise<void> {
		// Self-committing single-statement INSERT on its OWN pool connection — no
		// surrounding BEGIN, no advisory lock, no sandbox context (`blobs` is
		// unscoped CAS). The `ON CONFLICT DO UPDATE` tuple lock on a hot blob is
		// thus released at statement COMMIT instead of being pinned to the
		// long-lived script-tx, which is the F6 fix. The touch is unconditional so
		// the GC grace window protects this blob until its referencing inode
		// commits in the following composite tx.
		await runTrustedDbAsync(
			() => this.db()`
				INSERT INTO blobs (sha256, data, size)
				VALUES (${sha256}, ${data}, ${data.length})
				ON CONFLICT (sha256) DO UPDATE SET last_referenced_at = now()
			`,
		);
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

	async gcOrphanBlobs(tx: PgTx, minAgeMs: number): Promise<Uint8Array[]> {
		const rows = await tx<{ sha256: Buffer }[]>`
			DELETE FROM blobs b
			WHERE NOT EXISTS (
				SELECT 1 FROM inodes i WHERE i.content_sha256 = b.sha256 AND i.nlink > 0
			)
			AND (
				b.last_referenced_at IS NULL
				OR b.last_referenced_at < now() - (${minAgeMs} * interval '1 millisecond')
			)
			RETURNING b.sha256
		`;
		return rows.map((r) => new Uint8Array(r.sha256));
	}
}
