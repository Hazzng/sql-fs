/**
 * Rewriting a file keeps its mode. writeFile and appendFile replace the inode, and
 * both used to stamp 0o644 on the new one, so `chmod +x f; echo x >> f` dropped the
 * executable bit — in the cache and in the database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import { type BashOverSqlFs, bashOverSqlFs } from "../fixtures/bash-over-sqlfs.js";
import { BUFFER_ON, type DialectProbe, makeProbeDialect } from "../fixtures/buffered-dialect.js";

const FILE = "/home/user/file.txt";

/** Mode argument of every writeFileComposite call, in call order. */
function persistedModes(probe: DialectProbe): unknown[] {
	return vi.mocked(probe.dialect.writeFileComposite!).mock.calls.map((call) => call[4]);
}

describe("SqlFs — rewriting a file keeps its mode", () => {
	let probe: DialectProbe;
	let fs: SqlFs;

	beforeEach(async () => {
		probe = makeProbeDialect();
		fs = new SqlFs({ dialect: probe.dialect, sandboxId: "s-mode", scriptTxBuffer: BUFFER_ON });
		await fs.ready();
		await fs.chmod(FILE, 0o755);
	});

	it("keeps the mode on writeFile over an existing file", async () => {
		await fs.writeFile(FILE, "new");
		expect((await fs.stat(FILE)).mode).toBe(0o755);
		expect(persistedModes(probe)).toEqual([0o755]);
	});

	it("keeps the mode on appendFile to an existing file", async () => {
		await fs.appendFile(FILE, "more");
		expect((await fs.stat(FILE)).mode).toBe(0o755);
		expect(persistedModes(probe)).toEqual([0o755]);
	});

	it("treats an empty append to an existing file as a no-op", async () => {
		probe.calls.length = 0;
		const before = await fs.stat(FILE);
		await fs.appendFile(FILE, "");
		expect(probe.calls).toEqual([]);
		expect(await fs.stat(FILE)).toEqual(before);
	});

	it("creates the file on an empty append to a missing path", async () => {
		await fs.appendFile("/home/user/created.txt", "");
		expect((await fs.stat("/home/user/created.txt")).size).toBe(0);
		expect(persistedModes(probe)).toEqual([0o644]);
	});

	it("creates a new file as 0o644", async () => {
		await fs.writeFile("/home/user/new.txt", "x");
		expect((await fs.stat("/home/user/new.txt")).mode).toBe(0o644);
		expect(persistedModes(probe)).toEqual([0o644]);
	});
});

describe("bash over SqlFs — redirects keep the mode", () => {
	let env: BashOverSqlFs;

	beforeEach(async () => {
		env = await bashOverSqlFs();
	});

	it("keeps 755 after >> appends", async () => {
		const r = await env.bash.exec("echo a > f.sh; chmod 755 f.sh; echo b >> f.sh; stat -c %a f.sh");
		expect(r.stdout).toBe("755\n");
	});

	it("keeps 755 after > truncates", async () => {
		const r = await env.bash.exec("echo a > f.sh; chmod 755 f.sh; echo b > f.sh; stat -c %a f.sh");
		expect(r.stdout).toBe("755\n");
	});
});
