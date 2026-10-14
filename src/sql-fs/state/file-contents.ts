import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import { runTrustedDbAsync } from "../defense.js";
import { raceDriverFault } from "../driver-fault.js";
import type { PathCacheEntry, SqlDialect } from "../types.js";
export class FileContents {
	#contentGeneration = 0;

	readonly #contentCache: LRUCache<bigint, Uint8Array>;

	#prewarmInFlight: Promise<void> | undefined;

	#prewarmQueued = false;

	readonly #blobs: Pick<SqlDialect<unknown>, "getBlobNoTx" | "getBlobsForSandbox">;

	readonly #sandboxId: string;

	readonly #readBlob: (sha: Uint8Array) => Promise<Uint8Array | null>;

	#entries: ReadonlyMap<string, PathCacheEntry> = new Map();

	#isCurrent: (path: string, entry: PathCacheEntry) => boolean = () => false;

	constructor(
		blobs: Pick<SqlDialect<unknown>, "getBlobNoTx" | "getBlobsForSandbox">,
		sandboxId: string,
		cap: number,
		readBlob: (sha: Uint8Array) => Promise<Uint8Array | null>,
	) {
		this.#blobs = blobs;
		this.#sandboxId = sandboxId;
		this.#readBlob = readBlob;
		this.#contentCache = new LRUCache({ maxSize: cap, sizeCalculation: (value) => value.byteLength });
	}

	#startPrewarm(queueIfRunning = false): void {
		if (this.#prewarmInFlight !== undefined) {
			if (queueIfRunning) this.#prewarmQueued = true;
			return;
		}
		const generation = this.#contentGeneration;
		const entries = new Map([...this.#entries].map(([path, entry]) => [entry.inodeId, { path, entry }]));
		const cap = this.#contentCache.maxSize;
		const task = (async (): Promise<void> => {
			try {
				const blobs = await raceDriverFault(() =>
					runTrustedDbAsync(() => this.#blobs.getBlobsForSandbox(this.#sandboxId, cap)),
				);
				for (const { inodeId, data } of blobs) {
					const captured = entries.get(inodeId);
					const entry = captured?.entry;
					if (generation !== this.#contentGeneration || entry?.contentSha256 == null) continue;
					if (!Buffer.from(entry.contentSha256).equals(createHash("sha256").update(data).digest())) continue;
					if (captured === undefined || this.#entries.get(captured.path) !== entry) continue;
					if (data.byteLength > 0) this.#contentCache.set(inodeId, data);
				}
				console.log(JSON.stringify({ event: "content_prewarm_ok", sandboxId: this.#sandboxId, entries: blobs.length }));
			} catch (err) {
				console.error(
					JSON.stringify({
						event: "content_prewarm_error",
						sandboxId: this.#sandboxId,
						error: (err as Error).message,
					}),
				);
			} finally {
				this.#prewarmInFlight = undefined;
				if (this.#prewarmQueued) {
					this.#prewarmQueued = false;
					this.#startPrewarm();
				}
			}
		})();
		this.#prewarmInFlight = task;
	}

	installView(
		entries: ReadonlyMap<string, PathCacheEntry>,
		isCurrent: (path: string, entry: PathCacheEntry) => boolean,
	): void {
		this.#entries = entries;
		this.#isCurrent = isCurrent;
		this.#contentGeneration++;
		this.#contentCache.clear();
		this.#startPrewarm(true);
	}

	evict(inodeId: bigint): void {
		this.#contentCache.delete(inodeId);
	}

	put(inodeId: bigint, bytes: Uint8Array): void {
		this.#contentCache.set(inodeId, bytes);
	}

	remap(ids: ReadonlyMap<bigint, bigint>): void {
		for (const [provisional, real] of ids) {
			const bytes = this.#contentCache.get(provisional);
			this.#contentCache.delete(provisional);
			if (bytes !== undefined) this.#contentCache.set(real, bytes);
		}
	}

	_getCache(): LRUCache<bigint, Uint8Array> {
		return this.#contentCache;
	}

	async read(path: string, entry: PathCacheEntry): Promise<Uint8Array> {
		const generation = this.#contentGeneration;
		const cached = this.#contentCache.get(entry.inodeId);
		if (cached !== undefined) return cached;

		if (this.#prewarmInFlight !== undefined) {
			await this.#prewarmInFlight;
			const afterPrewarm = this.#contentCache.get(entry.inodeId);
			if (generation === this.#contentGeneration && this.#isCurrent(path, entry) && afterPrewarm !== undefined)
				return afterPrewarm;
		}

		// `blobs` is global (no RLS), so a transaction wrapper is unnecessary.
		const data = await this.#readBlob(entry.contentSha256!);
		const bytes = data ?? new Uint8Array(0);
		if (generation === this.#contentGeneration && this.#isCurrent(path, entry) && bytes.byteLength > 0)
			this.#contentCache.set(entry.inodeId, bytes);
		return bytes;
	}
}
