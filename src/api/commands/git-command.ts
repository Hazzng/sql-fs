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
 * Two more just-git gaps are covered here until upstream fixes them. Checkout never sets the
 * executable bit (blindmansion/just-git#10), so every file git writes is given the mode its index
 * entry records. And leading global options such as `-c` printed the help text and exited 0
 * without running the command (blindmansion/just-git#11), so they are handled before dispatch.
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

/** Leading options with nothing to do in a sandbox: there is no pager and no lock contention. */
const NO_OP_GLOBAL_OPTIONS = new Set([
	"--no-pager",
	"-P",
	"--paginate",
	"-p",
	"--no-optional-locks",
	"--no-replace-objects",
]);

/** Leading options just-git answers itself. */
const PASS_THROUGH_OPTIONS = new Set(["--version", "--help", "-h"]);

/** `-c` keys whose value changes nothing here: no pager, editor, signing, colour or credential helper. */
const NO_OP_CONFIG_KEY =
	/^(?:commit\.gpgsign|tag\.gpgsign|core\.pager|core\.editor|sequence\.editor|safe\.directory|credential\.helper|protocol\.version|color\..+|advice\..+|pager\..+)$/;

/**
 * `-c` identity keys and the env vars just-git reads for them. Real git lets an explicit
 * GIT_AUTHOR_* env beat `-c user.*`; here the sandbox's GIT_* defaults are fallbacks, so the `-c`
 * the caller typed wins.
 */
const IDENTITY_CONFIG_ENV = new Map<string, readonly string[]>([
	["user.name", ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]],
	["user.email", ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]],
]);

interface GlobalOptions {
	readonly args: string[];
	readonly cwd: string;
	readonly env: Map<string, string>;
}

/** Strip git's global options off the front of `args`, or explain which one cannot be honoured. */
function parseGlobalOptions(args: string[], cwd: string, env: Map<string, string>): GlobalOptions | { error: string } {
	let dir = cwd;
	const overrides = new Map(env);
	let i = 0;
	while (i < args.length) {
		const arg = args[i] as string;
		if (arg === "-c") {
			const pair = args[i + 1];
			const eq = pair?.indexOf("=") ?? -1;
			const key = pair === undefined ? "" : (eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
			if (key === "") return { error: "git: -c needs a name=value argument\n" };
			const vars = IDENTITY_CONFIG_ENV.get(key);
			if (vars !== undefined) {
				for (const name of vars) overrides.set(name, eq < 0 ? "" : (pair as string).slice(eq + 1));
			} else if (!NO_OP_CONFIG_KEY.test(key)) {
				return { error: `git: -c ${key} is not supported here; set it with \`git config ${key} <value>\` instead\n` };
			}
			i += 2;
		} else if (arg === "-C") {
			const path = args[i + 1];
			if (path === undefined) return { error: "git: -C needs a path argument\n" };
			if (path !== "") dir = posix.resolve(dir, path);
			i += 2;
		} else if (NO_OP_GLOBAL_OPTIONS.has(arg)) {
			i += 1;
		} else if (arg.startsWith("-") && !PASS_THROUGH_OPTIONS.has(arg)) {
			return { error: `git: unknown option: ${arg}\n` };
		} else {
			break;
		}
	}
	return { args: args.slice(i), cwd: dir, env: overrides };
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

/** Absolute path to index mode for the worktree at `root`, or null when it has no readable index. */
async function indexModes(listIndex: ListIndex, root: string): Promise<Map<string, string> | null> {
	const listing = await listIndex(root);
	if (listing.exitCode !== 0) return null;
	const modes = new Map<string, string>();
	// `ls-files -s -z`: "<mode> <hash> <stage>\t<path>\0", path relative to the worktree root.
	for (const record of listing.stdout.split("\0")) {
		const tab = record.indexOf("\t");
		if (tab < 0) continue;
		modes.set(posix.join(root, record.slice(tab + 1)), record.slice(0, record.indexOf(" ")));
	}
	return modes;
}

/**
 * Give each file git wrote the mode its index entry records: 755 for `100755`, 644 for `100644`.
 * Only those files change, as with real git, so a caller's own uncommitted chmod on any other file
 * stays. A branch switch where a file differs only in mode is not covered: just-git neither
 * rewrites that file nor updates its index entry, so there is no correct mode to read.
 */
async function applyIndexModes(fs: IFileSystem, written: ReadonlySet<string>, listIndex: ListIndex): Promise<void> {
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
		const modes = await indexModes(listIndex, root);
		if (modes === null) continue;
		for (const path of paths) {
			const mode = modes.get(path);
			if (mode !== "100755" && mode !== "100644") continue;
			if (!(await fs.exists(path))) continue;
			const executable = ((await fs.stat(path)).mode & 0o111) !== 0;
			if (executable !== (mode === "100755")) await fs.chmod(path, mode === "100755" ? 0o755 : 0o644);
		}
	}
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

	type GitContext = Parameters<typeof git.execute>[1];

	return defineCommand("git", async (args, ctx): Promise<ExecResult> => {
		const parsed = parseGlobalOptions(args, ctx.cwd, ctx.env as Map<string, string>);
		if ("error" in parsed) return { stdout: "", stderr: parsed.error, exitCode: 129 };

		const scope: CloneScope = { fs: ctx.fs, targets: [] };
		const written = new Set<string>();
		const gitCtx = { ...ctx, cwd: parsed.cwd, env: parsed.env } as GitContext;
		let result: ExecResult;
		try {
			result = await scopes.run(scope, () =>
				git.execute(parsed.args, { ...gitCtx, fs: recordingWrites(ctx.fs, parsed.cwd, written) } as GitContext),
			);
		} catch (err) {
			// A throw skips the exit-code path below, and just-bash still commits the script.
			await removeResidue(ctx.fs, scope.targets);
			throw err;
		}

		const removed = result.exitCode === 0 ? [] : await removeResidue(ctx.fs, scope.targets);
		// After the residue is gone, and on a non-zero exit too: a conflicted merge still wrote files.
		await applyIndexModes(ctx.fs, written, (root) =>
			git.execute(["ls-files", "-s", "-z"], { ...gitCtx, cwd: root } as GitContext),
		);
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
