/** Shared wheel / PyPI fixtures for the experimental pip command tests. */
import { createHash } from "node:crypto";
import { Bash } from "just-bash";
import type { SecureFetch } from "just-bash";
import { type PythonPackageCommandOptions, createPythonPackageCommands } from "../../commands/pip-command.js";
import { type FakePackageFs, type PackageState, createPackageFs } from "./package-store-fake.js";
import { buildWheel } from "./wheel-fixtures.js";

const encoder = new TextEncoder();

/**
 * A RECORD-valid pure-Python wheel, built by the same fixture builder the
 * wheel-reader suites use — the installer now reads these through `readWheel`,
 * so a hand-rolled ZIP without a RECORD would be rejected before anything else.
 */
export function wheel(
	packageName: string,
	version: string,
	files: Record<string, string>,
	requiresDist: string[] = [],
	entryPoint?: string,
): Uint8Array {
	const distribution = packageName.replace(/[-_.]+/g, "_");
	return buildWheel({
		name: distribution,
		version,
		files,
		omitDefaultModule: true,
		metadataExtra: requiresDist.map((item) => `Requires-Dist: ${item}`),
		...(entryPoint ? { distInfoFiles: { "entry_points.txt": `[console_scripts]\ndatabricks = ${entryPoint}\n` } } : {}),
	});
}

export function sha256(body: Uint8Array): string {
	return createHash("sha256").update(body).digest("hex");
}

export type PackageFixture = {
	readonly version: string;
	readonly body: Uint8Array;
	readonly requiresDist?: string[];
	readonly entryPoint?: string;
	readonly filename?: string;
};

export type FetchResult = Awaited<ReturnType<SecureFetch>>;

export function fixtureFetch(packages: Record<string, PackageFixture>): SecureFetch {
	return async (url): Promise<FetchResult> => {
		const parsed = new URL(url);
		if (parsed.hostname === "pypi.org") {
			const match = parsed.pathname.match(/^\/pypi\/([^/]+)(?:\/([^/]+))?\/json$/);
			const packageName = match?.[1];
			const fixture = packageName ? packages[packageName] : undefined;
			if (!fixture) return { status: 404, statusText: "Not Found", headers: {}, body: encoder.encode("{}"), url };
			const filename = fixture.filename ?? `${packageName}-${fixture.version}-py3-none-any.whl`;
			const artifact = {
				filename,
				url: `https://files.pythonhosted.org/${filename}`,
				packagetype: "bdist_wheel",
				digests: { sha256: sha256(fixture.body) },
			};
			const response = {
				info: { version: fixture.version, requires_dist: fixture.requiresDist ?? [] },
				releases: { [fixture.version]: [artifact] },
				urls: [artifact],
			};
			return {
				status: 200,
				statusText: "OK",
				headers: { "content-type": "application/json" },
				body: encoder.encode(JSON.stringify(response)),
				url,
			};
		}
		if (parsed.hostname === "files.pythonhosted.org") {
			const filename = parsed.pathname.slice(1);
			const fixture = Object.entries(packages).find(
				([name, value]) => (value.filename ?? `${name}-${value.version}-py3-none-any.whl`) === filename,
			)?.[1];
			if (!fixture) return { status: 404, statusText: "Not Found", headers: {}, body: new Uint8Array(), url };
			return {
				status: 200,
				statusText: "OK",
				headers: { "content-type": "application/octet-stream" },
				body: fixture.body,
				url,
			};
		}
		if (parsed.hostname === "db.test") {
			return {
				status: 200,
				statusText: "OK",
				headers: { "content-type": "application/json" },
				body: encoder.encode(JSON.stringify({ ok: true })),
				url,
			};
		}
		return { status: 403, statusText: "Forbidden", headers: {}, body: new Uint8Array(), url };
	};
}

/**
 * A python-enabled shell whose filesystem carries a package store.
 *
 * The store is injected into the commands exactly as `SessionManager` does it,
 * because just-bash's defence-in-depth layer (on by default in a bare `Bash`)
 * replaces `ctx.fs` with an `IFileSystem`-only facade.
 */
export function makeBash(
	packages: Record<string, PackageFixture>,
	options: PythonPackageCommandOptions = {},
	state?: PackageState,
): Bash & { fs: FakePackageFs } {
	const fs = createPackageFs(state);
	return new Bash({
		fs,
		python: true,
		fetch: fixtureFetch(packages),
		customCommands: createPythonPackageCommands({ packageStore: fs, ...options }),
	}) as Bash & { fs: FakePackageFs };
}

/** `makeBash` with an arbitrary fetch — for the failure-shaped fetch doubles. */
export function makeBashWithFetch(
	fetch: SecureFetch | undefined,
	options: PythonPackageCommandOptions = {},
	state?: PackageState,
): Bash & { fs: FakePackageFs } {
	const fs = createPackageFs(state);
	return new Bash({
		fs,
		python: true,
		...(fetch ? { fetch } : {}),
		customCommands: createPythonPackageCommands({ packageStore: fs, ...options }),
	}) as Bash & { fs: FakePackageFs };
}
