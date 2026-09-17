/**
 * Custom `git` command — wraps just-git so a `clone` that fails partway cleans up after itself.
 *
 * just-git writes the index in full while the checkout is still running, and both just-git
 * (symlink targets escaping the worktree) and SqlFs (`allowSymlinks` defaults to false) abort
 * mid-checkout on a symlink. A non-zero exit is an ordinary exec result, so `SessionManager`
 * commits the half-built tree — and because the index is complete, `git status` then reports
 * every un-checked-out file as a staged deletion. `git add -A && git commit` turns those into a
 * real commit that wipes the tree. Real `git` removes a destination it created when a clone
 * fails; this restores that contract.
 *
 * The destination comes from just-git's own `preClone` hook rather than from parsing argv, so it
 * is the path just-git actually resolved. A script may background several clones, so each
 * invocation gets its own scope via AsyncLocalStorage.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { posix } from "node:path";
import { defineCommand } from "just-bash";
import type { Command, ExecResult, IFileSystem } from "just-bash";
import { createGit } from "just-git";

/** just-git's network option: `{}` for unrestricted outbound, `false` to block transport. */
type GitNetworkOption = NonNullable<Parameters<typeof createGit>[0]>["network"];

interface CloneTarget {
	readonly path: string;
	/** The destination already existed when git resolved it. */
	readonly existed: boolean;
	/** It was empty at that moment. just-git refuses a non-empty destination outright. */
	readonly wasEmpty: boolean;
}

interface CloneScope {
	readonly fs: IFileSystem;
	readonly targets: CloneTarget[];
}

/**
 * Remove what a failed clone left behind.
 *
 * A destination the clone created is removed outright. One that existed but was empty is only
 * emptied again — everything in it now came from this clone, while the directory itself is the
 * caller's and stays. A destination that already held files is never touched: just-git refuses
 * those before writing anything, so its contents are the caller's.
 */
async function removeResidue(fs: IFileSystem, targets: readonly CloneTarget[]): Promise<string[]> {
	const discarded: string[] = [];
	for (const target of targets) {
		if (target.existed && !target.wasEmpty) continue;
		try {
			if (!(await fs.exists(target.path))) continue;
			const entries = await fs.readdir(target.path);
			if (entries.length === 0) {
				// Nothing was written. Still drop a directory git created, but say nothing.
				if (!target.existed) await fs.rm(target.path, { recursive: true, force: true });
				continue;
			}
			if (target.existed) {
				for (const name of entries) await fs.rm(posix.join(target.path, name), { recursive: true, force: true });
			} else {
				await fs.rm(target.path, { recursive: true, force: true });
			}
			discarded.push(target.path);
		} catch {
			// Best-effort: keep git's original failure rather than masking it with a cleanup error.
		}
	}
	return discarded;
}

/**
 * Build the sandbox `git` command. `defineCommand` marks it `trusted: true`, which runs it inside
 * `DefenseInDepthBox.runTrustedAsync` — git needs direct `fetch` and crypto.
 *
 * @param options.network `{}` grants unrestricted outbound, `false` blocks clone/fetch/push while
 *   leaving local git intact. Tests pass an in-process transport to run hermetically.
 */
export function createGitCommand(options: { readonly network: GitNetworkOption }): Command {
	const scopes = new AsyncLocalStorage<CloneScope>();
	const git = createGit({
		network: options.network,
		hooks: {
			preClone: async (event) => {
				const scope = scopes.getStore();
				if (scope === undefined) return;
				const existed = await scope.fs.exists(event.targetPath);
				const wasEmpty = existed ? (await scope.fs.readdir(event.targetPath)).length === 0 : true;
				scope.targets.push({ path: event.targetPath, existed, wasEmpty });
			},
		},
	});

	return defineCommand("git", async (args, ctx): Promise<ExecResult> => {
		const scope: CloneScope = { fs: ctx.fs, targets: [] };
		let result: ExecResult;
		try {
			result = await scopes.run(scope, () => git.execute(args, ctx as Parameters<typeof git.execute>[1]));
		} catch (err) {
			// A throw skips the exit-code path below, and just-bash still commits the script.
			await removeResidue(ctx.fs, scope.targets);
			throw err;
		}

		if (result.exitCode === 0) return result;
		const removed = await removeResidue(ctx.fs, scope.targets);
		if (removed.length === 0) return result;

		// git's own stderr does not reliably end in a newline.
		const separator = result.stderr.length > 0 && !result.stderr.endsWith("\n") ? "\n" : "";
		const paths = removed.map((p) => `'${p}'`).join(", ");
		return {
			...result,
			stderr: `${result.stderr}${separator}git: clone failed; removed the incomplete checkout at ${paths}\n`,
		};
	});
}
