/**
 * An empty file needs no blob row: every reader maps a missing blob to empty bytes.
 * just-bash 3.6 truncates each `>` target with an empty write before writing the
 * output, so committing the empty blob eagerly cost one Postgres round trip per redirect.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import { BUFFER_ON, type DialectProbe, makeProbeDialect } from "../fixtures/buffered-dialect.js";

describe("SqlFs — empty content skips the blob commit", () => {
	let probe: DialectProbe;
	let fs: SqlFs;

	beforeEach(async () => {
		probe = makeProbeDialect();
		fs = new SqlFs({ dialect: probe.dialect, sandboxId: "s-empty", scriptTxBuffer: BUFFER_ON });
		await fs.ready();
		probe.calls.length = 0;
	});

	it("writes an empty file without committing a blob", async () => {
		await fs.writeFile("/home/user/empty.txt", "");
		expect(probe.calls).not.toContain("commitBlob");
		expect(await fs.readFile("/home/user/empty.txt")).toBe("");
	});

	it("creates an empty file by append without committing a blob", async () => {
		await fs.appendFile("/home/user/empty.txt", "");
		expect(probe.calls).not.toContain("commitBlob");
		expect((await fs.stat("/home/user/empty.txt")).size).toBe(0);
	});

	it("still commits the blob for non-empty content", async () => {
		await fs.writeFile("/home/user/full.txt", "x");
		expect(probe.calls).toContain("commitBlob");
	});
});
