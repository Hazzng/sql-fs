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

/** just-git's network option: a policy object grants outbound transport, `false` blocks it. */
type GitNetworkOption = NonNullable<Parameters<typeof createGit>[0]>["network"];

/** just-git's custom transport hook — not exported from the package root, so derive it. */
type GitFetchFunction = NonNullable<Exclude<GitNetworkOption, false | undefined>["fetch"]>;

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
 * Is `path` a directory with nothing in it? A destination that exists but is not a directory
 * counts as non-empty: just-git refuses it with its own message, and readdir on a file would
 * otherwise throw out of the hook before git ever got to report that.
 */
async function isEmptyDir(fs: IFileSystem, path: string): Promise<boolean> {
	if (!(await fs.stat(path)).isDirectory) return false;
	return (await fs.readdir(path)).length === 0;
}

/** Redirect chains a git remote may send us through before we call it a loop. */
const MAX_GIT_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Headers that describe a body, dropped with it when a redirect rewrites the request to GET. */
const BODY_HEADERS = ["content-length", "content-type", "content-encoding", "content-language", "content-location"];

/**
 * Git HTTP transport that refuses plaintext, hop by hop.
 *
 * just-git resolves `GIT_HTTP_USER`/`GIT_HTTP_PASSWORD` from the sandbox env for *any* http(s)
 * remote, so an `http://` URL would put the deployment token on the wire in the clear — a remote
 * the agent was merely talked into cloning is enough.
 *
 * Redirects are followed by hand (`redirect: "manual"`) because checking the response afterwards
 * is too late: `fetch` would already have made the downgraded request, and a chain that dips
 * through `http://` and back to `https://` would hand back a final URL that looks clean. Crossing
 * origins drops the credentials, which is what `fetch` does for us when it follows redirects
 * itself — the token is for the host the user named, not for wherever it forwards us.
 */
export const httpsOnlyGitFetch: GitFetchFunction = async (input, init) => {
	const request = input instanceof Request ? input : new Request(input, init);
	requireHttps(request.url, "refusing to send credentials over plaintext HTTP");

	// Buffered once so every hop can replay it; just-git only ever sends byte-array bodies.
	let body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
	let method = request.method;
	let url = request.url;
	const headers = new Headers(request.headers);

	for (let hop = 0; hop <= MAX_GIT_REDIRECTS; hop++) {
		const response = await fetch(url, { method, headers, body, redirect: "manual", signal: request.signal });
		const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
		if (location === null) return response;

		// Nothing reads a redirect's body, and a remote is free to stream one; leaving it open would
		// hold a connection per hop for as long as the chain runs.
		await response.body?.cancel().catch(() => {});

		const next = new URL(location, url).href;
		requireHttps(next, "remote redirected to plaintext HTTP");
		// What `fetch` does when it follows a redirect itself: 303 is "repeat this as a GET", and so is
		// 301/302 on a POST. Only 307/308 replay the body — which for git is a packfile, so replaying it
		// onto a host we were forwarded to would re-send the push.
		const rewriteToGet =
			(response.status === 303 && method !== "GET" && method !== "HEAD") ||
			((response.status === 301 || response.status === 302) && method === "POST");
		if (rewriteToGet) {
			method = "GET";
			body = undefined;
			for (const header of BODY_HEADERS) headers.delete(header);
		}
		if (new URL(next).origin !== new URL(url).origin) {
			headers.delete("authorization");
			headers.delete("cookie");
			// 307/308 keep the body, and for git that body is the packfile: dropping the credential would
			// still let a remote forward the whole push to an origin of its choosing.
			if (body !== undefined) {
				throw new Error(`git: remote redirected a request body to another origin (${next}); refusing to re-send it`);
			}
		}
		url = next;
	}

	throw new Error(`git: remote redirected more than ${MAX_GIT_REDIRECTS} times; refusing to continue`);
};

function requireHttps(url: string, reason: string): void {
	if (!url.startsWith("https://")) throw new Error(`git: ${reason} (${url}); use an https:// remote`);
}

/**
 * Build the sandbox `git` command. `defineCommand` marks it `trusted: true`, which runs it inside
 * `DefenseInDepthBox.runTrustedAsync` — git needs direct `fetch` and crypto.
 *
 * @param options.network a policy object grants outbound transport (production passes
 *   {@link httpsOnlyGitFetch}), `false` blocks clone/fetch/push while leaving local git intact.
 *   Tests pass an in-process transport to run hermetically.
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
				const wasEmpty = existed ? await isEmptyDir(scope.fs, event.targetPath) : true;
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
