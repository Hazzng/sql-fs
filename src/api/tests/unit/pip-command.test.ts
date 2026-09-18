import { createHash } from "node:crypto";
import { Bash, InMemoryFs } from "just-bash";
import type { SecureFetch } from "just-bash";
import { describe, expect, it } from "vitest";
import { pythonPackageCommands } from "../../commands/pip-command.js";

const encoder = new TextEncoder();

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/** Small stored ZIP writer so the tests do not depend on a host archive tool. */
function storedZip(entries: Record<string, string>): Uint8Array {
	const local: number[] = [];
	const central: number[] = [];
	let offset = 0;
	for (const [name, value] of Object.entries(entries)) {
		const nameBytes = encoder.encode(name);
		const content = encoder.encode(value);
		const crc = crc32(content);
		local.push(
			0x50,
			0x4b,
			0x03,
			0x04,
			...u16(20),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(crc),
			...u32(content.length),
			...u32(content.length),
			...u16(nameBytes.length),
			...u16(0),
			...nameBytes,
			...content,
		);
		central.push(
			0x50,
			0x4b,
			0x01,
			0x02,
			...u16(20),
			...u16(20),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(crc),
			...u32(content.length),
			...u32(content.length),
			...u16(nameBytes.length),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(offset),
			...nameBytes,
		);
		offset = local.length;
	}
	const end = [
		0x50,
		0x4b,
		0x05,
		0x06,
		...u16(0),
		...u16(0),
		...u16(Object.keys(entries).length),
		...u16(Object.keys(entries).length),
		...u32(central.length),
		...u32(local.length),
		...u16(0),
	];
	return Uint8Array.from([...local, ...central, ...end]);
}

function wheel(
	packageName: string,
	version: string,
	files: Record<string, string>,
	requiresDist: string[] = [],
	entryPoint?: string,
): Uint8Array {
	const distribution = packageName.replace(/[-_.]+/g, "_");
	const metadata = [
		"Metadata-Version: 2.1",
		`Name: ${packageName}`,
		`Version: ${version}`,
		...requiresDist.map((item) => `Requires-Dist: ${item}`),
		"",
		"",
	].join("\n");
	const allFiles: Record<string, string> = {
		...files,
		[`${distribution}-${version}.dist-info/METADATA`]: metadata,
		[`${distribution}-${version}.dist-info/WHEEL`]: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
	};
	if (entryPoint)
		allFiles[`${distribution}-${version}.dist-info/entry_points.txt`] =
			`[console_scripts]\ndatabricks = ${entryPoint}\n`;
	return storedZip(allFiles);
}

function sha256(body: Uint8Array): string {
	return createHash("sha256").update(body).digest("hex");
}

type PackageFixture = {
	readonly version: string;
	readonly body: Uint8Array;
	readonly requiresDist?: string[];
	readonly entryPoint?: string;
	readonly filename?: string;
};

type FetchResult = Awaited<ReturnType<SecureFetch>>;

function fixtureFetch(packages: Record<string, PackageFixture>, databricksResponse?: unknown): SecureFetch {
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
			const response = match?.[2]
				? {
						info: { version: fixture.version, requires_dist: fixture.requiresDist ?? [] },
						releases: { [fixture.version]: [artifact] },
						urls: [artifact],
					}
				: {
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
				body: encoder.encode(JSON.stringify(databricksResponse ?? { ok: true })),
				url,
			};
		}
		return { status: 403, statusText: "Forbidden", headers: {}, body: new Uint8Array(), url };
	};
}

function makeBash(packages: Record<string, PackageFixture>, databricksResponse?: unknown): Bash {
	return new Bash({
		fs: new InMemoryFs(),
		python: true,
		fetch: fixtureFetch(packages, databricksResponse),
		customCommands: pythonPackageCommands,
	});
}

describe("experimental SQL-FS pip commands", () => {
	it("rejects installs when network is disabled", async () => {
		const bash = new Bash({ fs: new InMemoryFs(), python: true, customCommands: pythonPackageCommands });
		const result = await bash.exec("pip install demo");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("network access is required");
	});

	it("returns a clear error for unsupported direct package syntax", async () => {
		const body = wheel("demo", "1.0", { "demo.py": "" });
		const result = await makeBash({ demo: { version: "1.0", body } }).exec("pip install demo[extra]");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("package extras are not supported");
	});

	it("verifies a wheel hash and persists imports for later python3 calls", async () => {
		const body = wheel("demo", "1.0", { "demo.py": "VALUE = 42\n" });
		const bash = makeBash({ demo: { version: "1.0", body } });
		const install = await bash.exec("pip3 install demo");
		expect(install.exitCode, install.stderr).toBe(0);
		expect(install.stdout).toContain("demo-1.0");
		expect(await bash.fs.exists("/site-packages/demo.py")).toBe(true);
		const imported = await bash.exec(`python3 -c "import demo; print(demo.VALUE)"`);
		expect(imported.exitCode, imported.stderr).toBe(0);
		expect(imported.stdout).toBe("42\n");
		const importedFromAnotherCwd = await bash.exec(`cd /tmp && python3 -c "import demo; print(demo.VALUE)"`);
		expect(importedFromAnotherCwd.exitCode, importedFromAnotherCwd.stderr).toBe(0);
		expect(importedFromAnotherCwd.stdout).toBe("42\n");
	});

	it("rejects a mismatched PyPI SHA-256 without extracting it", async () => {
		const body = wheel("demo", "1.0", { "demo.py": "VALUE = 1\n" });
		const fetch = fixtureFetch({ demo: { version: "1.0", body } });
		const bash = new Bash({
			fs: new InMemoryFs(),
			python: true,
			fetch: async (url, options) => {
				const response = await fetch(url, options);
				if (new URL(url).hostname === "pypi.org") {
					const value = JSON.parse(new TextDecoder().decode(response.body)) as {
						releases: Record<string, Array<{ digests: { sha256: string } }>>;
					};
					value.releases["1.0"]![0]!.digests.sha256 = "0".repeat(64);
					return { ...response, body: encoder.encode(JSON.stringify(value)) };
				}
				return response;
			},
			customCommands: pythonPackageCommands,
		});
		const result = await bash.exec("pip install demo");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("SHA-256 verification failed");
		expect(await bash.fs.exists("/site-packages/demo.py")).toBe(false);
	});

	it("rejects zip traversal and unsupported native wheels", async () => {
		const traversal = wheel("demo", "1.0", { "../escape.py": "pwned = True\n" });
		const traversalBash = makeBash({ demo: { version: "1.0", body: traversal } });
		const traversalResult = await traversalBash.exec("pip install demo");
		expect(traversalResult.exitCode).toBe(1);
		expect(traversalResult.stderr).toContain("zip path traversal");
		expect(await traversalBash.fs.exists("/escape.py")).toBe(false);

		const nativeBody = wheel("native", "1.0", { "native.py": "" });
		const nativeBash = new Bash({
			fs: new InMemoryFs(),
			python: true,
			fetch: async (url) => {
				if (url.includes("pypi.org")) {
					const artifact = {
						filename: "native-1.0-cp313-cp313-macosx_14_0_arm64.whl",
						url: "https://files.pythonhosted.org/native.whl",
						packagetype: "bdist_wheel",
						digests: { sha256: sha256(nativeBody) },
					};
					return {
						status: 200,
						statusText: "OK",
						headers: {},
						body: encoder.encode(
							JSON.stringify({
								info: { version: "1.0", requires_dist: [] },
								releases: { "1.0": [artifact] },
								urls: [artifact],
							}),
						),
						url,
					};
				}
				return { status: 200, statusText: "OK", headers: {}, body: nativeBody, url };
			},
			customCommands: pythonPackageCommands,
		});
		const nativeResult = await nativeBash.exec("pip install native");
		expect(nativeResult.exitCode).toBe(1);
		expect(nativeResult.stderr).toContain("pure-Python");
	});

	it("bounds extracted file count and PyPI redirects", async () => {
		const manyFiles = Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [`demo_${index}.py`, ""]));
		const tooManyFiles = wheel("demo", "1.0", manyFiles);
		const tooManyFilesBash = makeBash({ demo: { version: "1.0", body: tooManyFiles } });
		const tooManyFilesResult = await tooManyFilesBash.exec("pip install demo");
		expect(tooManyFilesResult.exitCode).toBe(1);
		expect(tooManyFilesResult.stderr).toContain("file limit");

		const redirectBash = new Bash({
			fs: new InMemoryFs(),
			python: true,
			fetch: async (url) => ({
				status: 302,
				statusText: "Found",
				headers: { location: url },
				body: new Uint8Array(),
				url,
			}),
			customCommands: pythonPackageCommands,
		});
		const redirectResult = await redirectBash.exec("pip install demo");
		expect(redirectResult.exitCode).toBe(1);
		expect(redirectResult.stderr).toContain("redirect");
	});

	it("resolves a dependency, invokes the installed databricks console module, and adapts requests through jb_http", async () => {
		const requests = wheel("requests", "1.0", {
			"requests/__init__.py":
				"from .models import Response\nfrom .sessions import Session\ndef request(method, url, **kwargs): return Session().request(method, url, **kwargs)\ndef get(url, **kwargs): return request('GET', url, **kwargs)\ndef post(url, **kwargs): return request('POST', url, **kwargs)\n",
			"requests/models.py":
				"class Response:\n    def __init__(self): self.status_code = 0\n    def json(self): return __import__('json').loads(self._content.decode())\n",
			"requests/sessions.py":
				"class Session:\n    def request(self, method, url, **kwargs): raise RuntimeError('unpatched')\n",
			"requests/structures.py": "class CaseInsensitiveDict(dict):\n    pass\n",
		});
		const cli = wheel(
			"databricks-cli",
			"0.18.0",
			{
				"databricks_cli/__init__.py": "",
				"databricks_cli/cli.py":
					"import requests\ndef main():\n    print(requests.get('https://db.test/api').json()['ok'])\n",
			},
			["requests>=1.0"],
			"databricks_cli.cli:main",
		);
		const bash = makeBash(
			{
				"databricks-cli": {
					version: "0.18.0",
					body: cli,
					requiresDist: ["requests>=1.0"],
					entryPoint: "databricks_cli.cli:main",
				},
				requests: { version: "1.0", body: requests },
			},
			{ ok: true },
		);
		const install = await bash.exec("pip install databricks-cli");
		expect(install.exitCode, install.stderr).toBe(0);
		const command = await bash.exec("databricks workspace list /");
		expect(command.exitCode, command.stderr).toBe(0);
		expect(command.stdout).toBe("True\n");
	});

	it("redacts Databricks credentials from console output", async () => {
		const cli = wheel(
			"databricks-cli",
			"0.18.0",
			{
				"databricks_cli/__init__.py": "",
				"databricks_cli/cli.py": "import os\ndef main():\n    print(os.environ.get('DATABRICKS_TOKEN'))\n",
			},
			[],
			"databricks_cli.cli:main",
		);
		const bash = makeBash({ "databricks-cli": { version: "0.18.0", body: cli } });
		expect((await bash.exec("pip install databricks-cli")).exitCode).toBe(0);
		const result = await bash.exec("databricks workspace list /", { env: { DATABRICKS_TOKEN: "test-secret" } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("[REDACTED]\n");
		expect(result.stdout).not.toContain("test-secret");
	});
});
