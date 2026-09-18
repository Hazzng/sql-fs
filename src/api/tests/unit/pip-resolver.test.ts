import type { SecureFetch } from "just-bash";
import { afterEach, describe, expect, it } from "vitest";
import { type PackageFixture, fixtureFetch, makeBash, makeBashWithFetch, sha256, wheel } from "./pip-fixtures.js";

const encoder = new TextEncoder();

/** Records every URL the resolver asks for, so "no request for X" is assertable. */
function recordingFetch(packages: Record<string, PackageFixture>, seen: string[]): SecureFetch {
	const inner = fixtureFetch(packages);
	return (url, options) => {
		seen.push(url);
		return inner(url, options);
	};
}

const originalEnv = { ...process.env };

afterEach(() => {
	process.env = { ...originalEnv };
});

describe("synthetic requests provider", () => {
	it("satisfies a requests dependency without any request for it", async () => {
		const seen: string[] = [];
		const cli = wheel("databricks-cli", "0.18.0", { "databricks_cli/__init__.py": "" }, ["requests>=2.0"]);
		const bash = makeBashWithFetch(
			recordingFetch(
				{
					"databricks-cli": { version: "0.18.0", body: cli, requiresDist: ["requests>=2.0"] },
					requests: { version: "2.34.2", body: wheel("requests", "2.34.2", { "requests/__init__.py": "" }) },
					urllib3: { version: "2.0.0", body: wheel("urllib3", "2.0.0", { "urllib3/__init__.py": "" }) },
				},
				seen,
			),
		);
		const result = await bash.exec("pip install databricks-cli");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toBe("Successfully installed databricks-cli-0.18.0 requests-2.31.0\n");
		expect(seen.filter((url) => url.includes("requests"))).toEqual([]);
		expect(seen.filter((url) => url.includes("urllib3"))).toEqual([]);
	});

	it("writes the compatibility overlay for the synthetic provider", async () => {
		const bash = makeBash({
			demo: {
				version: "1.0",
				body: wheel("demo", "1.0", { "demo.py": "" }, ["requests"]),
				requiresDist: ["requests"],
			},
		});
		expect((await bash.exec("pip install demo")).exitCode).toBe(0);
		expect(await bash.fs.exists("/site-packages/_sqlfs_compat/requests/__init__.py")).toBe(true);
	});

	it("refuses a requests constraint the shim cannot satisfy", async () => {
		const bash = makeBash({
			demo: {
				version: "1.0",
				body: wheel("demo", "1.0", { "demo.py": "" }, ["requests>=3.0"]),
				requiresDist: ["requests>=3.0"],
			},
		});
		const result = await bash.exec("pip install demo");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("requests 2.31.0 through its jb_http compatibility shim");
		expect(result.stderr).toContain("requests>=3.0");
	});

	it("refuses an extra on the synthetic provider", async () => {
		const bash = makeBash({ demo: { version: "1.0", body: wheel("demo", "1.0", { "demo.py": "" }) } });
		const result = await bash.exec("pip install requests[socks]");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("provides no extras");
	});
});

describe("resolver hygiene", () => {
	it("fails naming the unknown marker variable", async () => {
		const bash = makeBash({
			demo: {
				version: "1.0",
				body: wheel("demo", "1.0", { "demo.py": "" }, ['helper; platform_libc == "glibc"']),
				requiresDist: ['helper; platform_libc == "glibc"'],
			},
			helper: { version: "1.0", body: wheel("helper", "1.0", { "helper.py": "" }) },
		});
		const result = await bash.exec("pip install demo");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("unknown dependency marker variable 'platform_libc'");
	});

	it("refuses a diamond whose deeper path exceeds the depth limit", async () => {
		// root → shallow (depth 1) and root → a → b → shallow (depth 3).
		// The short edge registers `shallow` first; only recomputing the
		// reachable depth when the long edge lands catches the violation.
		process.env.PIP_MAX_DEPENDENCY_DEPTH = "2";
		const packages: Record<string, PackageFixture> = {
			root: {
				version: "1.0",
				body: wheel("root", "1.0", { "root.py": "" }, ["shallow", "a"]),
				requiresDist: ["shallow", "a"],
			},
			shallow: { version: "1.0", body: wheel("shallow", "1.0", { "shallow.py": "" }) },
			a: { version: "1.0", body: wheel("a", "1.0", { "a.py": "" }, ["b"]), requiresDist: ["b"] },
			b: {
				version: "1.0",
				body: wheel("b", "1.0", { "b.py": "" }, ["shallow"]),
				requiresDist: ["shallow"],
			},
		};
		const result = await makeBash(packages).exec("pip install root");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("pip: dependency depth exceeds 2 at shallow\n");
	});

	it("caps the number of metadata requests per install", async () => {
		process.env.PIP_MAX_METADATA_REQUESTS = "1";
		const bash = makeBash({
			demo: {
				version: "1.0",
				body: wheel("demo", "1.0", { "demo.py": "" }, ["helper"]),
				requiresDist: ["helper"],
			},
			helper: { version: "1.0", body: wheel("helper", "1.0", { "helper.py": "" }) },
		});
		const result = await bash.exec("pip install demo");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("PIP_MAX_METADATA_REQUESTS");
	});

	it("caps the cumulative metadata bytes per install", async () => {
		process.env.PIP_MAX_METADATA_BYTES = "10";
		const bash = makeBash({ demo: { version: "1.0", body: wheel("demo", "1.0", { "demo.py": "" }) } });
		const result = await bash.exec("pip install demo");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("PIP_MAX_METADATA_BYTES");
	});

	it("skips a release whose Requires-Python excludes the runtime", async () => {
		const old = wheel("demo", "1.0", { "demo.py": "OLD = 1\n" });
		const fresh = wheel("demo", "2.0", { "demo.py": "NEW = 1\n" });
		const bash = makeBashWithFetch(async (url: string): Promise<Awaited<ReturnType<SecureFetch>>> => {
			const parsed = new URL(url);
			if (parsed.hostname === "pypi.org") {
				const file = (version: string, body: Uint8Array, requiresPython: string | null) => ({
					filename: `demo-${version}-py3-none-any.whl`,
					url: `https://files.pythonhosted.org/demo-${version}-py3-none-any.whl`,
					packagetype: "bdist_wheel",
					requires_python: requiresPython,
					digests: { sha256: sha256(body) },
				});
				const version = parsed.pathname.match(/^\/pypi\/demo\/([^/]+)\/json$/)?.[1];
				const document =
					version === undefined
						? {
								info: { version: "2.0", requires_dist: [], requires_python: "<3.13" },
								releases: { "1.0": [file("1.0", old, ">=3.8")], "2.0": [file("2.0", fresh, "<3.13")] },
							}
						: {
								info: {
									version,
									requires_dist: [],
									requires_python: version === "1.0" ? ">=3.8" : "<3.13",
								},
								urls: [version === "1.0" ? file("1.0", old, ">=3.8") : file("2.0", fresh, "<3.13")],
							};
				return { status: 200, statusText: "OK", headers: {}, body: encoder.encode(JSON.stringify(document)), url };
			}
			const body = parsed.pathname.includes("2.0") ? fresh : old;
			return { status: 200, statusText: "OK", headers: {}, body, url };
		});
		const result = await bash.exec("pip install demo");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toBe("Successfully installed demo-1.0\n");
	});

	it("reports the missing pure wheel rather than the candidate counter", async () => {
		const body = wheel("native", "1.0", { "native.py": "" });
		const releases: Record<string, unknown> = {};
		for (let index = 0; index < 80; index++) {
			releases[`1.${index}`] = [
				{
					filename: `native-1.${index}-cp313-cp313-manylinux1_x86_64.whl`,
					url: `https://files.pythonhosted.org/native-1.${index}.whl`,
					packagetype: "bdist_wheel",
					digests: { sha256: sha256(body) },
				},
			];
		}
		const bash = makeBashWithFetch(async (url) => ({
			status: 200,
			statusText: "OK",
			headers: {},
			body: encoder.encode(JSON.stringify({ info: { version: "1.79", requires_dist: [] }, releases })),
			url,
		}));
		const result = await bash.exec("pip install native");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("no supported pure-Python py3-none-any wheel");
		expect(result.stderr).not.toContain("too many candidate versions");
	});
});
