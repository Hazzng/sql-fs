import { InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { httpsOnlyGitFetch } from "../../commands/git-command.js";
import { SessionManager, buildSandboxBaseEnv, deriveExecGitCredentials } from "../../session-manager.js";

const T = "default";

const GIT_IDENTITY = "GIT_AUTHOR_NAME=a GIT_AUTHOR_EMAIL=a@x.com GIT_COMMITTER_NAME=a GIT_COMMITTER_EMAIL=a@x.com";

function makeSessionManager(): SessionManager {
	return new SessionManager({
		createFs: async () => new InMemoryFs(),
		defenseInDepth: false,
	});
}

describe("buildSandboxBaseEnv", () => {
	it("exports GitHub token auth env and optional git identity only when set", () => {
		expect(buildSandboxBaseEnv({})).toEqual({});

		expect(
			buildSandboxBaseEnv({
				GITHUB_TOKEN: "server-token",
				GIT_AUTHOR_NAME: "Agent",
				GIT_AUTHOR_EMAIL: "agent@example.com",
				GIT_COMMITTER_NAME: "",
			}),
		).toEqual({
			GITHUB_TOKEN: "server-token",
			GIT_HTTP_USER: "x-access-token",
			GIT_HTTP_PASSWORD: "server-token",
			GIT_AUTHOR_NAME: "Agent",
			GIT_AUTHOR_EMAIL: "agent@example.com",
		});
	});
});

describe("deriveExecGitCredentials", () => {
	it("re-points git's credentials at a per-request token", () => {
		expect(deriveExecGitCredentials({ GITHUB_TOKEN: "request-token" }, true)).toEqual({
			GITHUB_TOKEN: "request-token",
			GIT_HTTP_USER: "x-access-token",
			GIT_HTTP_PASSWORD: "request-token",
		});
	});

	it("keeps an explicit git credential and derives the half the request left out", () => {
		expect(deriveExecGitCredentials({ GITHUB_TOKEN: "request-token", GIT_HTTP_PASSWORD: "explicit" }, true)).toEqual({
			GITHUB_TOKEN: "request-token",
			GIT_HTTP_USER: "x-access-token",
			GIT_HTTP_PASSWORD: "explicit",
		});
	});

	// A request that pins only the username must not keep authenticating with the deployment
	// token: the base env's GIT_HTTP_PASSWORD would otherwise survive the merge untouched.
	it("derives the password when the request pins only the username", () => {
		expect(deriveExecGitCredentials({ GITHUB_TOKEN: "request-token", GIT_HTTP_USER: "oauth2" }, true)).toEqual({
			GITHUB_TOKEN: "request-token",
			GIT_HTTP_USER: "oauth2",
			GIT_HTTP_PASSWORD: "request-token",
		});
	});

	it("overwrites the inherited basic pair even when the request supplies a bearer token", () => {
		expect(deriveExecGitCredentials({ GITHUB_TOKEN: "request-token", GIT_HTTP_BEARER_TOKEN: "bearer" }, true)).toEqual({
			GITHUB_TOKEN: "request-token",
			GIT_HTTP_BEARER_TOKEN: "bearer",
			GIT_HTTP_USER: "x-access-token",
			GIT_HTTP_PASSWORD: "request-token",
		});
	});

	it("leaves an empty token override inert rather than falling back to the server token", () => {
		expect(deriveExecGitCredentials({ GITHUB_TOKEN: "", GIT_HTTP_USER: "oauth2" }, true)).toEqual({
			GITHUB_TOKEN: "",
			GIT_HTTP_USER: "oauth2",
			GIT_HTTP_PASSWORD: "",
		});
	});

	it("passes through an env without a token override, and a sandbox without network", () => {
		expect(deriveExecGitCredentials({ FOO: "bar" }, true)).toEqual({ FOO: "bar" });
		expect(deriveExecGitCredentials({ GITHUB_TOKEN: "request-token" }, false)).toEqual({
			GITHUB_TOKEN: "request-token",
		});
		expect(deriveExecGitCredentials(undefined, true)).toBeUndefined();
	});
});

describe("httpsOnlyGitFetch", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** A redirect response `fetch` hands back under `redirect: "manual"`. */
	function redirectTo(location: string, status = 302): Response {
		return new Response(null, { status, headers: { location } });
	}

	it("refuses a plaintext remote before the request leaves the process", async () => {
		const spy = vi.fn();
		vi.stubGlobal("fetch", spy);

		await expect(httpsOnlyGitFetch("http://git.test/repo/info/refs")).rejects.toThrow(
			/refusing to send credentials over plaintext HTTP/,
		);
		expect(spy).not.toHaveBeenCalled();
	});

	it("passes an https response through untouched", async () => {
		const ok = new Response("refs");
		const spy = vi.fn(async () => ok);
		vi.stubGlobal("fetch", spy);

		await expect(httpsOnlyGitFetch("https://git.test/repo/info/refs")).resolves.toBe(ok);
		expect(spy).toHaveBeenCalledTimes(1);
		const [url, requestInit] = spy.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://git.test/repo/info/refs");
		expect(requestInit.redirect).toBe("manual");
	});

	it("refuses a redirect down to plaintext without making the request", async () => {
		const spy = vi.fn(async () => redirectTo("http://git.test/repo/info/refs"));
		vi.stubGlobal("fetch", spy);

		await expect(httpsOnlyGitFetch("https://git.test/repo/info/refs")).rejects.toThrow(/redirected to plaintext HTTP/);
		// The plaintext hop was never requested — only the original https URL was.
		expect(spy).toHaveBeenCalledTimes(1);
	});

	// A chain that dips through http:// and back would look clean if only the final URL were checked.
	it("refuses a plaintext hop even when the chain ends back on https", async () => {
		const spy = vi.fn(async (url: string) =>
			url === "https://git.test/a" ? redirectTo("http://git.test/b") : new Response("refs"),
		);
		vi.stubGlobal("fetch", spy);

		await expect(httpsOnlyGitFetch("https://git.test/a")).rejects.toThrow(/redirected to plaintext HTTP/);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("follows an https redirect, keeping credentials for the same origin", async () => {
		const ok = new Response("refs");
		const spy = vi.fn(async (url: string) => (url === "https://git.test/a" ? redirectTo("/b") : ok));
		vi.stubGlobal("fetch", spy);

		const response = await httpsOnlyGitFetch("https://git.test/a", {
			headers: { authorization: "Basic dG9rZW4=" },
		});

		expect(response).toBe(ok);
		expect(spy).toHaveBeenCalledTimes(2);
		const [url, requestInit] = spy.mock.calls[1] as unknown as [string, RequestInit];
		expect(url).toBe("https://git.test/b");
		expect(new Headers(requestInit.headers).get("authorization")).toBe("Basic dG9rZW4=");
	});

	it("drops credentials when a redirect crosses origins", async () => {
		const ok = new Response("refs");
		const spy = vi.fn(async (url: string) => (url === "https://git.test/a" ? redirectTo("https://mirror.test/a") : ok));
		vi.stubGlobal("fetch", spy);

		await httpsOnlyGitFetch("https://git.test/a", { headers: { authorization: "Basic dG9rZW4=" } });

		const [url, requestInit] = spy.mock.calls[1] as unknown as [string, RequestInit];
		expect(url).toBe("https://mirror.test/a");
		expect(new Headers(requestInit.headers).get("authorization")).toBe(null);
	});

	it("gives up on a redirect loop", async () => {
		const spy = vi.fn(async () => redirectTo("https://git.test/loop"));
		vi.stubGlobal("fetch", spy);

		await expect(httpsOnlyGitFetch("https://git.test/loop")).rejects.toThrow(/redirected more than 5 times/);
		expect(spy).toHaveBeenCalledTimes(6);
	});

	it("replays a POST body across a redirect, and drops it on a 303", async () => {
		const ok = new Response("done");
		const spy = vi.fn(async (url: string) =>
			url === "https://git.test/push" ? redirectTo("https://git.test/moved", 303) : ok,
		);
		vi.stubGlobal("fetch", spy);

		await httpsOnlyGitFetch("https://git.test/push", { method: "POST", body: new Uint8Array([1, 2, 3]) });

		const [, first] = spy.mock.calls[0] as unknown as [string, RequestInit];
		const [, second] = spy.mock.calls[1] as unknown as [string, RequestInit];
		expect(first.method).toBe("POST");
		expect(new Uint8Array(first.body as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
		expect(second.method).toBe("GET");
		expect(second.body).toBeUndefined();
	});
});

describe("SessionManager git command", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("registers git for local init/add/commit/log without network", async () => {
		const sm = makeSessionManager();
		const session = await sm.getOrCreate(T, "git-local-cycle", { python: false, javascript: false, network: false });

		const result = await session.bash.exec(
			["git init", "echo hi > a.txt", "git add .", `${GIT_IDENTITY} git commit -m init`, "git log --oneline"].join(
				" && ",
			),
		);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("init");
	});

	it("blocks remote git operations cleanly when network is disabled", async () => {
		const sm = makeSessionManager();
		const session = await sm.getOrCreate(T, "git-network-blocked", {
			python: false,
			javascript: false,
			network: false,
		});

		const result = await session.bash.exec("git clone https://github.com/x/y");

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/network|disabled|blocked|not allowed/i);
	});

	it("does not inject server GitHub token credentials when network is disabled", async () => {
		vi.stubEnv("GITHUB_TOKEN", "server-token");
		const sm = makeSessionManager();
		const session = await sm.getOrCreate(T, "git-token-env", { python: false, javascript: false, network: false });

		const result = await session.bash.exec("env");

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).not.toMatch(/^GITHUB_TOKEN=/m);
		expect(result.stdout).not.toMatch(/^GIT_HTTP_USER=/m);
		expect(result.stdout).not.toMatch(/^GIT_HTTP_PASSWORD=/m);
	});

	it("injects server GitHub token env for network-enabled sandboxes and lets per-request env override it", async () => {
		vi.stubEnv("GITHUB_TOKEN", "server-token");
		const sm = makeSessionManager();
		const session = await sm.getOrCreate(T, "git-token-network-env", {
			python: false,
			javascript: false,
			network: true,
		});

		await expect(
			session.bash.exec('printf \'%s:%s:%s\' "$GITHUB_TOKEN" "$GIT_HTTP_USER" "$GIT_HTTP_PASSWORD"'),
		).resolves.toMatchObject({
			exitCode: 0,
			stdout: "server-token:x-access-token:server-token",
		});

		await expect(
			session.bash.exec('printf \'%s:%s:%s\' "$GITHUB_TOKEN" "$GIT_HTTP_USER" "$GIT_HTTP_PASSWORD"', {
				env: { GITHUB_TOKEN: "override", GIT_HTTP_USER: "override-user", GIT_HTTP_PASSWORD: "override-password" },
			}),
		).resolves.toMatchObject({
			exitCode: 0,
			stdout: "override:override-user:override-password",
		});

		await expect(
			session.bash.exec('printf \'%s:%s:%s\' "$GITHUB_TOKEN" "$GIT_HTTP_USER" "$GIT_HTTP_PASSWORD"'),
		).resolves.toMatchObject({
			exitCode: 0,
			stdout: "server-token:x-access-token:server-token",
		});
	});

	it("routes a per-request GITHUB_TOKEN through to git's credentials on the exec path", async () => {
		vi.stubEnv("GITHUB_TOKEN", "server-token");
		const sm = makeSessionManager();
		const session = await sm.getOrCreate(T, "git-token-exec-override", {
			python: false,
			javascript: false,
			network: true,
		});
		const probe = 'printf \'%s:%s:%s\' "$GITHUB_TOKEN" "$GIT_HTTP_USER" "$GIT_HTTP_PASSWORD"';

		// An override of GITHUB_TOKEN alone must not leave git pushing as the server identity.
		await expect(
			sm.execWithRuntimeThrottle(session, probe, { env: { GITHUB_TOKEN: "request-token" } }),
		).resolves.toMatchObject({ exitCode: 0, stdout: "request-token:x-access-token:request-token" });

		// The next exec without an override is back on the deployment credentials.
		await expect(sm.execWithRuntimeThrottle(session, probe)).resolves.toMatchObject({
			exitCode: 0,
			stdout: "server-token:x-access-token:server-token",
		});
	});

	it("omits GitHub token env when the server env is unset", async () => {
		vi.stubEnv("GITHUB_TOKEN", undefined);
		const sm = makeSessionManager();
		const session = await sm.getOrCreate(T, "git-token-env-unset", {
			python: false,
			javascript: false,
			network: false,
		});

		const result = await session.bash.exec("env");

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).not.toMatch(/^GITHUB_TOKEN=/m);
		expect(result.stdout).not.toMatch(/^GIT_HTTP_USER=/m);
		expect(result.stdout).not.toMatch(/^GIT_HTTP_PASSWORD=/m);
	});
});
