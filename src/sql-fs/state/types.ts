import type { PathCacheEntry } from "../types.js";

export interface EpochAuthority {
	readonly epoch: bigint;
}

export interface ReplayContext {
	readonly expectedEpoch: bigint;
	resolveInodeId(id: bigint): bigint;
}

export interface MutationSpec<Tx> {
	readonly kind: string;
	readonly composite: boolean;
	readonly mints?: number;
	readonly bytes?: number;
	readonly supersedes?: string;
	run(tx: Tx, replay: ReplayContext): Promise<readonly (bigint | undefined)[]>;
}

export type Publication =
	| { readonly kind: "recorded" | "transactionLocal" }
	| { readonly kind: "committed"; readonly epoch: bigint };
export type MutationReceipt<T> = Publication & { readonly value: T };
export type ScopeSettlement =
	| { readonly kind: "unchanged" }
	| {
			readonly kind: "committed";
			readonly epoch: bigint;
			readonly inodeRemap: ReadonlyMap<bigint, bigint> | undefined;
	  }
	| { readonly kind: "failed"; readonly error: unknown; readonly reloadRequired: boolean };
export interface ScopeStamp {
	readonly generation: number;
	readonly active: boolean;
}
export type PathChange =
	| { readonly kind: "set"; readonly path: string; readonly entry: PathCacheEntry }
	| { readonly kind: "delete"; readonly path: string }
	| { readonly kind: "patchInode"; readonly inodeId: bigint; readonly patch: Partial<PathCacheEntry> };
export type ContentChange =
	| { readonly kind: "evict"; readonly inodeId: bigint }
	| { readonly kind: "put"; readonly inodeId: bigint; readonly bytes: Uint8Array };

export const PER_MUTATION_BASE_BYTES = 200;
export interface NamespacePolicy {
	assertWritable(path: string, operation: string): void;
	assertWriteSize(path: string, bytes: number): void;
	chargeAppendInput(path: string, bytes: number): void;
	assertSymlink(target: string, path: string): void;
}
