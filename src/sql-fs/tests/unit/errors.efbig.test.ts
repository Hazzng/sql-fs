/**
 * #168: the EFBIG message is a deliverable, not a label.
 *
 * The caller that trips this cap is an AI agent with no human in the loop, so the message has
 * to carry everything it needs to recover on its own: that the limit is deliberate (do not
 * retry the identical call), both numbers, the smaller calls to reach for instead, and the env
 * var an operator reading the same line in a log would raise. These assertions exist so a
 * later refactor cannot quietly degrade it back into a bare code.
 */

import { describe, expect, it } from "vitest";
import { clientSafeErrorMessage } from "../../../api/errors.js";
import { createEfbig, sanitizeFsError } from "../../errors.js";

describe("createEfbig — message content", () => {
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

	// #168 M11: the read remedy used to recommend `head -c` / `tail -c` / `split -b` /
	// `sed -n`. Checked empirically against the installed just-bash with an instrumented
	// InMemoryFs, every one of them reads the WHOLE file (`IFileSystem` has no ranged read
	// and SqlFs implements no `readFileBytes`), so each re-trips this same limit — the
	// message was handing an autonomous agent a retry loop.
	it("points a read caller at the one ungated route and warns the slicing commands do not help", () => {
		expect(readErr.message).toContain("`GET .../files/{path}`, the one read path this limit does not apply to");
		expect(readErr.message).toContain("Slicing it in the sandbox does NOT help");
		for (const cmd of ["`head -c`", "`tail -c`", "`split -b`", "`sed -n`"]) {
			expect(readErr.message.indexOf(cmd)).toBeGreaterThan(readErr.message.indexOf("does NOT help"));
		}
	});

	// #168 M13: MCP `file_read` refuses above MAX_MCP_READ_FILE_BYTES (16 MiB default), so
	// it must not be offered as an unconditional escape hatch the way HTTP GET can be.
	it("qualifies MCP file_read with its own ceiling", () => {
		expect(readErr.message).toContain("MCP `file_read` also works, but only below its own 16 MiB ceiling");
		expect(readErr.message).toContain("MAX_MCP_READ_FILE_BYTES");
	});

	it("tells a write caller to split the output, and names the write and edit routes", () => {
		expect(writeErr.message).toContain("writing '/out.txt' would produce 52428800 bytes");
		expect(writeErr.message).toContain("write several smaller files");
		// `split -b` only helps a write when its INPUT is a pipe: pointed at the oversized
		// file it re-trips the read side of the same cap.
		expect(writeErr.message).toContain("reading from a pipe rather than the oversized file");
		expect(writeErr.message).toContain("`PUT .../files/{path}` (MCP `file_write`)");
		expect(writeErr.message).toContain("`PATCH .../files/{path}` (MCP `file_edit`)");
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
