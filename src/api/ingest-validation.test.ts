/**
 * Unit tests for the shared manifest-path / base64 validators.
 * Both the HTTP `/ingest-files` route and the MCP `fs_ingest` tool depend on
 * these — drift between them is the bug class we're guarding against here.
 */

import { describe, expect, it } from "vitest";
import { isValidBase64, isValidRelativePath } from "./ingest-validation.js";

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
	])("rejects malformed base64 %p — %s", (s) => {
		expect(isValidBase64(s)).toBe(false);
	});
});
