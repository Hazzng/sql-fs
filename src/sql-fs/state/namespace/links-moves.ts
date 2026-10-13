import {
	createEexist,
	createEinval,
	createEisdir,
	createEnoent,
	createEnotdir,
	createEnotempty,
	createEperm,
} from "../../errors.js";
import { INODE_KIND, type PathCacheEntry, type SqlDialect } from "../../types.js";
import type { CoherentView } from "../coherent-view.js";
import { assertStoredPath, nameOf, parentOf, validatePath } from "../paths.js";
import type { ScriptPersistence } from "../script-persistence.js";
import { type ContentChange, type NamespacePolicy, PER_MUTATION_BASE_BYTES, type PathChange } from "../types.js";

export type LinkMoveQueries<Tx> = Pick<
	SqlDialect<Tx>,
	| "updateInode"
	| "mvComposite"
	| "moveDirent"
	| "decrementNlink"
	| "deleteInode"
	| "createInode"
	| "insertDirent"
	| "incrementNlink"
>;
export type LinkMoveView<Tx> = Pick<
	CoherentView<Tx>,
	"epoch" | "get" | "publishMutation" | "pathsUnder" | "childPaths" | "paths" | "requireParent" | "has"
>;
export type LinkMovePersistence<Tx> = Pick<ScriptPersistence<Tx>, "mutate" | "mutateOne">;

export type LinkMovePolicy = Pick<NamespacePolicy, "assertWritable" | "assertSymlink">;

export async function chmod<Tx>(
	sandboxId: string,
	dialect: LinkMoveQueries<Tx>,
	view: LinkMoveView<Tx>,
	persistence: LinkMovePersistence<Tx>,
	policy: LinkMovePolicy,
	path: string,
	mode: number,
): Promise<void> {
	const paths: PathChange[] = [];
	const contents: ContentChange[] = [];
	policy.assertWritable(path, "chmod");
	const entry = view.get(path);
	if (!entry) throw createEnoent(path);

	const receipt = await persistence.mutate(view, {
		kind: "chmod",
		composite: false,
		run: async (tx, replay) => {
			await dialect.updateInode(tx, replay.resolveInodeId(entry.inodeId), { mode }, sandboxId, replay.expectedEpoch);
			return [];
		},
	});

	paths.push({ kind: "patchInode", inodeId: entry.inodeId, patch: { mode } });
	view.publishMutation(receipt, paths, contents);
}

export async function utimes<Tx>(
	sandboxId: string,
	dialect: LinkMoveQueries<Tx>,
	view: LinkMoveView<Tx>,
	persistence: LinkMovePersistence<Tx>,
	policy: LinkMovePolicy,
	path: string,
	mtime: Date,
): Promise<void> {
	const paths: PathChange[] = [];
	const contents: ContentChange[] = [];
	policy.assertWritable(path, "utimes");
	const entry = view.get(path);
	if (!entry) throw createEnoent(path);

	const receipt = await persistence.mutate(view, {
		kind: "utimes",
		composite: false,
		run: async (tx, replay) => {
			await dialect.updateInode(tx, replay.resolveInodeId(entry.inodeId), { mtime }, sandboxId, replay.expectedEpoch);
			return [];
		},
	});

	paths.push({ kind: "patchInode", inodeId: entry.inodeId, patch: { mtime } });
	view.publishMutation(receipt, paths, contents);
}

export async function mv<Tx>(
	sandboxId: string,
	dialect: LinkMoveQueries<Tx>,
	view: LinkMoveView<Tx>,
	persistence: LinkMovePersistence<Tx>,
	policy: LinkMovePolicy,
	src: string,
	dest: string,
): Promise<void> {
	const paths: PathChange[] = [];
	const contents: ContentChange[] = [];
	policy.assertWritable(dest, "mv");
	const srcEntry = view.get(src);
	if (!srcEntry) throw createEnoent(src);
	// A subtree move can reach the reserved device even when its root is /dev.
	for (const path of view.pathsUnder(src)) {
		const destPath = validatePath(dest + path.slice(src.length));
		assertStoredPath(destPath, "mv");
	}

	const srcParentPath = parentOf(src);
	const srcName = nameOf(src);
	const destParentPath = parentOf(dest);
	const destName = nameOf(dest);

	const srcParentEntry = view.get(srcParentPath);
	if (!srcParentEntry) throw createEnoent(srcParentPath);

	const destParentEntry = view.get(destParentPath);
	if (!destParentEntry) throw createEnoent(destParentPath);
	if (destParentEntry.kind !== INODE_KIND.DIRECTORY) throw createEnotdir(destParentPath);

	if (srcEntry.kind === INODE_KIND.DIRECTORY) {
		const srcPrefix = src === "/" ? "/" : `${src}/`;
		if (dest.startsWith(srcPrefix) || dest === src) {
			throw createEinval(src);
		}
	}

	const destEntry = view.get(dest);

	// Reject moving onto the root inode (empty basename) — would clobber "/"
	// (audit H2 #25).
	if (destName === "") throw createEisdir(dest);
	// Reject overwriting a non-empty directory: replacing its dirent here would
	// leave the destination's entire subtree orphaned in the DB and diverge the
	// cache (audit H2 #8). Mirrors rename(2) ENOTEMPTY.
	if (destEntry?.kind === INODE_KIND.DIRECTORY && view.childPaths(dest).length > 0) {
		throw createEnotempty(dest);
	}

	const receipt = await persistence.mutate(
		view,
		dialect.mvComposite
			? {
					kind: "mv",
					composite: true,
					run: async (tx, replay) => {
						await dialect.mvComposite!(
							tx,
							sandboxId,
							replay.resolveInodeId(srcParentEntry.inodeId),
							srcName,
							replay.resolveInodeId(destParentEntry.inodeId),
							destName,
							replay.expectedEpoch,
						);
						return [];
					},
				}
			: {
					kind: "mv",
					composite: false,
					run: async (tx, replay) => {
						// moveDirent carries mv's fence-and-advance, so it must run FIRST:
						// an ESTALE has to abort before the destination's nlink is touched (#204).
						await dialect.moveDirent(
							tx,
							replay.resolveInodeId(srcParentEntry.inodeId),
							srcName,
							replay.resolveInodeId(destParentEntry.inodeId),
							destName,
							sandboxId,
							replay.expectedEpoch,
						);
						if (destEntry) {
							const destInodeId = replay.resolveInodeId(destEntry.inodeId);
							const newNlink = await dialect.decrementNlink(tx, destInodeId);
							if (newNlink === 0) await dialect.deleteInode(tx, destInodeId);
						}
						return [];
					},
				},
	);

	const srcPaths = view.pathsUnder(src);
	const snapshot = new Map<string, PathCacheEntry>();
	for (const p of srcPaths) {
		const e = view.get(p);
		if (e) snapshot.set(p, e);
	}

	for (const p of srcPaths) paths.push({ kind: "delete", path: p });
	const destPrefix = dest === "/" ? "/" : `${dest}/`;
	for (const key of view.paths()) {
		if (key === dest || key.startsWith(destPrefix)) paths.push({ kind: "delete", path: key });
	}

	for (const [oldPath, entry] of snapshot) {
		paths.push({ kind: "set", path: dest + oldPath.slice(src.length), entry });
	}
	view.publishMutation(receipt, paths, contents);
}

export async function symlink<Tx>(
	sandboxId: string,
	dialect: LinkMoveQueries<Tx>,
	view: LinkMoveView<Tx>,
	persistence: LinkMovePersistence<Tx>,
	policy: LinkMovePolicy,
	target: string,
	linkPath: string,
): Promise<void> {
	const paths: PathChange[] = [];
	const contents: ContentChange[] = [];
	policy.assertWritable(linkPath, "symlink");
	policy.assertSymlink(target, linkPath);

	const { name, parentEntry } = view.requireParent(linkPath);

	const mtime = new Date();

	const receipt = await persistence.mutateOne(view, {
		kind: "symlink",
		composite: false,
		bytes: PER_MUTATION_BASE_BYTES + target.length,
		run: async (tx, replay) => {
			const id = await dialect.createInode(
				tx,
				{
					sandboxId,
					kind: INODE_KIND.SYMLINK,
					mode: 0o777,
					size: target.length,
					symlinkTarget: target,
				},
				replay.expectedEpoch,
			);
			await dialect.insertDirent(tx, replay.resolveInodeId(parentEntry.inodeId), name, id);
			return [id];
		},
	});
	const inodeId = receipt.value;

	paths.push({
		kind: "set",
		path: linkPath,
		entry: {
			inodeId,
			kind: INODE_KIND.SYMLINK,
			mode: 0o777,
			size: target.length,
			mtime,
			contentSha256: null,
			symlinkTarget: target,
		},
	});
	view.publishMutation(receipt, paths, contents);
}

export async function link<Tx>(
	sandboxId: string,
	dialect: LinkMoveQueries<Tx>,
	view: LinkMoveView<Tx>,
	persistence: LinkMovePersistence<Tx>,
	policy: LinkMovePolicy,
	existingPath: string,
	newPath: string,
): Promise<void> {
	const paths: PathChange[] = [];
	const contents: ContentChange[] = [];
	policy.assertWritable(newPath, "link");
	const srcEntry = view.get(existingPath);
	if (!srcEntry) throw createEnoent(existingPath);
	if (srcEntry.kind === INODE_KIND.DIRECTORY) throw createEperm(existingPath, "link");
	if (view.has(newPath)) throw createEexist(newPath);

	const { name: destName, parentEntry: destParentEntry } = view.requireParent(newPath);

	const receipt = await persistence.mutate(view, {
		kind: "link",
		composite: false,
		run: async (tx, replay) => {
			const targetInodeId = replay.resolveInodeId(srcEntry.inodeId);
			// incrementNlink carries link's fence-and-advance, so it must run FIRST:
			// an ESTALE has to abort before any dirent exists (#204).
			await dialect.incrementNlink(tx, targetInodeId, sandboxId, replay.expectedEpoch);
			await dialect.insertDirent(tx, replay.resolveInodeId(destParentEntry.inodeId), destName, targetInodeId);
			return [];
		},
	});

	paths.push({ kind: "set", path: newPath, entry: { ...srcEntry } });
	view.publishMutation(receipt, paths, contents);
}
