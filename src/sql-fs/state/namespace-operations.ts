import type { CpOptions, MkdirOptions, RmOptions } from "just-bash";
import { createEexist, createEnotdir } from "../errors.js";
import type { BulkIngestFile } from "../types.js";

import * as tree from "./namespace/directory-tree.js";
import * as fileWrites from "./namespace/file-writes.js";
import * as ingest from "./namespace/ingest.js";
import * as links from "./namespace/links-moves.js";
import { DEV_NULL, parentOf } from "./paths.js";
import type { ScriptPersistence } from "./script-persistence.js";
import type { NamespacePolicy } from "./types.js";

type CreateExclusiveOpts = Parameters<NonNullable<import("just-bash").IFileSystem["createExclusive"]>>[1];
type NamespaceDialect<Tx> = fileWrites.FileWriteQueries<Tx> &
	tree.TreeQueries<Tx> &
	links.LinkMoveQueries<Tx> &
	ingest.IngestQueries<Tx>;
type NamespaceView<Tx> = fileWrites.FileWriteView<Tx> &
	tree.TreeView<Tx> &
	links.LinkMoveView<Tx> &
	ingest.IngestView<Tx>;
type NamespacePersistence<Tx> = fileWrites.FileWritePersistence<Tx> &
	tree.TreePersistence<Tx> &
	links.LinkMovePersistence<Tx> &
	ingest.IngestPersistence<Tx> &
	Pick<ScriptPersistence<Tx>, "captureReservation" | "assertReservation">;
export class NamespaceOperations<Tx> {
	readonly #dialect: NamespaceDialect<Tx>;

	readonly #sandboxId: string;

	readonly #view: NamespaceView<Tx>;

	readonly #persistence: NamespacePersistence<Tx>;

	readonly #policy: NamespacePolicy;

	readonly #namespaceMutations = new Set<{ paths: readonly string[]; done: Promise<void> }>();

	constructor(
		dialect: NamespaceDialect<Tx>,
		sandboxId: string,
		view: NamespaceView<Tx>,
		persistence: NamespacePersistence<Tx>,
		policy: NamespacePolicy,
	) {
		this.#dialect = dialect;
		this.#sandboxId = sandboxId;
		this.#view = view;
		this.#persistence = persistence;
		this.#policy = policy;
	}

	async createExclusive(path: string, options: CreateExclusiveOpts): Promise<void> {
		if (path === DEV_NULL) throw createEexist(path);
		await this.#withNamespaceMutation([path], async () => {
			this.#policy.assertWritable(path, "createExclusive");
			if (this.#view.has(path)) throw createEexist(path);
			this.#view.requireParent(path);
			if (options.directory) {
				await this.#mkdirAt(path, undefined, options.mode);
			} else {
				await this.#writeFileAt(path, new Uint8Array(0), options.mode);
			}
		});
	}

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		if (path === DEV_NULL) {
			if (options?.recursive) throw createEnotdir(path);
			throw createEexist(path);
		}
		// Recursive mkdir can create every missing ancestor, not just its final path.
		let root = path;
		if (options?.recursive) {
			while (parentOf(root) !== root && !this.#view.has(parentOf(root))) {
				root = parentOf(root);
			}
		}
		await this.#withNamespaceMutation([root], () => this.#mkdirAt(path, options, 0o755));
	}

	async bulkIngest(files: BulkIngestFile[]): Promise<void> {
		const roots = files.map((file) => {
			let root = file.path;
			while (parentOf(root) !== root && !this.#view.has(parentOf(root))) root = parentOf(root);
			return root;
		});
		await this.#withNamespaceMutation(roots, () =>
			ingest.bulkIngest(this.#sandboxId, this.#dialect, this.#view, this.#persistence, this.#policy, files),
		);
	}

	async #withNamespaceMutation<T>(paths: readonly string[], run: () => Promise<T>): Promise<T> {
		const stamp = this.#persistence.captureReservation();
		const overlaps = (a: string, b: string): boolean =>
			a === b || a === "/" || b === "/" || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
		const pending = [...this.#namespaceMutations].filter((mutation) =>
			mutation.paths.some((active) => paths.some((path) => overlaps(active, path))),
		);
		let release!: () => void;
		const mutation = {
			paths,
			done: new Promise<void>((resolve) => {
				release = resolve;
			}),
		};
		this.#namespaceMutations.add(mutation);
		try {
			await Promise.all(pending.map((active) => active.done));
			this.#persistence.assertReservation(stamp);
			return await run();
		} finally {
			this.#namespaceMutations.delete(mutation);
			release();
		}
	}

	#writeFileAt(path: string, bytes: Uint8Array, createMode: number | undefined): Promise<void> {
		return fileWrites.writeFile(
			this.#sandboxId,
			this.#dialect,
			this.#view,
			this.#persistence,
			this.#policy,
			path,
			bytes,
			createMode,
		);
	}

	writeFile(path: string, bytes: Uint8Array, createMode: number | undefined): Promise<void> {
		return this.#withNamespaceMutation([path], () => this.#writeFileAt(path, bytes, createMode));
	}

	appendFile(path: string, bytes: Uint8Array): Promise<void> {
		return this.#withNamespaceMutation([path], () =>
			fileWrites.appendFile(this.#sandboxId, this.#dialect, this.#view, this.#persistence, this.#policy, path, bytes),
		);
	}

	#mkdirAt(path: string, options: MkdirOptions | undefined, mode: number): Promise<void> {
		return tree.mkdir(this.#sandboxId, this.#dialect, this.#view, this.#persistence, this.#policy, path, options, mode);
	}

	rm(path: string, options?: RmOptions): Promise<void> {
		return this.#withNamespaceMutation([path], () =>
			tree.rm(this.#sandboxId, this.#dialect, this.#view, this.#persistence, this.#policy, path, options),
		);
	}

	cp(src: string, dest: string, options?: CpOptions): Promise<void> {
		return this.#withNamespaceMutation([src, dest], () =>
			tree.cp(
				this.#sandboxId,
				this.#dialect,
				this.#view,
				this.#persistence,
				this.#policy,
				src,
				dest,
				options,
				(path, mode) => this.#writeFileAt(path, new Uint8Array(0), mode),
			),
		);
	}

	chmod(path: string, mode: number): Promise<void> {
		return this.#withNamespaceMutation([path], () =>
			links.chmod(this.#sandboxId, this.#dialect, this.#view, this.#persistence, this.#policy, path, mode),
		);
	}

	utimes(path: string, mtime: Date): Promise<void> {
		return this.#withNamespaceMutation([path], () =>
			links.utimes(this.#sandboxId, this.#dialect, this.#view, this.#persistence, this.#policy, path, mtime),
		);
	}

	mv(src: string, dest: string): Promise<void> {
		return this.#withNamespaceMutation([src, dest], () =>
			links.mv(this.#sandboxId, this.#dialect, this.#view, this.#persistence, this.#policy, src, dest),
		);
	}

	symlink(target: string, linkPath: string): Promise<void> {
		return this.#withNamespaceMutation([linkPath], () =>
			links.symlink(this.#sandboxId, this.#dialect, this.#view, this.#persistence, this.#policy, target, linkPath),
		);
	}

	link(existingPath: string, newPath: string): Promise<void> {
		return this.#withNamespaceMutation([existingPath, newPath], () =>
			links.link(this.#sandboxId, this.#dialect, this.#view, this.#persistence, this.#policy, existingPath, newPath),
		);
	}
}
