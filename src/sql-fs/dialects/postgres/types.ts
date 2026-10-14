import type postgres from "postgres";
import type { SqlDialect } from "../../types.js";

export type PgTx = postgres.TransactionSql;

export type BlobOperations = Required<
	Pick<
		SqlDialect<PgTx>,
		"upsertBlob" | "commitBlob" | "getBlob" | "getBlobNoTx" | "getBlobsForSandbox" | "gcOrphanBlobs"
	>
>;
export type SandboxOperations = Required<
	Pick<
		SqlDialect<PgTx>,
		| "setSandboxContext"
		| "setSandboxContextWithLock"
		| "getSandboxEpoch"
		| "retireSandboxGeneration"
		| "createSandbox"
		| "deleteSandbox"
		| "sandboxExists"
		| "getSandboxMeta"
		| "updateSandboxMeta"
		| "listSandboxes"
	>
>;
export type NamespaceOperations = Required<
	Pick<
		SqlDialect<PgTx>,
		| "mkdirComposite"
		| "rmComposite"
		| "writeFileComposite"
		| "mvComposite"
		| "createInode"
		| "getInode"
		| "updateInode"
		| "deleteInode"
		| "incrementNlink"
		| "decrementNlink"
		| "insertDirent"
		| "upsertDirent"
		| "deleteDirent"
		| "listDirents"
		| "moveDirent"
		| "loadAllPaths"
		| "loadSubtreeInodes"
		| "resolvePath"
	>
>;
