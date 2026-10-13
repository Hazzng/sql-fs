import { createHash } from "node:crypto";
import { createEisdir, createEnotdir, createEstale } from "../../errors.js";
import { type BulkIngestFile, INODE_KIND, type PathCacheEntry } from "../../types.js";
import type { PostgresBlobs } from "./blobs.js";
import { fenceAndAdvance } from "./sandbox.js";
import type { PgTx } from "./types.js";

export async function bulkIngest(
	tx: PgTx,
	files: BulkIngestFile[],
	sandboxId: string,
	expectedEpoch: bigint | undefined,
	blobs: Pick<PostgresBlobs, "commitBatch">,
): Promise<Map<string, PathCacheEntry>> {
	const result = new Map<string, PathCacheEntry>();
	if (files.length === 0) return result;

	const ctxRows = await tx<{ root_inode: string | null; fenced: number }[]>`
			WITH sandbox AS (
				SELECT id, root_inode FROM sandboxes WHERE id = ${sandboxId}
			),
			${fenceAndAdvance(tx, sandboxId, expectedEpoch)}
			SELECT sandbox.root_inode, (SELECT count(*) FROM epoch)::int AS fenced
			FROM sandbox
		`;
	const ctxRow = ctxRows[0];
	if (ctxRow !== undefined && ctxRow.fenced === 0) throw createEstale(sandboxId);
	if (!ctxRow?.root_inode) throw new Error("bulkIngest: sandbox not found or has no root inode");
	const rootInodeId = BigInt(ctxRow.root_inode);

	const dirMap = new Map<string, bigint>();
	dirMap.set("/", rootInodeId);

	const dirsByDepth = new Map<number, Set<string>>();
	for (const f of files) {
		const parts = f.path.split("/").filter(Boolean);
		for (let i = 1; i < parts.length; i++) {
			const dirPath = `/${parts.slice(0, i).join("/")}`;
			const depth = i;
			let set = dirsByDepth.get(depth);
			if (!set) {
				set = new Set();
				dirsByDepth.set(depth, set);
			}
			set.add(dirPath);
		}
	}
	const sortedDepths = [...dirsByDepth.keys()].sort((a, b) => a - b);

	for (const depth of sortedDepths) {
		const dirsAtDepth = dirsByDepth.get(depth)!;

		const candidates: Array<{
			dirPath: string;
			name: string;
			parentInodeId: bigint;
		}> = [];
		for (const dirPath of dirsAtDepth) {
			if (dirMap.has(dirPath)) continue;
			const parts = dirPath.split("/").filter(Boolean);
			const name = parts[parts.length - 1]!;
			const parentPath = parts.length === 1 ? "/" : `/${parts.slice(0, -1).join("/")}`;
			const parentInodeId = dirMap.get(parentPath);
			if (!parentInodeId) throw new Error(`bulkIngest: parent dir ${parentPath} not found`);
			candidates.push({ dirPath, name, parentInodeId });
		}

		if (candidates.length === 0) continue;

		const checkValues = candidates.map((c) => [String(c.parentInodeId), c.name]);
		const existingRows = await tx<
			{
				parent_inode_id: string;
				name: string;
				inode_id: string;
				kind: number;
			}[]
		>`
				SELECT d.parent_inode_id, d.name, d.inode_id, i.kind
				FROM dirents d
				JOIN inodes i ON i.id = d.inode_id
				JOIN (VALUES ${tx(checkValues)}) AS v(pid, nm)
					ON d.parent_inode_id = v.pid::bigint AND d.name = v.nm
			`;

		const candidateByKey = new Map<string, (typeof candidates)[0]>();
		for (const c of candidates) candidateByKey.set(`${String(c.parentInodeId)}:${c.name}`, c);

		for (const row of existingRows) {
			const match = candidateByKey.get(`${row.parent_inode_id}:${row.name}`);
			if (row.kind !== INODE_KIND.DIRECTORY) {
				throw createEnotdir(match?.dirPath ?? row.name);
			}
			if (match) dirMap.set(match.dirPath, BigInt(row.inode_id));
		}

		const toCreate = candidates.filter((c) => !dirMap.has(c.dirPath));
		if (toCreate.length === 0) continue;

		const dirInodeInserts = toCreate.map((_c) => ({
			sandbox_id: sandboxId,
			kind: INODE_KIND.DIRECTORY,
			mode: 0o755,
			size: 0,
		}));
		const createdDirInodes = await tx<{ id: string; mtime: string }[]>`
				INSERT INTO inodes ${tx(dirInodeInserts)} RETURNING id, mtime
			`;

		const dirDirentInserts = toCreate.map((c, i) => ({
			parent_inode_id: String(c.parentInodeId),
			name: c.name,
			inode_id: createdDirInodes[i]!.id,
			sandbox_id: sandboxId,
		}));
		await tx`INSERT INTO dirents ${tx(dirDirentInserts)}`;

		for (let i = 0; i < toCreate.length; i++) {
			const c = toCreate[i]!;
			const row = createdDirInodes[i]!;
			const inodeId = BigInt(row.id);
			dirMap.set(c.dirPath, inodeId);
			result.set(c.dirPath, {
				inodeId,
				kind: INODE_KIND.DIRECTORY,
				mode: 0o755,
				size: 0,
				mtime: new Date(row.mtime),
				contentSha256: null,
				symlinkTarget: null,
			});
		}
	}

	const filesWithHash = files.map((f) => {
		const parts = f.path.split("/").filter(Boolean);
		const name = parts[parts.length - 1]!;
		const parentPath = parts.length === 1 ? "/" : `/${parts.slice(0, -1).join("/")}`;
		return {
			path: f.path,
			content: f.content,
			mode: f.mode,
			sha256: Buffer.from(createHash("sha256").update(f.content).digest()),
			name,
			parentPath,
			parentInodeId: dirMap.get(parentPath)!,
		};
	});

	const fileCheckValues = filesWithHash.map((f) => [String(f.parentInodeId), f.name]);
	const existingFileDirents = await tx<
		{
			parent_inode_id: string;
			name: string;
			inode_id: string;
			kind: number;
		}[]
	>`
			SELECT d.parent_inode_id, d.name, d.inode_id, i.kind
			FROM dirents d
			JOIN inodes i ON i.id = d.inode_id
			JOIN (VALUES ${tx(fileCheckValues)}) AS v(pid, nm)
				ON d.parent_inode_id = v.pid::bigint AND d.name = v.nm
		`;

	const existingFileMap = new Map<string, bigint>();
	for (const row of existingFileDirents) {
		if (row.kind === INODE_KIND.DIRECTORY) {
			const match = filesWithHash.find((f) => String(f.parentInodeId) === row.parent_inode_id && f.name === row.name);
			throw createEisdir(match?.path ?? row.name);
		}
		existingFileMap.set(`${row.parent_inode_id}:${row.name}`, BigInt(row.inode_id));
	}

	// F6: commit the CAS blobs in their OWN short tx (own pool connection, no
	// advisory lock — `blobs` is unscoped CAS) BEFORE the inode/dirent work in
	// the script-tx, so the hot-blob `ON CONFLICT DO UPDATE` tuple lock is
	// released at this statement's COMMIT instead of being pinned to the
	// long-lived script-tx. The touch is unconditional so the GC grace window
	// protects these blobs until their referencing inodes commit below.

	const uniqueBlobs = new Map<string, { sha256: Buffer; data: Uint8Array; size: number }>();
	for (const f of filesWithHash) {
		const key = f.sha256.toString("hex");
		if (!uniqueBlobs.has(key)) {
			uniqueBlobs.set(key, {
				sha256: f.sha256,
				data: f.content,
				size: f.content.length,
			});
		}
	}
	if (uniqueBlobs.size > 0) {
		const blobRows = [...uniqueBlobs.values()];
		await blobs.commitBatch(blobRows);
	}

	const inodeInserts = filesWithHash.map((f) => ({
		sandbox_id: sandboxId,
		kind: INODE_KIND.FILE,
		mode: f.mode,
		size: f.content.length,
		content_sha256: f.sha256,
	}));
	const insertedInodes = await tx<{ id: string; mtime: string }[]>`
			INSERT INTO inodes ${tx(inodeInserts)} RETURNING id, mtime
		`;

	const toUpdate: Array<[string, string, string]> = [];
	const oldInodeIds: bigint[] = [];
	const toInsert: Array<{
		parent_inode_id: string;
		name: string;
		inode_id: string;
		sandbox_id: string;
	}> = [];

	for (let i = 0; i < filesWithHash.length; i++) {
		const f = filesWithHash[i]!;
		const newInodeId = insertedInodes[i]!.id;
		const key = `${String(f.parentInodeId)}:${f.name}`;
		const oldInodeId = existingFileMap.get(key);

		if (oldInodeId !== undefined) {
			toUpdate.push([String(f.parentInodeId), f.name, newInodeId]);
			oldInodeIds.push(oldInodeId);
		} else {
			toInsert.push({
				parent_inode_id: String(f.parentInodeId),
				name: f.name,
				inode_id: newInodeId,
				sandbox_id: sandboxId,
			});
		}
	}

	if (toUpdate.length > 0) {
		await tx`
				UPDATE dirents d
				SET inode_id = v.new_id::bigint
				FROM (VALUES ${tx(toUpdate)}) AS v(pid, nm, new_id)
				WHERE d.parent_inode_id = v.pid::bigint AND d.name = v.nm
			`;
		// Count occurrences of each old inode — hardlinks may cause duplicates
		const nlinkDecrements = new Map<string, number>();
		for (const id of oldInodeIds) {
			const key = String(id);
			nlinkDecrements.set(key, (nlinkDecrements.get(key) ?? 0) + 1);
		}
		const decrementValues = [...nlinkDecrements.entries()].map(([id, cnt]) => [id, String(cnt)]);
		await tx`
				UPDATE inodes i
				SET nlink = i.nlink - v.cnt::int
				FROM (VALUES ${tx(decrementValues)}) AS v(inode_id, cnt)
				WHERE i.id = v.inode_id::bigint
			`;
		const oldIdStrings = [...nlinkDecrements.keys()];
		await tx`DELETE FROM inodes WHERE id IN ${tx(oldIdStrings)} AND nlink <= 0`;
	}

	if (toInsert.length > 0) {
		await tx`INSERT INTO dirents ${tx(toInsert)}`;
	}

	for (let i = 0; i < filesWithHash.length; i++) {
		const f = filesWithHash[i]!;
		const row = insertedInodes[i]!;
		result.set(f.path, {
			inodeId: BigInt(row.id),
			kind: INODE_KIND.FILE,
			mode: f.mode,
			size: f.content.length,
			mtime: new Date(row.mtime),
			contentSha256: f.sha256,
			symlinkTarget: null,
		});
	}

	return result;
}
