import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPackageLimits } from "../../commands/package-limits.js";
import { fixtureFetch, makeBash, makeBashWithFetch, wheel } from "./pip-fixtures.js";

const encoder = new TextEncoder();

describe("experimental SQL-FS pip commands", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		resetPackageLimits();
	});

	it("rejects installs when network is disabled", async () => {
		const bash = makeBashWithFetch(undefined);
		const result = await bash.exec("pip install demo");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("network access is required");
	});

	it("installs the dependency an extra pulls in", async () => {
		const bash = makeBash({
			demo: {
				version: "1.0",
				body: wheel("demo", "1.0", { "demo.py": "" }, ['helper>=1.0; extra == "socks"']),
				requiresDist: ['helper>=1.0; extra == "socks"'],
			},
			helper: { version: "1.0", body: wheel("helper", "1.0", { "helper.py": "" }) },
		});
		const result = await bash.exec("pip install demo[socks]");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toBe("Successfully installed demo-1.0 helper-1.0\n");
	});

	it("refuses a direct install whose specifier carries a marker", async () => {
		const bash = makeBash({ demo: { version: "1.0", body: wheel("demo", "1.0", { "demo.py": "" }) } });
		const result = await bash.exec(`pip install 'demo; python_version > "3.0"'`);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("pip: package markers are not supported for direct installs\n");
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
		const bash = makeBashWithFetch(async (url, options) => {
			const response = await fetch(url, options);
			if (new URL(url).hostname === "pypi.org") {
				const value = JSON.parse(new TextDecoder().decode(response.body)) as {
					releases: Record<string, Array<{ digests: { sha256: string } }>>;
				};
				value.releases["1.0"]![0]!.digests.sha256 = "0".repeat(64);
				return { ...response, body: encoder.encode(JSON.stringify(value)) };
			}
			return response;
		});
		const result = await bash.exec("pip install demo");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("SHA-256 verification failed");
		expect(await bash.fs.exists("/site-packages/demo.py")).toBe(false);
	});

	it("rejects a wheel containing a zip path traversal", async () => {
		const body = wheel("demo", "1.0", { "../escape.py": "pwned = True\n" });
		const bash = makeBash({ demo: { version: "1.0", body } });
		const result = await bash.exec("pip install demo");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("demo 1.0: corrupt or hostile archive");
		expect(await bash.fs.exists("/escape.py")).toBe(false);
	});

	it("rejects a native platform wheel", async () => {
		const body = wheel("native", "1.0", { "native.py": "" });
		const bash = makeBash({
			native: { version: "1.0", body, filename: "native-1.0-cp313-cp313-macosx_14_0_arm64.whl" },
		});
		const result = await bash.exec("pip install native");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("pure-Python");
	});

	it("rejects a wheel exceeding the extracted file limit", async () => {
		vi.stubEnv("PIP_MAX_INSTALL_FILES", "4");
		resetPackageLimits();
		const manyFiles = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`demo_${index}.py`, ""]));
		const bash = makeBash({ demo: { version: "1.0", body: wheel("demo", "1.0", manyFiles) } });
		const result = await bash.exec("pip install demo");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("install exceeds 4 files (PIP_MAX_INSTALL_FILES)");
	});

	it("fails when PyPI exceeds the redirect limit", async () => {
		const bash = makeBashWithFetch(async (url) => ({
			status: 302,
			statusText: "Found",
			headers: { location: url },
			body: new Uint8Array(),
			url,
		}));
		const result = await bash.exec("pip install demo");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("redirect");
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
		const bash = makeBash({
			"databricks-cli": {
				version: "0.18.0",
				body: cli,
				requiresDist: ["requests>=1.0"],
				entryPoint: "databricks_cli.cli:main",
			},
			requests: { version: "1.0", body: requests },
		});
		const install = await bash.exec("pip install databricks-cli");
		expect(install.exitCode, install.stderr).toBe(0);
		const command = await bash.exec("databricks workspace list /");
		expect(command.exitCode, command.stderr).toBe(0);
		expect(command.stdout).toBe("True\n");
	});

	it("names the package and the limit when the fetch refuses an oversized response", async () => {
		const tooLarge = Object.assign(new Error("response exceeds the maximum allowed size of 10 bytes"), {
			name: "ResponseTooLargeError",
		});
		const bash = makeBashWithFetch(() => Promise.reject(tooLarge));
		const result = await bash.exec("pip install demo");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("pip: demo metadata exceeds the 16777216 byte response limit\n");
	});

	it("includes the underlying message for a non-pip failure", async () => {
		const bash = makeBashWithFetch(() => Promise.reject(new Error("socket hang up")));
		const result = await bash.exec("pip install demo");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("pip: package installation failed: socket hang up\n");
	});

	it("leaves a secret shorter than eight characters unredacted", async () => {
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
		const result = await bash.exec("databricks workspace list /", { env: { DATABRICKS_TOKEN: "short" } });
		expect(result.stdout).toBe("short\n");
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
