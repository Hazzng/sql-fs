import type { IFileSystem } from "just-bash";
import { createPostgresSandboxFs, destroyPostgresSandbox } from "../../sql-fs/index.js";
import type { RedisBlobCache } from "../../sql-fs/redis-blob-cache.js";
import type { ScriptTxBufferConfig } from "../../sql-fs/script-tx-buffer.js";
import type { SandboxListEntry, SandboxMeta } from "../../sql-fs/types.js";
import type { RuntimeOptions } from "../session-runtime/engine.js";
import type { TenantConfig } from "../tenants.js";

export interface TenantBackendsOptions {
	readonly scriptTxBuffer?: ScriptTxBufferConfig;
	readonly postgresPoolMax?: number;
	readonly tenantConfig?: TenantConfig;
	readonly createFs?: (tenantId: string, sandboxId: string) => Promise<IFileSystem>;
	readonly destroySandboxFn?: (tenantId: string, sandboxId: string) => Promise<void>;
	readonly blobCacheFactory?: (tenantId: string) => RedisBlobCache | undefined;
	readonly getSandboxMetaFn?: (tenantId: string, sandboxId: string) => Promise<SandboxMeta | null>;
	readonly persistSandboxMetaFn?: (tenantId: string, sandboxId: string, meta: SandboxMeta) => Promise<void>;
	readonly updateSandboxRuntimeFn?: (
		tenantId: string,
		sandboxId: string,
		runtime: Partial<RuntimeOptions>,
	) => Promise<SandboxMeta | null>;
	readonly listSandboxesFn?: (tenantId: string, owner?: string) => Promise<SandboxListEntry[]>;
}

/** Per-tenant lazy Postgres backend state. */
interface PerTenantBackend {
	readonly connectionString: string;
	readonly blobCache: RedisBlobCache | undefined;
}

export class TenantBackends {
	private readonly backends = new Map<string, PerTenantBackend>();
	constructor(
		private readonly options: TenantBackendsOptions,
		private readonly workers: boolean,
	) {}

	connectionString(tenantId: string): string {
		return this.getOrInitBackend(tenantId).connectionString;
	}

	private getOrInitBackend(tenantId: string): PerTenantBackend {
		const existing = this.backends.get(tenantId);
		if (existing !== undefined) return existing;
		if (this.options.tenantConfig === undefined) {
			throw Object.assign(
				new Error(
					`SessionManager: tenantConfig required to resolve tenant "${tenantId}" (no createFs override configured)`,
				),
				{ code: "EINVAL" as const },
			);
		}
		const connectionString = this.options.tenantConfig.getConnectionString(tenantId);
		const backend: PerTenantBackend = {
			connectionString,
			blobCache: !this.workers ? this.options.blobCacheFactory?.(tenantId) : undefined,
		};
		this.backends.set(tenantId, backend);
		return backend;
	}

	async createFs(
		tenantId: string,
		sandboxId: string,
		owner = "",
		openExisting = false,
	): Promise<{ fs: IFileSystem; resolvedOwner: string; createdAt: string }> {
		if (this.options.createFs !== undefined) {
			return {
				fs: await this.options.createFs(tenantId, sandboxId),
				resolvedOwner: owner,
				createdAt: new Date().toISOString(),
			};
		}
		const backend = this.getOrInitBackend(tenantId);
		return createPostgresSandboxFs(
			{
				connectionString: backend.connectionString,
				poolMax: this.options.postgresPoolMax,
				scriptTxBuffer: this.options.scriptTxBuffer,
				tenantId,
				blobCache: backend.blobCache,
				openExisting,
			},
			sandboxId,
			owner,
		);
	}

	async persistMeta(tenantId: string, sandboxId: string, meta: SandboxMeta): Promise<void> {
		if (this.options.persistSandboxMetaFn !== undefined) {
			await this.options.persistSandboxMetaFn(tenantId, sandboxId, meta);
		}
	}

	async getMeta(tenantId: string, sandboxId: string): Promise<SandboxMeta | null> {
		if (this.options.getSandboxMetaFn === undefined) return null;
		return this.options.getSandboxMetaFn(tenantId, sandboxId);
	}

	async list(tenantId: string, owner?: string): Promise<SandboxListEntry[]> {
		if (this.options.listSandboxesFn === undefined) {
			throw Object.assign(new Error("listSandboxes not configured"), { code: "ENOTSUP" });
		}
		return this.options.listSandboxesFn(tenantId, owner);
	}

	async updateRuntime(
		tenantId: string,
		sandboxId: string,
		runtime: Partial<RuntimeOptions>,
	): Promise<SandboxMeta | null> {
		if (this.options.updateSandboxRuntimeFn === undefined) {
			throw Object.assign(new Error("updateSandboxRuntime not configured"), { code: "ENOTSUP" });
		}
		const meta = await this.options.updateSandboxRuntimeFn(tenantId, sandboxId, runtime);
		return meta;
	}

	async destroy(tenantId: string, sandboxId: string): Promise<void> {
		if (this.options.destroySandboxFn !== undefined) return this.options.destroySandboxFn(tenantId, sandboxId);
		if (this.options.tenantConfig === undefined) return;
		await destroyPostgresSandbox(this.connectionString(tenantId), sandboxId);
	}
}
