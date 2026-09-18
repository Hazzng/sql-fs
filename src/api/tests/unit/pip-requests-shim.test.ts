/**
 * Unit tests for the single `requests` compatibility shim (v3 Phase 5).
 *
 * The module source is asserted directly, and the module itself is imported by
 * the built-in WASM python through the package-enabled `python3` override —
 * the same pattern pip-python-override.test.ts uses.
 */

import { Bash, InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import {
	HTTP_WRITE_ENV_VAR,
	REQUESTS_COMPAT_FILES,
	REQUESTS_FILES_UNSUPPORTED_MESSAGE,
	SYNTHETIC_REQUESTS_VERSION,
	pythonPackageCommands,
	requestsWriteDeniedMessage,
} from "../../commands/pip-command.js";
import { COMPAT_PACKAGES } from "../../commands/pip-shared.js";

/** The transport error raised once the shim's gate has been passed. */
const NO_NETWORK = "Network access not configured";

async function shellWithCompatOverlay(): Promise<Bash> {
	const bash = new Bash({ fs: new InMemoryFs(), python: true, customCommands: pythonPackageCommands });
	for (const [relativePath, content] of Object.entries(REQUESTS_COMPAT_FILES)) {
		const slash = relativePath.lastIndexOf("/");
		const directory = slash < 0 ? COMPAT_PACKAGES : `${COMPAT_PACKAGES}/${relativePath.slice(0, slash)}`;
		await bash.fs.mkdir(directory, { recursive: true });
		await bash.fs.writeFile(`${COMPAT_PACKAGES}/${relativePath}`, content);
	}
	return bash;
}

describe("requests compat module source", () => {
	it("declares the synthetic version and the full method surface", () => {
		const source = REQUESTS_COMPAT_FILES["requests/__init__.py"]!;
		expect(source).toContain(`__version__ = "${SYNTHETIC_REQUESTS_VERSION}"`);
		for (const name of ["request", "get", "head", "post", "put", "patch", "delete"]) {
			expect(source).toContain(`def ${name}(`);
		}
		expect(source).toContain("class Session:");
		expect(source).toContain("class Response:");
		expect(REQUESTS_COMPAT_FILES["requests/auth.py"]).toContain("class HTTPBasicAuth(AuthBase):");
	});

	it("gates the write methods on the env var the session manager exports", () => {
		const source = REQUESTS_COMPAT_FILES["requests/__init__.py"]!;
		expect(source).toContain(`WRITE_ENV_VAR = "${HTTP_WRITE_ENV_VAR}"`);
		expect(source).toContain("return os.environ.get(WRITE_ENV_VAR) == '1'");
		expect(source).toContain("WRITE_METHODS = ('POST', 'PUT', 'PATCH', 'DELETE')");
		expect(source).toContain("if not _writes_permitted():");
		expect(source).toContain("raise exceptions.NetworkWriteNotPermitted(");
		expect(REQUESTS_COMPAT_FILES["requests/exceptions.py"]).toContain(
			"class NetworkWriteNotPermitted(RequestException):",
		);
	});

	it("names the refused method in the denial message", () => {
		expect(requestsWriteDeniedMessage("POST")).toBe(
			"requests shim: POST requires a sandbox created with networkWrite: true; without it only GET and HEAD are permitted",
		);
	});
});

describe("requests compat module under WASM python", () => {
	it("refuses post() when SQLFS_HTTP_WRITE is not set", async () => {
		const bash = await shellWithCompatOverlay();
		const result = await bash.exec(`python3 -c "import requests; requests.post('https://example.com', data='{}')"`);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(requestsWriteDeniedMessage("POST"));
		expect(result.stderr).toContain("requests.exceptions.NetworkWriteNotPermitted");
		expect(result.stderr).not.toContain(NO_NETWORK);
	});

	it("refuses every write verb when SQLFS_HTTP_WRITE is not set", async () => {
		const bash = await shellWithCompatOverlay();
		for (const [method, call] of [
			["PUT", "requests.put('https://example.com', data='{}')"],
			["PATCH", "requests.patch('https://example.com', data='{}')"],
			["DELETE", "requests.delete('https://example.com')"],
		] as const) {
			const result = await bash.exec(`python3 -c "import requests; ${call}"`);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain(requestsWriteDeniedMessage(method));
		}
	});

	it("reaches the transport for post() when SQLFS_HTTP_WRITE=1", async () => {
		const bash = await shellWithCompatOverlay();
		const result = await bash.exec(`python3 -c "import requests; requests.post('https://example.com', data='{}')"`, {
			env: { [HTTP_WRITE_ENV_VAR]: "1" },
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).not.toContain("requires a sandbox created with networkWrite");
		// The gate passed: the failure now comes from the jb_http transport,
		// which this test shell has no network for.
		expect(result.stderr).toContain(NO_NETWORK);
	});

	it("rejects files= with the base64-in-JSON message when write capability is set", async () => {
		const bash = await shellWithCompatOverlay();
		const script = `python3 -c "import requests; requests.post('https://example.com', files={'f': 'x'})"`;
		const withWrite = await bash.exec(script, { env: { [HTTP_WRITE_ENV_VAR]: "1" } });
		expect(withWrite.exitCode).toBe(1);
		expect(withWrite.stderr).toContain(REQUESTS_FILES_UNSUPPORTED_MESSAGE);
		expect(withWrite.stderr).toContain("requests.exceptions.InvalidRequest");
		expect(REQUESTS_FILES_UNSUPPORTED_MESSAGE).toBe(
			"requests shim: files= is not supported; send the body as a JSON string via data= and base64-encode any binary field inside that JSON",
		);
	});

	it("rejects files= with the write-denied message when write capability is not set", async () => {
		const bash = await shellWithCompatOverlay();
		const script = `python3 -c "import requests; requests.post('https://example.com', files={'f': 'x'})"`;
		const withoutWrite = await bash.exec(script);
		expect(withoutWrite.exitCode).toBe(1);
		expect(withoutWrite.stderr).toContain(requestsWriteDeniedMessage("POST"));
	});

	it("still reaches the transport for get() without the write capability", async () => {
		const bash = await shellWithCompatOverlay();
		const result = await bash.exec(`python3 -c "import requests; requests.get('https://example.com')"`);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(NO_NETWORK);
	});
});
