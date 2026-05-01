/**
 * Unit tests for the shared manifest-path / base64 validators.
 * Both the HTTP `/ingest-files` route and the MCP `fs_ingest` tool depend on
 * these — drift between them is the bug class we're guarding against here.
 */

import { describe, expect, it } from "vitest";
import { isValidBase64, isValidBasePath, isValidRelativePath } from "../ingest-validation.js";

describe("isValidRelativePath", () => {
	it.each([
		["src/index.ts", true],
		["a.txt", true],
		["deeply/nested/dir/file.md", true],
	])("accepts well-formed relative paths: %s", (p, expected) => {
		expect(isValidRelativePath(p)).toBe(expected);
	});

	it.each([
		["", "empty string would join to basePath itself"],
		["dir/", "trailing slash would normalize to basePath/dir and silently collide"],
		["a//b", "empty segments collapse on normalization and obscure the user's intent"],
		["/abs", "absolute paths bypass basePath"],
		["..", "parent traversal escapes the sandbox"],
		["a/../b", "embedded `..` escapes basePath after normalization"],
		[".", "current-dir segment normalizes away to basePath"],
		["a/./b", "embedded `.` segment normalizes to a/b — ambiguous"],
		["bad\0path", "null bytes are a known injection vector"],
	])("rejects malformed relative path %p — %s", (p) => {
		expect(isValidRelativePath(p)).toBe(false);
	});
});

describe("isValidBase64", () => {
	it.each([
		["", true],
		["YQ==", true],
		["YWI=", true],
		["YWJj", true],
		["YWJjZA==", true],
	])("accepts strict RFC 4648 strings: %s", (s, expected) => {
		expect(isValidBase64(s)).toBe(expected);
	});

	it.each([
		["abc", "length not divisible by 4"],
		["abcde", "length not divisible by 4"],
		["%%%not-base64%%%", "non-alphabet chars"],
		["YWJj YWJj", "whitespace is not allowed in strict base64"],
		["YWJj\n", "newline is not allowed"],
		["===", "padding-only is malformed"],
		["AZ==", "non-canonical: non-zero pad bits — decodes to 0x01 like AQ==, but doesn't round-trip"],
		["ab==", "non-canonical: pad bits set — decodes to 0x69 but re-encodes to aQ=="],
		["YQ", "missing required padding"],
		["YQ=", "wrong padding length for 1-byte payload"],
	])("rejects malformed base64 %p — %s", (s) => {
		expect(isValidBase64(s)).toBe(false);
	});
});

describe("isValidBasePath", () => {
	it.each(["/home/user", "/home/user/proj", "/tmp/work", "/a", "/home/user-1/proj_v2/src.dir"])(
		"accepts safe absolute path %p",
		(p) => {
			expect(isValidBasePath(p)).toBe(true);
		},
	);

	it.each([
		["", "empty string"],
		["home/user", "missing leading slash"],
		["./proj", "relative path"],
		["/home/user/../etc", ".. segment escapes basePath"],
		["/home/user;rm -rf", "shell metachar"],
		["/home/user $HOME", "shell expansion / spaces"],
		["/home/user\0", "null byte"],
		["/home/user\nproj", "newline"],
	])("rejects unsafe basePath %p — %s", (p) => {
		expect(isValidBasePath(p)).toBe(false);
	});
});
