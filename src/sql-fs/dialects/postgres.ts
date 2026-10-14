import postgres from "postgres";
import { runTrustedDbAsync } from "../defense.js";
import type { RedisBlobCache } from "../redis-blob-cache.js";
import type { SqlDialect, TransactionOptions } from "../types.js";
import { PostgresBlobs } from "./postgres/blobs.js";
import { bulkIngest } from "./postgres/ingest.js";
import { PostgresNamespace } from "./postgres/namespace.js";
import { PostgresSandbox } from "./postgres/sandbox.js";
import type { BlobOperations, NamespaceOperations, PgTx, SandboxOperations } from "./postgres/types.js";

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export class PostgresDialect implements SqlDialect<PgTx> {
	private pool: postgres.Sql | null = null;
	private readonly connectionString: string;
	readonly #poolMax: number | undefined;
	private readonly blobs: PostgresBlobs;
	private readonly sandbox = new PostgresSandbox();
	private readonly namespace: PostgresNamespace;
	constructor(connectionString: string, blobCache?: RedisBlobCache, poolMax?: number) {
		this.connectionString = connectionString;
		this.#poolMax = poolMax;
		this.blobs = new PostgresBlobs(() => this.db(), blobCache);
		this.namespace = new PostgresNamespace(this.blobs);
	}
	async connect(): Promise<void> {
		// Bound the pool: each PostgresDialect instance is owned by one warm
		// session, so a tiny `max` is sufficient. Without these caps a runaway
		// session could exhaust the upstream Postgres connection limit
		// (especially Neon, where pooler endpoints have small per-tenant caps).
		const max = this.#poolMax ?? envInt("PG_POOL_MAX", 2);
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

	async transaction<T>(fn: (tx: PgTx) => Promise<T>, opts?: TransactionOptions): Promise<T> {
		if (opts?.isolationLevel !== undefined) {
			// `postgres` passes this string after BEGIN, e.g. BEGIN ISOLATION LEVEL REPEATABLE READ.
			return this.db().begin(`isolation level ${opts.isolationLevel}`, fn) as Promise<T>;
		}
		return this.db().begin(fn) as Promise<T>;
	}

	private db(): postgres.Sql {
		if (!this.pool) throw new Error("PostgresDialect: not connected");
		return this.pool;
	}

	upsertBlob(...args: Parameters<BlobOperations["upsertBlob"]>): ReturnType<BlobOperations["upsertBlob"]> {
		return this.blobs.upsertBlob(...args);
	}

	commitBlob(...args: Parameters<BlobOperations["commitBlob"]>): ReturnType<BlobOperations["commitBlob"]> {
		return this.blobs.commitBlob(...args);
	}

	getBlob(...args: Parameters<BlobOperations["getBlob"]>): ReturnType<BlobOperations["getBlob"]> {
		return this.blobs.getBlob(...args);
	}

	getBlobNoTx(...args: Parameters<BlobOperations["getBlobNoTx"]>): ReturnType<BlobOperations["getBlobNoTx"]> {
		return this.blobs.getBlobNoTx(...args);
	}

	getBlobsForSandbox(
		...args: Parameters<BlobOperations["getBlobsForSandbox"]>
	): ReturnType<BlobOperations["getBlobsForSandbox"]> {
		return this.blobs.getBlobsForSandbox(...args);
	}

	gcOrphanBlobs(...args: Parameters<BlobOperations["gcOrphanBlobs"]>): ReturnType<BlobOperations["gcOrphanBlobs"]> {
		return this.blobs.gcOrphanBlobs(...args);
	}

	setSandboxContext(
		...args: Parameters<SandboxOperations["setSandboxContext"]>
	): ReturnType<SandboxOperations["setSandboxContext"]> {
		return this.sandbox.setSandboxContext(...args);
	}

	setSandboxContextWithLock(
		...args: Parameters<SandboxOperations["setSandboxContextWithLock"]>
	): ReturnType<SandboxOperations["setSandboxContextWithLock"]> {
		return this.sandbox.setSandboxContextWithLock(...args);
	}

	getSandboxEpoch(
		...args: Parameters<SandboxOperations["getSandboxEpoch"]>
	): ReturnType<SandboxOperations["getSandboxEpoch"]> {
		return this.sandbox.getSandboxEpoch(...args);
	}

	retireSandboxGeneration(
		...args: Parameters<SandboxOperations["retireSandboxGeneration"]>
	): ReturnType<SandboxOperations["retireSandboxGeneration"]> {
		return this.sandbox.retireSandboxGeneration(...args);
	}

	createSandbox(
		...args: Parameters<SandboxOperations["createSandbox"]>
	): ReturnType<SandboxOperations["createSandbox"]> {
		return this.sandbox.createSandbox(...args);
	}

	deleteSandbox(
		...args: Parameters<SandboxOperations["deleteSandbox"]>
	): ReturnType<SandboxOperations["deleteSandbox"]> {
		return this.sandbox.deleteSandbox(...args);
	}

	sandboxExists(
		...args: Parameters<SandboxOperations["sandboxExists"]>
	): ReturnType<SandboxOperations["sandboxExists"]> {
		return this.sandbox.sandboxExists(...args);
	}

	getSandboxMeta(
		...args: Parameters<SandboxOperations["getSandboxMeta"]>
	): ReturnType<SandboxOperations["getSandboxMeta"]> {
		return this.sandbox.getSandboxMeta(...args);
	}

	updateSandboxMeta(
		...args: Parameters<SandboxOperations["updateSandboxMeta"]>
	): ReturnType<SandboxOperations["updateSandboxMeta"]> {
		return this.sandbox.updateSandboxMeta(...args);
	}

	updateSandboxRuntime(
		...args: Parameters<PostgresSandbox["updateSandboxRuntime"]>
	): ReturnType<PostgresSandbox["updateSandboxRuntime"]> {
		return this.sandbox.updateSandboxRuntime(...args);
	}

	listSandboxes(
		...args: Parameters<SandboxOperations["listSandboxes"]>
	): ReturnType<SandboxOperations["listSandboxes"]> {
		return this.sandbox.listSandboxes(...args);
	}

	mkdirComposite(
		...args: Parameters<NamespaceOperations["mkdirComposite"]>
	): ReturnType<NamespaceOperations["mkdirComposite"]> {
		return this.namespace.mkdirComposite(...args);
	}

	rmComposite(...args: Parameters<NamespaceOperations["rmComposite"]>): ReturnType<NamespaceOperations["rmComposite"]> {
		return this.namespace.rmComposite(...args);
	}

	writeFileComposite(
		...args: Parameters<NamespaceOperations["writeFileComposite"]>
	): ReturnType<NamespaceOperations["writeFileComposite"]> {
		return this.namespace.writeFileComposite(...args);
	}

	mvComposite(...args: Parameters<NamespaceOperations["mvComposite"]>): ReturnType<NamespaceOperations["mvComposite"]> {
		return this.namespace.mvComposite(...args);
	}

	createInode(...args: Parameters<NamespaceOperations["createInode"]>): ReturnType<NamespaceOperations["createInode"]> {
		return this.namespace.createInode(...args);
	}

	getInode(...args: Parameters<NamespaceOperations["getInode"]>): ReturnType<NamespaceOperations["getInode"]> {
		return this.namespace.getInode(...args);
	}

	updateInode(...args: Parameters<NamespaceOperations["updateInode"]>): ReturnType<NamespaceOperations["updateInode"]> {
		return this.namespace.updateInode(...args);
	}

	deleteInode(...args: Parameters<NamespaceOperations["deleteInode"]>): ReturnType<NamespaceOperations["deleteInode"]> {
		return this.namespace.deleteInode(...args);
	}

	incrementNlink(
		...args: Parameters<NamespaceOperations["incrementNlink"]>
	): ReturnType<NamespaceOperations["incrementNlink"]> {
		return this.namespace.incrementNlink(...args);
	}

	decrementNlink(
		...args: Parameters<NamespaceOperations["decrementNlink"]>
	): ReturnType<NamespaceOperations["decrementNlink"]> {
		return this.namespace.decrementNlink(...args);
	}

	insertDirent(
		...args: Parameters<NamespaceOperations["insertDirent"]>
	): ReturnType<NamespaceOperations["insertDirent"]> {
		return this.namespace.insertDirent(...args);
	}

	upsertDirent(
		...args: Parameters<NamespaceOperations["upsertDirent"]>
	): ReturnType<NamespaceOperations["upsertDirent"]> {
		return this.namespace.upsertDirent(...args);
	}

	deleteDirent(
		...args: Parameters<NamespaceOperations["deleteDirent"]>
	): ReturnType<NamespaceOperations["deleteDirent"]> {
		return this.namespace.deleteDirent(...args);
	}

	listDirents(...args: Parameters<NamespaceOperations["listDirents"]>): ReturnType<NamespaceOperations["listDirents"]> {
		return this.namespace.listDirents(...args);
	}

	moveDirent(...args: Parameters<NamespaceOperations["moveDirent"]>): ReturnType<NamespaceOperations["moveDirent"]> {
		return this.namespace.moveDirent(...args);
	}

	loadAllPaths(
		...args: Parameters<NamespaceOperations["loadAllPaths"]>
	): ReturnType<NamespaceOperations["loadAllPaths"]> {
		return this.namespace.loadAllPaths(...args);
	}

	loadSubtreeInodes(
		...args: Parameters<NamespaceOperations["loadSubtreeInodes"]>
	): ReturnType<NamespaceOperations["loadSubtreeInodes"]> {
		return this.namespace.loadSubtreeInodes(...args);
	}

	resolvePath(...args: Parameters<NamespaceOperations["resolvePath"]>): ReturnType<NamespaceOperations["resolvePath"]> {
		return this.namespace.resolvePath(...args);
	}

	bulkIngest(...args: Parameters<SqlDialect<PgTx>["bulkIngest"]>): ReturnType<SqlDialect<PgTx>["bulkIngest"]> {
		return bulkIngest(args[0], args[1], args[2], args[3], this.blobs);
	}
}
