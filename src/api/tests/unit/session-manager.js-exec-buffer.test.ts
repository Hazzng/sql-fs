/**
 * Regression tests for issue #74: Buffer.from().toString('base64') was a no-op.
 *
 * The just-bash Buffer shim ignores the `encoding` argument on both
 * `Buffer.from(str, enc)` and `buf.toString(enc)`.  We patch those methods via
 * a JavaScriptConfig.bootstrap snippet injected at session creation time.
 *
 * These tests exercise the js-exec worker end-to-end (real QuickJS) so they
 * confirm the patch actually reaches the sandbox, not just that the TypeScript
 * compiles correctly.
 */

import { InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../session-manager.js";

const T = "default";

async function makeJsSession(sandboxId: string): Promise<SessionManager> {
	const sm = new SessionManager({ createFs: async () => new InMemoryFs() });
	await sm.getOrCreate(T, sandboxId, { python: false, javascript: true });
	return sm;
}

async function jsExec(sm: SessionManager, sandboxId: string, code: string): Promise<string> {
	return sm.withExistingSession(T, sandboxId, async (session) => {
		const result = await session.bash.exec(`js-exec -c ${JSON.stringify(code)}`);
		return result.stdout.trim();
	});
}

describe("js-exec Buffer encoding fix (issue #74)", () => {
	// ── base64 encode ───────────────────────────────────────────────────────

	it("Buffer.from(str).toString('base64') encodes correctly", async () => {
		const sm = await makeJsSession("buf-b64-encode");
		const out = await jsExec(sm, "buf-b64-encode", `console.log(Buffer.from("hello").toString("base64"))`);
		expect(out).toBe("aGVsbG8=");
	});

	it("Buffer.from([0xff,0xfe,0x00]).toString('base64') encodes binary bytes", async () => {
		const sm = await makeJsSession("buf-b64-bytes");
		const out = await jsExec(
			sm,
			"buf-b64-bytes",
			`console.log(Buffer.from([0xff,0xfe,0x00]).toString("base64"))`,
		);
		expect(out).toBe("//4A");
	});

	// ── base64 decode ───────────────────────────────────────────────────────

	it("Buffer.from(b64str, 'base64').toString() decodes correctly", async () => {
		const sm = await makeJsSession("buf-b64-decode");
		const out = await jsExec(
			sm,
			"buf-b64-decode",
			`console.log(Buffer.from("aGVsbG8=", "base64").toString())`,
		);
		expect(out).toBe("hello");
	});

	it("base64 round-trip encode → decode preserves content", async () => {
		const sm = await makeJsSession("buf-b64-rt");
		const out = await jsExec(
			sm,
			"buf-b64-rt",
			`var e = Buffer.from("hello world").toString("base64"); ` +
				`var d = Buffer.from(e, "base64").toString(); ` +
				`console.log(e + "|" + d)`,
		);
		expect(out).toBe("aGVsbG8gd29ybGQ=|hello world");
	});

	// ── base64url ───────────────────────────────────────────────────────────

	it("Buffer.from(str).toString('base64url') produces url-safe no-padding encoding", async () => {
		const sm = await makeJsSession("buf-b64url-enc");
		// 0xfb=11111011, 0xff=11111111 → base64: '//' → base64url: '--' (idx 62) and '_' (idx 63)
		const out = await jsExec(
			sm,
			"buf-b64url-enc",
			`console.log(Buffer.from([0xfb, 0xff]).toString("base64url"))`,
		);
		// Verify no '+', '/', or '=' characters (url-safe, no padding)
		expect(out).not.toMatch(/[+/=]/);
		// Verify it decodes back correctly
		const rt = await jsExec(
			sm,
			"buf-b64url-enc",
			`var e = Buffer.from([0xfb, 0xff]).toString("base64url"); ` +
				`var d = Buffer.from(e, "base64url"); ` +
				`console.log(d.readUInt8(0) + "," + d.readUInt8(1))`,
		);
		expect(rt).toBe("251,255");
	});

	it("Buffer.from(b64url, 'base64url') decodes url-safe encoding", async () => {
		const sm = await makeJsSession("buf-b64url-dec");
		const out = await jsExec(
			sm,
			"buf-b64url-dec",
			`var e = Buffer.from("hello").toString("base64url"); ` +
				`var d = Buffer.from(e, "base64url").toString(); ` +
				`console.log(e + "|" + d)`,
		);
		expect(out).toBe("aGVsbG8|hello");
	});

	// ── hex encode ──────────────────────────────────────────────────────────

	it("Buffer.from(str).toString('hex') encodes to hex", async () => {
		const sm = await makeJsSession("buf-hex-encode");
		const out = await jsExec(sm, "buf-hex-encode", `console.log(Buffer.from("abc").toString("hex"))`);
		expect(out).toBe("616263");
	});

	it("Buffer.from([0x00,0xff]).toString('hex') encodes boundary bytes", async () => {
		const sm = await makeJsSession("buf-hex-bytes");
		const out = await jsExec(
			sm,
			"buf-hex-bytes",
			`console.log(Buffer.from([0x00,0xff]).toString("hex"))`,
		);
		expect(out).toBe("00ff");
	});

	// ── hex decode ──────────────────────────────────────────────────────────

	it("Buffer.from('616263', 'hex').toString() decodes from hex", async () => {
		const sm = await makeJsSession("buf-hex-decode");
		const out = await jsExec(
			sm,
			"buf-hex-decode",
			`console.log(Buffer.from("616263", "hex").toString())`,
		);
		expect(out).toBe("abc");
	});

	it("hex round-trip encode → decode preserves content", async () => {
		const sm = await makeJsSession("buf-hex-rt");
		const out = await jsExec(
			sm,
			"buf-hex-rt",
			`var e = Buffer.from("hello").toString("hex"); ` +
				`var d = Buffer.from(e, "hex").toString(); ` +
				`console.log(e + "|" + d)`,
		);
		expect(out).toBe("68656c6c6f|hello");
	});

	// ── latin1 / binary ─────────────────────────────────────────────────────

	it("Buffer.from([0x41,0xc3]).toString('latin1') gives latin1 string with correct char codes", async () => {
		const sm = await makeJsSession("buf-latin1-encode");
		const out = await jsExec(
			sm,
			"buf-latin1-encode",
			// latin1: each byte maps to the char with that code point (0x00–0xFF)
			`var s = Buffer.from([0x41, 0xc3]).toString("latin1"); ` +
				`console.log(s.length + "," + s.charCodeAt(0) + "," + s.charCodeAt(1))`,
		);
		expect(out).toBe("2,65,195");
	});

	it("Buffer.from(str, 'latin1') decodes latin1 string to bytes", async () => {
		const sm = await makeJsSession("buf-latin1-decode");
		const out = await jsExec(
			sm,
			"buf-latin1-decode",
			`var b = Buffer.from(String.fromCharCode(65, 195), "latin1"); ` +
				`console.log(b.readUInt8(0) + "," + b.readUInt8(1))`,
		);
		expect(out).toBe("65,195");
	});

	// ── utf8 (default) still works ───────────────────────────────────────────

	it("Buffer.from(str).toString('utf8') still works correctly", async () => {
		const sm = await makeJsSession("buf-utf8");
		const out = await jsExec(sm, "buf-utf8", `console.log(Buffer.from("hello").toString("utf8"))`);
		expect(out).toBe("hello");
	});

	it("Buffer.from(str).toString() (no encoding) still works correctly", async () => {
		const sm = await makeJsSession("buf-default");
		const out = await jsExec(sm, "buf-default", `console.log(Buffer.from("hello").toString())`);
		expect(out).toBe("hello");
	});

	// ── the original bug: round-trip was masking both directions being no-ops ──

	it("base64 encode and decode are NOT both no-ops (the original bug)", async () => {
		const sm = await makeJsSession("buf-noop-regression");
		const out = await jsExec(
			sm,
			"buf-noop-regression",
			// If encode was a no-op, e === "hello" (not "aGVsbG8=")
			`var e = Buffer.from("hello").toString("base64"); ` + `console.log(e !== "hello" ? "ok" : "noop")`,
		);
		expect(out).toBe("ok");
	});
});
