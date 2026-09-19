/**
 * #168: the EFBIG message is a deliverable, not a label.
 *
 * The caller that trips this cap is an AI agent with no human in the loop, so the message has
 * to carry everything it needs to recover on its own: that the limit is deliberate (do not
 * retry the identical call), both numbers, the smaller calls to reach for instead, and the env
 * var an operator reading the same line in a log would raise. These assertions exist so a
 * later refactor cannot quietly degrade it back into a bare code.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { clientSafeErrorMessage } from "../../../api/errors.js";
import { createEfbig, sanitizeFsError } from "../../errors.js";

const DEFAULT_MCP_READ_BYTES = 16 * 1024 * 1024;
const DEFAULT_FILE_WRITE_BYTES = 50 * 1024 * 1024;

describe("createEfbig — message content", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	const readErr = createEfbig("/data/big.log", 17_825_792, 8_388_608, "read");
	const writeErr = createEfbig("/out.txt", 52_428_800, 8_388_608, "write");

	it("sets code EFBIG and the offending path", () => {
		expect((readErr as Error & { code: string; path: string }).code).toBe("EFBIG");
		expect((readErr as Error & { code: string; path: string }).path).toBe("/data/big.log");
	});

	it("states the attempted size and the limit as numbers", () => {
		expect(readErr.message).toContain("17825792 bytes");
		expect(readErr.message).toContain("the per-file exec limit is 8388608 bytes");
	});

	it("says the limit is deliberate and that retrying will not help", () => {
		expect(readErr.message).toContain("This is a deliberate limit, not a transient failure");
		expect(readErr.message).toContain("the same command will fail again");
	});

	it("names the env var an operator would raise", () => {
		expect(readErr.message).toContain("MAX_EXEC_FILE_BYTES");
		expect(writeErr.message).toContain("MAX_EXEC_FILE_BYTES");
	});

	it("points a read caller at the one ungated route and warns the slicing commands do not help", () => {
		expect(readErr.message).toContain("`GET .../files/{path}`, the one read path this limit does not apply to");
		expect(readErr.message).toContain("Slicing it in the sandbox does NOT help");
		for (const cmd of ["`head -c`", "`tail -c`", "`split -b`", "`sed -n`"]) {
			expect(readErr.message.indexOf(cmd)).toBeGreaterThan(readErr.message.indexOf("does NOT help"));
		}
	});

	it("qualifies MCP file_read with the configured ceiling, not a hardcoded default", () => {
		expect(readErr.message).toContain(`MCP \`file_read\` is capped separately at ${DEFAULT_MCP_READ_BYTES} bytes`);
		expect(readErr.message).toContain("MAX_MCP_READ_FILE_BYTES");
		expect(readErr.message).not.toContain("16 MiB");
	});

	it("tells a write caller to split the output, and names the write and edit routes", () => {
		expect(writeErr.message).toContain("writing '/out.txt' would produce 52428800 bytes");
		expect(writeErr.message).toContain("write several smaller files");
		expect(writeErr.message).toContain("reading from a pipe rather than the oversized file");
		expect(writeErr.message).toContain("`PUT .../files/{path}` (MCP `file_write`)");
		expect(writeErr.message).toContain("`PATCH .../files/{path}` (MCP `file_edit`)");
		expect(writeErr.message).toContain(`capped independently at ${DEFAULT_FILE_WRITE_BYTES} bytes`);
		expect(writeErr.message).toContain("MAX_FILE_WRITE_BYTES");
		expect(writeErr.message).not.toContain("larger");
		expect(writeErr.message).not.toContain("50 MiB");
	});

	it("interpolates overridden sibling caps so the remedy matches this process", () => {
		vi.stubEnv("MAX_MCP_READ_FILE_BYTES", `${8 * 1024 * 1024}`);
		vi.stubEnv("MAX_FILE_WRITE_BYTES", `${10 * 1024 * 1024}`);
		const read = createEfbig("/x", 12 * 1024 * 1024, 10 * 1024 * 1024, "read");
		const write = createEfbig("/x", 12 * 1024 * 1024, 10 * 1024 * 1024, "write");
		expect(read.message).toContain(`capped separately at ${8 * 1024 * 1024} bytes`);
		expect(write.message).toContain(`capped independently at ${10 * 1024 * 1024} bytes`);
	});

	// Same path, same numbers — only the direction differs, so a generic message that
	// dropped the per-direction remediation would collapse the two into one string.
	it("distinguishes the two directions rather than emitting one generic message", () => {
		const asRead = createEfbig("/x", 10, 5, "read");
		const asWrite = createEfbig("/x", 10, 5, "write");

		expect(asRead.message).not.toBe(asWrite.message);
		expect(asWrite.message).not.toContain("Slicing it in the sandbox does NOT help");
		expect(asRead.message).not.toContain("write several smaller files");
	});

	// Guard against the redaction trap: SENSITIVE_PATTERNS strips the literal word
	// "sandboxes" and /var|/tmp|/home-style prefixes, so a remediation hint phrased as
	// "GET /v1/sandboxes/{id}/files/..." would reach the client as "[redacted]".
	it("survives sanitizeFsError with the remediation hint intact", () => {
		expect(sanitizeFsError(readErr).message).toContain("`GET .../files/{path}`");
		expect(sanitizeFsError(readErr).message).toBe(readErr.message);
		expect(sanitizeFsError(writeErr).message).toContain("`PUT .../files/{path}`");
		expect(sanitizeFsError(writeErr).message).toBe(writeErr.message);
	});

	it("reaches an API client unredacted through clientSafeErrorMessage", () => {
		expect(clientSafeErrorMessage(readErr)).toBe(readErr.message);
	});
});
