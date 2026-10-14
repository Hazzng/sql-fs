import type { BulkIngestFile, SqlDialect } from "../../types.js";
import type { CoherentView } from "../coherent-view.js";
import type { ScriptPersistence } from "../script-persistence.js";
import type { ContentChange, NamespacePolicy, PathChange } from "../types.js";

export type IngestQueries<Tx> = Pick<SqlDialect<Tx>, "bulkIngest">;
export type IngestView<Tx> = Pick<CoherentView<Tx>, "epoch" | "get" | "publishMutation">;
export type IngestPersistence<Tx> = Pick<ScriptPersistence<Tx>, "buffering" | "write">;

export type IngestPolicy = Pick<NamespacePolicy, "assertWritable">;

export async function bulkIngest<Tx>(
	sandboxId: string,
	dialect: IngestQueries<Tx>,
	view: IngestView<Tx>,
	persistence: IngestPersistence<Tx>,
	policy: IngestPolicy,
	normalized: BulkIngestFile[],
): Promise<void> {
	const paths: PathChange[] = [];
	const contents: ContentChange[] = [];
	policy.assertWritable("/", "bulkIngest");
	// #166: deliberately NOT buffered, and unreachable inside a scope today — both
	// call sites (`POST /ingest/files`, MCP `ingest_files`) go straight at the
	// session, never through `runInScriptTx`. Buffering it would mean predicting the
	// dialect's DB-derived ancestor resolution in JS and holding every ingested byte
	// in the journal, which is the one memory cost this design exists to avoid. It is
	// also already one short transaction of its own, so it is not a #166 exposure.
	// If it is ever composed into a scope, fail loudly rather than silently splitting
	// the script into two commits.
	if (persistence.buffering) {
		throw Object.assign(new Error("bulkIngest: not supported inside a buffered script scope — call it outside exec"), {
			code: "ENOTSUP",
		});
	}
	const bytesByPath = new Map<string, Uint8Array>();
	for (const file of normalized) {
		bytesByPath.set(file.path, file.content);
	}
	const receipt = await persistence.write(view, (tx, replay) =>
		dialect.bulkIngest(tx, normalized, sandboxId, replay.expectedEpoch),
	);
	const newEntries = receipt.value;
	for (const [path, entry] of newEntries) {
		const old = view.get(path);
		if (old !== undefined && old.inodeId !== entry.inodeId) {
			contents.push({ kind: "evict", inodeId: old.inodeId });
		}
		paths.push({ kind: "set", path, entry });
		const bytes = bytesByPath.get(path);
		if (bytes !== undefined && bytes.byteLength > 0) {
			contents.push({ kind: "put", inodeId: entry.inodeId, bytes });
		}
	}
	view.publishMutation(receipt, paths, contents);
}
