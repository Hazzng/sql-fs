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
 *
 * just-git's checkout also never sets the executable bit (blindmansion/just-git#10), so every
 * file git writes is given the mode its index entry records until upstream fixes that.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { posix } from "node:path";
import { defineCommand } from "just-bash";
import type { Command, ExecResult, IFileSystem } from "just-bash";
import { createGit } from "just-git";
import { flattenTree, readCommit, revParse } from "just-git/repo";

/** just-git's network option: a policy object grants outbound transport, `false` blocks it. */
type GitNetworkOption = NonNullable<Parameters<typeof createGit>[0]>["network"];

/** just-git's identity override, derived because its type is not exported under a stable name. */
export type GitIdentity = NonNullable<NonNullable<Parameters<typeof createGit>[0]>["identity"]>;

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
	modeSelection?: ModeSelection;
}

interface ModeSelection {
	readonly stage?: "2" | "3";
	readonly source?: string;
}

/** Only checkout/restore explicitly select an unmerged stage or a separate source tree. */
function modeSelectionFor(command: string, args: readonly string[]): ModeSelection | undefined {
	if (command !== "checkout" && command !== "restore") return;
	let ours = false;
	let theirs = false;
	let source: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") break;
		const equals = arg.indexOf("=");
		const option = equals < 0 ? arg : arg.slice(0, equals);
		// just-git ignores an assigned value for flags, including their --no- forms.
		if (option === "--ours") ours = true;
		else if (option === "--theirs") theirs = true;
		else if (option === "--no-ours") ours = false;
		else if (option === "--no-theirs") theirs = false;
		else if (command === "restore") {
			if (arg === "-s" || arg === "--source") source = args[++i];
			else if (arg.startsWith("--source=")) source = arg.slice("--source=".length);
			else if (/^-[qSW]*s/.test(arg)) {
				const sourceAt = arg.indexOf("s") + 1;
				source = arg.slice(sourceAt) || args[++i];
			}
		}
	}
	return { stage: ours ? "2" : theirs ? "3" : undefined, source: source || undefined };
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

/** `fs` with every path written through it added to `written`. */
function recordingWrites(fs: IFileSystem, cwd: string, written: Set<string>): IFileSystem {
	return new Proxy(fs, {
		get(target, prop) {
			if (prop === "writeFile") {
				return (path: string, ...rest: unknown[]): Promise<void> => {
					written.add(posix.resolve(cwd, path));
					return (target.writeFile as (p: string, ...r: unknown[]) => Promise<void>)(path, ...rest);
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
		},
	});
}

/** The worktree root at or above `start`, found by walking up to the nearest `.git`. */
async function repoRootOf(fs: IFileSystem, start: string, memo: Map<string, string | null>): Promise<string | null> {
	const visited: string[] = [];
	let dir = start;
	let root: string | null = null;
	for (;;) {
		const known = memo.get(dir);
		if (known !== undefined) {
			root = known;
			break;
		}
		visited.push(dir);
		if (await fs.exists(posix.join(dir, ".git"))) {
			root = dir;
			break;
		}
		if (dir === "/") break;
		dir = posix.dirname(dir);
	}
	for (const d of visited) memo.set(d, root);
	return root;
}

type ListIndex = (root: string) => Promise<ExecResult>;

function isRegularMode(mode: string | undefined): boolean {
	return mode === "100755" || mode === "100644";
}

/** Git merges a regular file's mode independently of its conflicting content. */
function mergedIndexMode(stages: ReadonlyMap<string, string>, selectedStage?: "2" | "3"): string | undefined {
	const resolved = stages.get("0");
	if (resolved !== undefined) return isRegularMode(resolved) ? resolved : undefined;
	if (selectedStage !== undefined) {
		const selected = stages.get(selectedStage);
		return isRegularMode(selected) ? selected : undefined;
	}
	const ours = stages.get("2");
	const theirs = stages.get("3");
	// Mixed surviving file types have their own merge rules and may be renamed by git.
	if ((ours !== undefined && !isRegularMode(ours)) || (theirs !== undefined && !isRegularMode(theirs))) return;
	if (ours === undefined) return theirs;
	if (theirs === undefined) return ours;
	// An unchanged ours takes theirs; otherwise ours wins, including differing add/add modes.
	return ours === stages.get("1") ? theirs : ours;
}

/** Absolute path to index mode for the worktree at `root`, or null when it has no readable index. */
async function indexModes(
	listIndex: ListIndex,
	root: string,
	selectedStage?: "2" | "3",
): Promise<Map<string, string> | null> {
	const listing = await listIndex(root);
	if (listing.exitCode !== 0) return null;
	const byPath = new Map<string, Map<string, string>>();
	const modes = new Map<string, string>();
	// `ls-files -s -z`: "<mode> <hash> <stage>\t<path>\0", path relative to the worktree root.
	for (const record of listing.stdout.split("\0")) {
		const tab = record.indexOf("\t");
		if (tab < 0) continue;
		const [mode, , stage] = record.slice(0, tab).split(" ");
		if (mode === undefined || stage === undefined || !/^[0-3]$/.test(stage)) continue;
		const path = posix.join(root, record.slice(tab + 1));
		const stages = byPath.get(path) ?? new Map<string, string>();
		stages.set(stage, mode);
		byPath.set(path, stages);
	}
	for (const [path, stages] of byPath) {
		const mode = mergedIndexMode(stages, selectedStage);
		if (mode !== undefined) modes.set(path, mode);
	}
	return modes;
}

/**
 * Give each regular file git wrote its index mode, merging unmerged stages as Git does.
 * Only those files change, as with real git, so a caller's own uncommitted chmod on any other file
 * stays. A branch switch where a file differs only in mode is not covered: just-git neither
 * rewrites that file nor updates its index entry, so there is no correct mode to read.
 */
async function applyIndexModes(
	fs: IFileSystem,
	written: ReadonlySet<string>,
	readModes: (root: string) => Promise<Map<string, string> | null>,
): Promise<void> {
	const byRoot = new Map<string, string[]>();
	const memo = new Map<string, string | null>();
	for (const path of written) {
		if (path.includes("/.git/")) continue;
		const root = await repoRootOf(fs, posix.dirname(path), memo);
		if (root === null) continue;
		const paths = byRoot.get(root) ?? [];
		paths.push(path);
		byRoot.set(root, paths);
	}

	for (const [root, paths] of byRoot) {
		const modes = await readModes(root);
		if (modes === null) continue;
		for (const path of paths) {
			const mode = modes.get(path);
			if (mode !== "100755" && mode !== "100644") continue;
			if (!(await fs.exists(path))) continue;
			const stat = await fs.lstat(path);
			if (!stat.isFile || stat.isSymbolicLink) continue;
			const executable = (stat.mode & 0o111) !== 0;
			if (executable !== (mode === "100755")) await fs.chmod(path, mode === "100755" ? 0o755 : 0o644);
		}
	}
}

/**
 * just-git interprets a bare `-c user.name`/`user.email` as the string "true". Reject effective
 * bare identity overrides conservatively, before they can author a commit with that identity.
 * All other config validation and command dispatch stay with just-git.
 */
function missingIdentityConfigValue(args: readonly string[]): string | undefined {
	const missing = new Set<string>();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		let pair: string | undefined;
		if (arg === "-c") {
			pair = args[++i];
			if (pair === undefined) break;
		} else if (arg.startsWith("-c") && arg.length > 2) {
			pair = arg.slice(2);
		} else if (arg === "-C") {
			i++;
			continue;
		} else if (arg === "-p" || arg === "-P" || arg === "--paginate" || arg === "--no-pager") {
			continue;
		} else {
			break;
		}
		const equals = pair.indexOf("=");
		const key = (equals < 0 ? pair : pair.slice(0, equals)).toLowerCase();
		if (key !== "user.name" && key !== "user.email") continue;
		if (equals < 0) missing.add(key);
		else missing.delete(key);
	}
	return missing.values().next().value;
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
export function createGitCommand(options: {
	readonly network: GitNetworkOption;
	/** The deployment's commit identity: just-git's fallback, below env, `-c` and repo config. */
	readonly identity?: GitIdentity;
}): Command {
	const scopes = new AsyncLocalStorage<CloneScope>();
	const git = createGit({
		network: options.network,
		identity: options.identity,
		hooks: {
			beforeCommand: (event) => {
				const scope = scopes.getStore();
				if (scope !== undefined) scope.modeSelection = modeSelectionFor(event.command, event.args);
			},
			preClone: async (event) => {
				const scope = scopes.getStore();
				if (scope === undefined) return;
				const existed = await scope.fs.exists(event.targetPath);
				const wasEmpty = existed ? await isEmptyDir(scope.fs, event.targetPath) : true;
				scope.targets.push({ path: event.targetPath, existed, wasEmpty });
			},
		},
	});

	type GitContext = Parameters<typeof git.execute>[1];

	return defineCommand("git", async (args, ctx): Promise<ExecResult> => {
		const missingIdentity = missingIdentityConfigValue(args);
		if (missingIdentity !== undefined) {
			return {
				stdout: "",
				stderr: `git: -c ${missingIdentity} requires an explicit value; use ${missingIdentity}=<value>\n`,
				exitCode: 129,
			};
		}
		const scope: CloneScope = { fs: ctx.fs, targets: [] };
		const written = new Set<string>();
		const gitCtx = ctx as GitContext;
		let result: ExecResult;
		let removed: string[];
		try {
			result = await scopes.run(scope, () =>
				git.execute(args, { ...gitCtx, fs: recordingWrites(ctx.fs, ctx.cwd, written) } as GitContext),
			);
			removed = result.exitCode === 0 ? [] : await removeResidue(ctx.fs, scope.targets);
		} catch (err) {
			// A throw skips the exit-code path below, and just-bash still commits the script.
			await removeResidue(ctx.fs, scope.targets);
			throw err;
		} finally {
			// Cleanup runs first. Thrown checkouts and conflicted merges can still have written files.
			try {
				await applyIndexModes(ctx.fs, written, async (root) => {
					const source = scope.modeSelection?.source;
					if (source !== undefined) {
						const repo = await git.findRepo({ fs: gitCtx.fs, cwd: root });
						if (repo === null) return null;
						const hash = await revParse(repo, `${source}^{commit}`);
						if (hash === null) return null;
						const commit = await readCommit(repo, hash);
						const entries = await flattenTree(repo, commit.tree);
						return new Map(entries.map((entry) => [posix.join(root, entry.path), entry.mode]));
					}
					return indexModes(
						() => git.execute(["ls-files", "-s", "-z"], { ...gitCtx, cwd: root } as GitContext),
						root,
						scope.modeSelection?.stage,
					);
				});
			} catch {
				// Best-effort: a mode-repair failure must not replace git's own result or exception.
			}
		}

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
