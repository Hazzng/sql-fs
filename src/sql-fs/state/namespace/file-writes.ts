import { createHash } from "node:crypto";

import { createEisdir } from "../../errors.js";
import { INODE_KIND, type SqlDialect } from "../../types.js";
import type { CoherentView } from "../coherent-view.js";
import type { ScriptPersistence } from "../script-persistence.js";
import {
	type ContentChange,
	type MutationSpec,
	type NamespacePolicy,
	PER_MUTATION_BASE_BYTES,
	type PathChange,
} from "../types.js";

const NEW_FILE_MODE = 0o644;
export type FileWriteQueries<Tx> = Pick<
	SqlDialect<Tx>,
	| "writeFileComposite"
	| "commitBlob"
	| "upsertBlob"
	| "createInode"
	| "upsertDirent"
	| "decrementNlink"
	| "deleteInode"
	| "getBlob"
>;
export type FileWriteView<Tx> = Pick<CoherentView<Tx>, "epoch" | "get" | "requireParent" | "publishMutation">;
export type FileWritePersistence<Tx> = Pick<
	ScriptPersistence<Tx>,
	"buffering" | "captureGeneration" | "assertGeneration" | "guarded" | "mutateOne" | "readForAppend"
>;

function blobArgFor<Tx>(
	dialect: FileWriteQueries<Tx>,
	persistence: FileWritePersistence<Tx>,
	bytes: Uint8Array,
): Uint8Array | undefined {
	if (bytes.byteLength === 0 && dialect.writeFileComposite && dialect.commitBlob) return undefined;
	return persistence.buffering && dialect.commitBlob !== undefined ? undefined : bytes;
}

function putFileOp<Tx>(
	sandboxId: string,
	dialect: FileWriteQueries<Tx>,
	kind: "writeFile" | "appendFile",
	parentInodeId: bigint,
	name: string,
	mode: number,
	size: number,
	sha256: Uint8Array,
	blobBytes: Uint8Array | undefined,
): Omit<MutationSpec<Tx>, "mints"> {
	const supersedes = `${parentInodeId}:${name}`;
	if (dialect.writeFileComposite) {
		return {
			kind,
			composite: true,
			supersedes,
			run: async (tx, replay) => [
				await dialect.writeFileComposite!(
					tx,
					sandboxId,
					replay.resolveInodeId(parentInodeId),
					name,
					mode,
					size,
					sha256,
					blobBytes,
					replay.expectedEpoch,
				),
			],
		};
	}
	return {
		kind,
		composite: false,
		supersedes,
		// Only reachable on a dialect without `commitBlob`, where `blobBytes` is the
		// content and the journal must carry it because the insert is part of the replay.
		bytes: PER_MUTATION_BASE_BYTES + (blobBytes?.byteLength ?? 0),
		run: async (tx, replay) => {
			if (!dialect.commitBlob) await dialect.upsertBlob(tx, sha256, blobBytes!);
			const id = await dialect.createInode(
				tx,
				{ sandboxId, kind: INODE_KIND.FILE, mode, size, contentSha256: sha256 },
				replay.expectedEpoch,
			);
			const oldInodeId = await dialect.upsertDirent(tx, replay.resolveInodeId(parentInodeId), name, id);
			if (oldInodeId !== null) {
				const newNlink = await dialect.decrementNlink(tx, oldInodeId);
				if (newNlink === 0) await dialect.deleteInode(tx, oldInodeId);
			}
			return [id];
		},
	};
}

export type FileWritePolicy = Pick<NamespacePolicy, "assertWritable" | "assertWriteSize" | "chargeAppendInput">;

export async function writeFile<Tx>(
	sandboxId: string,
	dialect: FileWriteQueries<Tx>,
	view: FileWriteView<Tx>,
	persistence: FileWritePersistence<Tx>,
	policy: FileWritePolicy,
	path: string,
	bytes: Uint8Array,
	createMode: number | undefined,
): Promise<void> {
	const paths: PathChange[] = [];
	const contents: ContentChange[] = [];
	const scopeGeneration = persistence.captureGeneration();
	policy.assertWritable(path, "writeFile");
	// Refuse to clobber an existing directory with a file (audit H2 #13). This
	// also rejects writing to "/" (the root is a directory), closing #25.
	if (view.get(path)?.kind === INODE_KIND.DIRECTORY) throw createEisdir(path);
	const { name, parentEntry } = view.requireParent(path);

	policy.assertWriteSize(path, bytes.byteLength);
	const sha256 = new Uint8Array(createHash("sha256").update(bytes).digest());
	const mtime = new Date();

	// F6: commit the CAS blob in its own short tx FIRST, so the composite
	// (which runs on the long-lived script-tx) no longer holds the hot-blob
	// tuple lock for the script duration.
	//
	// #169 M4: this is a root-`sql` statement and it runs BEFORE `ScriptPersistence` reaches
	// `assertAlive`, so a condemned scope would still put it on the wire — the exact
	// hazard the sticky scope verdict exists to prevent. Assert first, and route it through `guarded` so a
	// fault during the blob write is raced (it never settles on its own) and condemns the scope.
	persistence.assertGeneration(scopeGeneration);
	// An empty file needs no blob row (readers map a missing blob to empty bytes), and
	// just-bash 3.6 truncates every `>` target with one before writing the output.
	if (dialect.commitBlob && bytes.byteLength > 0) {
		await persistence.guarded(() => dialect.commitBlob!(sha256, bytes));
	}
	persistence.assertGeneration(scopeGeneration);

	// The write replaces the inode; carry the old file's mode onto the new one, as
	// overwriting a file in place does.
	const prior = view.get(path);
	const mode = createMode ?? (prior?.kind === INODE_KIND.FILE ? prior.mode : NEW_FILE_MODE);
	const receipt = await persistence.mutateOne(
		view,
		putFileOp(
			sandboxId,
			dialect,
			"writeFile",
			parentEntry.inodeId,
			name,
			mode,
			bytes.length,
			sha256,
			blobArgFor(dialect, persistence, bytes),
		),
	);
	const inodeId = receipt.value;

	// Evict the displaced inode's bytes from contentCache so the dead entry
	// (ids are never reused) is not left as orphaned LRU weight. This must run
	// before the `set` below, and crucially also when overwriting with an empty
	// file — where there is no overwriting `set` to displace the old entry.
	const displaced = view.get(path);
	if (displaced !== undefined && displaced.inodeId !== inodeId) {
		contents.push({ kind: "evict", inodeId: displaced.inodeId });
	}
	paths.push({
		kind: "set",
		path,
		entry: {
			inodeId,
			kind: INODE_KIND.FILE,
			mode,
			size: bytes.length,
			mtime,
			contentSha256: sha256,
			symlinkTarget: null,
		},
	});
	if (bytes.byteLength > 0) contents.push({ kind: "put", inodeId, bytes });
	view.publishMutation(receipt, paths, contents);
}

export async function appendFile<Tx>(
	sandboxId: string,
	dialect: FileWriteQueries<Tx>,
	view: FileWriteView<Tx>,
	persistence: FileWritePersistence<Tx>,
	policy: FileWritePolicy,
	path: string,
	bytes: Uint8Array,
): Promise<void> {
	const paths: PathChange[] = [];
	const contents: ContentChange[] = [];
	const scopeGeneration = persistence.captureGeneration();
	policy.assertWritable(path, "appendFile");
	// Refuse to clobber an existing directory (audit H2 #13); also rejects "/".
	if (view.get(path)?.kind === INODE_KIND.DIRECTORY) throw createEisdir(path);

	const mtime = new Date();

	const existing = view.get(path);
	// Appending nothing changes nothing. just-bash 3.6 pre-opens every `>>` target with
	// an empty append, which would otherwise read and rewrite the whole file.
	if (bytes.byteLength === 0 && existing?.kind === INODE_KIND.FILE) return;
	// The resulting size, not the appended chunk: `appendFile` materializes base+chunk in
	// one buffer, and a file grown past the cap by repeated appends would then be unreadable
	// from the same script. Checked off the cached size so the base blob is never fetched.
	const appendedTotal = (existing?.kind === INODE_KIND.FILE ? existing.size : 0) + bytes.byteLength;
	policy.assertWriteSize(path, appendedTotal);
	let fullBytes: Uint8Array;

	if (existing && existing.kind === INODE_KIND.FILE && existing.contentSha256 !== null) {
		policy.chargeAppendInput(path, existing.size);
		// Buffered: there is no script-tx to read consistently with, and there are no
		// in-flight inode mutations to be consistent WITH — the blob is content-addressed
		// and already committed — so take the lock-free read transaction instead of
		// opening a writer transaction that would span the rest of the script.
		const oldContent = await persistence.readForAppend(view, async (tx) =>
			dialect.getBlob(tx, existing.contentSha256!),
		);
		const base = oldContent ?? new Uint8Array(0);
		const merged = new Uint8Array(base.length + bytes.length);
		merged.set(base, 0);
		merged.set(bytes, base.length);
		fullBytes = merged;
	} else {
		fullBytes = bytes;
	}

	const sha256 = new Uint8Array(createHash("sha256").update(fullBytes).digest());
	const { name, parentEntry } = view.requireParent(path);

	// F6: commit the CAS blob in its own short tx FIRST (see writeFile), under the same
	// liveness assert and the same driver-fault race (#169 M4).
	persistence.assertGeneration(scopeGeneration);
	if (dialect.commitBlob && fullBytes.byteLength > 0) {
		await persistence.guarded(() => dialect.commitBlob!(sha256, fullBytes));
	}
	persistence.assertGeneration(scopeGeneration);

	const mode = existing?.kind === INODE_KIND.FILE ? existing.mode : NEW_FILE_MODE;
	const receipt = await persistence.mutateOne(
		view,
		putFileOp(
			sandboxId,
			dialect,
			"appendFile",
			parentEntry.inodeId,
			name,
			mode,
			fullBytes.length,
			sha256,
			blobArgFor(dialect, persistence, fullBytes),
		),
	);
	const inodeId = receipt.value;

	if (existing) contents.push({ kind: "evict", inodeId: existing.inodeId });
	if (fullBytes.byteLength > 0) contents.push({ kind: "put", inodeId, bytes: fullBytes });
	paths.push({
		kind: "set",
		path,
		entry: {
			inodeId,
			kind: INODE_KIND.FILE,
			mode,
			size: fullBytes.length,
			mtime,
			contentSha256: sha256,
			symlinkTarget: null,
		},
	});
	view.publishMutation(receipt, paths, contents);
}
