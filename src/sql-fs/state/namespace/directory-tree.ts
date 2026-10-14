import type { CpOptions, MkdirOptions, RmOptions } from "just-bash";
import { createEexist, createEisdir, createEnoent, createEnotdir, createEnotempty } from "../../errors.js";
import { INODE_KIND, type SqlDialect } from "../../types.js";
import type { CoherentView } from "../coherent-view.js";
import { assertStoredPath, DEV_NULL, nameOf, parentOf, validatePath } from "../paths.js";
import type { ScriptPersistence } from "../script-persistence.js";
import { type ContentChange, type NamespacePolicy, type PathChange, PER_MUTATION_BASE_BYTES } from "../types.js";

const DEV_NULL_STAT = { mode: 0o666 };
export type TreeQueries<Tx> = Pick<
	SqlDialect<Tx>,
	| "createInode"
	| "insertDirent"
	| "mkdirComposite"
	| "deleteDirent"
	| "decrementNlink"
	| "deleteInode"
	| "rmComposite"
	| "upsertDirent"
>;
export type TreeView<Tx> = Pick<
	CoherentView<Tx>,
	"epoch" | "has" | "get" | "publishMutation" | "markDirty" | "requireParent" | "pathsUnder" | "childPaths"
>;
export type TreePersistence<Tx> = Pick<ScriptPersistence<Tx>, "mutateOne" | "mutate">;

export type TreePolicy = Pick<NamespacePolicy, "assertWritable">;

export async function mkdir<Tx>(
	sandboxId: string,
	dialect: TreeQueries<Tx>,
	view: TreeView<Tx>,
	persistence: TreePersistence<Tx>,
	policy: TreePolicy,
	path: string,
	options: MkdirOptions | undefined,
	mode: number,
): Promise<void> {
	const paths: PathChange[] = [];
	const contents: ContentChange[] = [];
	policy.assertWritable(path, "mkdir");
	const recursive = options?.recursive ?? false;
	const mtime = new Date();

	if (recursive) {
		const segments = path.split("/").filter(Boolean);
		let current = "/";
		let created = false;
		for (const seg of segments) {
			const next = current === "/" ? `/${seg}` : `${current}/${seg}`;
			if (!view.has(next)) {
				const parentEntry = view.get(current);
				if (!parentEntry) throw createEnoent(current);
				// Reject non-directory ancestors before any DB work. Otherwise
				// mkdir -p /a/b with /a as a file would silently insert a
				// dirent under the file's inode (dirents has no FK on kind).
				if (parentEntry.kind !== INODE_KIND.DIRECTORY) throw createEnotdir(current);
				// One fence and one bump per segment actually created: outside a
				// scope each segment is its own transaction anyway, and batching
				// them would change `mkdir -p`'s partial-failure behaviour. A
				// `mkdir -p` over an existing tree creates nothing and costs nothing.
				const receipt = await persistence.mutateOne(view, {
					kind: "mkdir -p",
					composite: false,
					run: async (tx, replay) => {
						const id = await dialect.createInode(
							tx,
							{
								sandboxId,
								kind: INODE_KIND.DIRECTORY,
								mode,
								size: 0,
							},
							replay.expectedEpoch,
						);
						await dialect.insertDirent(tx, replay.resolveInodeId(parentEntry.inodeId), seg, id);
						return [id];
					},
				});
				const inodeId = receipt.value;
				view.publishMutation(
					receipt,
					[
						{
							kind: "set",
							path: next,
							entry: {
								inodeId,
								kind: INODE_KIND.DIRECTORY,
								mode,
								size: 0,
								mtime,
								contentSha256: null,
								symlinkTarget: null,
							},
						},
					],
					[],
					false,
				);
				created = true;
			}
			current = next;
		}
		if (created) view.markDirty();
		return;
	}

	if (view.has(path)) throw createEexist(path);
	const { name, parentEntry } = view.requireParent(path);

	const receipt = await persistence.mutateOne(
		view,
		dialect.mkdirComposite
			? {
					kind: "mkdir",
					composite: true,
					run: async (tx, replay) => [
						await dialect.mkdirComposite!(
							tx,
							sandboxId,
							replay.resolveInodeId(parentEntry.inodeId),
							name,
							mode,
							replay.expectedEpoch,
						),
					],
				}
			: {
					kind: "mkdir",
					composite: false,
					run: async (tx, replay) => {
						const id = await dialect.createInode(
							tx,
							{
								sandboxId,
								kind: INODE_KIND.DIRECTORY,
								mode,
								size: 0,
							},
							replay.expectedEpoch,
						);
						await dialect.insertDirent(tx, replay.resolveInodeId(parentEntry.inodeId), name, id);
						return [id];
					},
				},
	);
	const inodeId = receipt.value;

	paths.push({
		kind: "set",
		path,
		entry: {
			inodeId,
			kind: INODE_KIND.DIRECTORY,
			mode,
			size: 0,
			mtime,
			contentSha256: null,
			symlinkTarget: null,
		},
	});
	view.publishMutation(receipt, paths, contents);
}

export async function rm<Tx>(
	sandboxId: string,
	dialect: TreeQueries<Tx>,
	view: TreeView<Tx>,
	persistence: TreePersistence<Tx>,
	policy: TreePolicy,
	path: string,
	options?: RmOptions,
): Promise<void> {
	const paths: PathChange[] = [];
	const contents: ContentChange[] = [];
	policy.assertWritable(path, "rm");
	const entry = view.get(path);

	if (!entry) {
		if (options?.force) return;
		throw createEnoent(path);
	}

	const parentPath = parentOf(path);
	const name = nameOf(path);
	const parentEntry = view.get(parentPath);

	if (options?.recursive && entry.kind === INODE_KIND.DIRECTORY) {
		const subtreePaths = view.pathsUnder(path);
		subtreePaths.sort((a, b) => b.split("/").length - a.split("/").length);

		// The plan is resolved from the pathCache HERE, not inside the replay: a
		// buffered op runs after its own cache updates have already landed, so
		// reading the cache from the closure would walk an already-emptied subtree.
		const plan = subtreePaths.map((p) => {
			const e = view.get(p)!;
			const parent = p === path ? undefined : view.get(parentOf(p));
			return { inodeId: e.inodeId, parentInodeId: parent?.inodeId, name: nameOf(p) };
		});

		const receipt = await persistence.mutate(view, {
			kind: "rm -r",
			composite: false,
			bytes: PER_MUTATION_BASE_BYTES + plan.length * 80,
			run: async (tx, replay) => {
				if (parentEntry) {
					await dialect.deleteDirent(
						tx,
						replay.resolveInodeId(parentEntry.inodeId),
						name,
						sandboxId,
						replay.expectedEpoch,
					);
				}
				for (const step of plan) {
					if (step.parentInodeId !== undefined) {
						await dialect.deleteDirent(
							tx,
							replay.resolveInodeId(step.parentInodeId),
							step.name,
							sandboxId,
							replay.expectedEpoch,
						);
					}
					const inodeId = replay.resolveInodeId(step.inodeId);
					const newNlink = await dialect.decrementNlink(tx, inodeId);
					if (newNlink === 0) await dialect.deleteInode(tx, inodeId);
				}
				return [];
			},
		});

		for (const p of subtreePaths) {
			const e = view.get(p);
			if (e) contents.push({ kind: "evict", inodeId: e.inodeId });
			paths.push({ kind: "delete", path: p });
		}
		view.publishMutation(receipt, paths, contents);
		return;
	}

	if (entry.kind === INODE_KIND.DIRECTORY) {
		if (view.childPaths(path).length > 0) throw createEnotempty(path);
	}

	const parentInodeId = parentEntry!.inodeId;
	const receipt = await persistence.mutate(
		view,
		dialect.rmComposite
			? {
					kind: "rm",
					composite: true,
					run: async (tx, replay) => {
						await dialect.rmComposite!(tx, sandboxId, replay.resolveInodeId(parentInodeId), name, replay.expectedEpoch);
						return [];
					},
				}
			: {
					kind: "rm",
					composite: false,
					run: async (tx, replay) => {
						const removedInodeId = await dialect.deleteDirent(
							tx,
							replay.resolveInodeId(parentInodeId),
							name,
							sandboxId,
							replay.expectedEpoch,
						);
						const newNlink = await dialect.decrementNlink(tx, removedInodeId);
						if (newNlink === 0) await dialect.deleteInode(tx, removedInodeId);
						return [];
					},
				},
	);

	contents.push({ kind: "evict", inodeId: entry.inodeId });
	paths.push({ kind: "delete", path });
	view.publishMutation(receipt, paths, contents);
}

export async function cp<Tx>(
	sandboxId: string,
	dialect: TreeQueries<Tx>,
	view: TreeView<Tx>,
	persistence: TreePersistence<Tx>,
	policy: TreePolicy,
	src: string,
	dest: string,
	options?: CpOptions,
	writeEmpty?: (path: string, mode: number) => Promise<void>,
): Promise<void> {
	const paths: PathChange[] = [];
	const contents: ContentChange[] = [];
	if (src === DEV_NULL) {
		if (dest !== DEV_NULL) await writeEmpty!(dest, DEV_NULL_STAT.mode);
		return;
	}
	const srcEntry = view.get(src);
	if (dest === DEV_NULL) {
		if (!srcEntry) throw createEnoent(src);
		if (srcEntry.kind === INODE_KIND.DIRECTORY) throw createEnotdir(dest);
		return;
	}
	policy.assertWritable(dest, "cp");
	// Reject copying onto the root inode (empty basename) — would clobber "/"
	// in pathCache and persist a corrupt root cross-replica (audit H2 #25).
	if (nameOf(dest) === "") throw createEisdir(dest);
	if (!srcEntry) throw createEnoent(src);

	if (srcEntry.kind === INODE_KIND.DIRECTORY) {
		if (!options?.recursive) throw createEisdir(src);

		const srcPaths = view.pathsUnder(src);
		srcPaths.sort((a, b) => a.split("/").length - b.split("/").length);

		view.requireParent(dest);

		const mtime = new Date();
		const newInodeIds = new Map<string, bigint>();

		// Resolved from the pathCache HERE — see `rm -r`: a buffered replay runs after
		// this call's own cache updates, so reading it from the closure is wrong. Only
		// the parent whose inode this same copy creates is left to the replay, keyed by
		// dest path rather than id.
		const plan = srcPaths.map((srcPath) => {
			const entry = view.get(srcPath)!;
			const destPath = dest + srcPath.slice(src.length);
			validatePath(destPath);
			assertStoredPath(destPath, "cp");
			const parentPath = parentOf(destPath);
			return {
				destPath,
				name: nameOf(destPath),
				parentPath,
				existingParentId: view.get(parentPath)?.inodeId,
				kind: entry.kind,
				mode: entry.mode,
				size: entry.size,
				contentSha256: entry.contentSha256,
				symlinkTarget: entry.symlinkTarget,
			};
		});

		const receipt = await persistence.mutate(view, {
			kind: "cp -r",
			composite: false,
			mints: plan.length,
			bytes: PER_MUTATION_BASE_BYTES + plan.reduce((n, step) => n + step.destPath.length * 2 + 120, 0),
			run: async (tx, replay) => {
				const created = new Map<string, bigint>();
				const ids: bigint[] = [];
				for (const step of plan) {
					const fromThisCopy = created.get(step.parentPath);
					const parentInodeId =
						fromThisCopy ??
						(step.existingParentId === undefined ? undefined : replay.resolveInodeId(step.existingParentId));
					if (parentInodeId === undefined) throw createEnoent(step.parentPath);
					const newId = await dialect.createInode(
						tx,
						{
							sandboxId,
							kind: step.kind,
							mode: step.mode,
							size: step.size,
							contentSha256: step.contentSha256,
							symlinkTarget: step.symlinkTarget,
						},
						replay.expectedEpoch,
					);
					await dialect.insertDirent(tx, parentInodeId, step.name, newId);
					created.set(step.destPath, newId);
					ids.push(newId);
				}
				return ids;
			},
		});
		const copiedIds = receipt.value;
		for (let i = 0; i < plan.length; i++) newInodeIds.set(plan[i]!.destPath, copiedIds[i]!);

		for (const [destPath, inodeId] of newInodeIds) {
			const srcPath = src + destPath.slice(dest.length);
			const srcE = view.get(srcPath)!;
			paths.push({ kind: "set", path: destPath, entry: { ...srcE, inodeId, mtime } });
		}
		view.publishMutation(receipt, paths, contents);
		return;
	}

	if (view.get(dest)?.kind === INODE_KIND.DIRECTORY) throw createEisdir(dest);
	const { name: destName, parentEntry: destParentEntry } = view.requireParent(dest);

	const mtime = new Date();

	// Preserve the source inode's kind. Audit M8: forcing kind=FILE here turned
	// a copied symlink into a corrupt FILE inode (non-zero size, NULL content).
	// Copying a symlink preserves the link (target + size), matching the
	// recursive-cp path above.
	const receipt = await persistence.mutateOne(view, {
		kind: "cp",
		composite: false,
		run: async (tx, replay) => {
			const id = await dialect.createInode(
				tx,
				{
					sandboxId,
					kind: srcEntry.kind,
					mode: srcEntry.mode,
					size: srcEntry.size,
					contentSha256: srcEntry.contentSha256,
					symlinkTarget: srcEntry.symlinkTarget,
				},
				replay.expectedEpoch,
			);
			const oldInodeId = await dialect.upsertDirent(tx, replay.resolveInodeId(destParentEntry.inodeId), destName, id);
			if (oldInodeId !== null) {
				const newNlink = await dialect.decrementNlink(tx, oldInodeId);
				if (newNlink === 0) await dialect.deleteInode(tx, oldInodeId);
			}
			return [id];
		},
	});
	const newInodeId = receipt.value;

	paths.push({
		kind: "set",
		path: dest,
		entry: {
			inodeId: newInodeId,
			kind: srcEntry.kind,
			mode: srcEntry.mode,
			size: srcEntry.size,
			mtime,
			contentSha256: srcEntry.contentSha256,
			symlinkTarget: srcEntry.symlinkTarget,
		},
	});
	view.publishMutation(receipt, paths, contents);
}
