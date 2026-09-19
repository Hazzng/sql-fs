/**
 * #166 — WHEN the transaction opens and how long it is held.
 *
 * These assertions are the ones a final-state test cannot make: the same files end
 * up on disk whether the script ran on a transaction held open across it or on a
 * journal replayed at the end. What changes is the transaction's lifetime, which is
 * the quantity #166 is about.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { SqlFs } from "../sql-fs.js";
import { BUFFER_ON, type DialectProbe, makeProbeDialect } from "./fixtures/buffered-dialect.js";

async function newFs(probe: DialectProbe, buffered: boolean): Promise<SqlFs> {
	const fs = new SqlFs({
		dialect: probe.dialect,
		sandboxId: "s-166",
		...(buffered ? { scriptTxBuffer: BUFFER_ON } : {}),
	});
	await fs.ready();
	probe.windows.length = 0;
	probe.calls.length = 0;
	return fs;
}

describe("buffered script-tx — no transaction spans the script", () => {
	let probe: DialectProbe;

	beforeEach(() => {
		probe = makeProbeDialect();
	});

	it("opens no transaction while the script is mutating", async () => {
		const fs = await newFs(probe, true);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "a");
		await fs.mkdir("/home/user/d");
		await fs.writeFile("/home/user/d/b.txt", "b");

		expect(probe.windows).toEqual([]);
		expect(fs.scriptTxOpen).toBe(false);
		expect(probe.calls.filter((c) => c !== "commitBlob")).toEqual([]);

		await fs.endScriptScope();
		expect(probe.windows).toHaveLength(1);
	});

	it("legacy mode opens a transaction on the first mutation and holds it to the end", async () => {
		const fs = await newFs(probe, false);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "a");

		expect(probe.windows).toHaveLength(1);
		expect(probe.windows[0]!.closedAt).toBeUndefined();
		expect(fs.scriptTxOpen).toBe(true);

		await fs.endScriptScope();
		expect(probe.windows[0]!.closedAt).toBeDefined();
	});

	it("holds the transaction for the flush only, not across a sleeping script", async () => {
		const fs = await newFs(probe, true);
		const scriptStart = Date.now();
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "a");
		// Stands in for `sleep`: the window the legacy shape pins a pooled connection for.
		await new Promise((r) => setTimeout(r, 120));
		await fs.writeFile("/home/user/b.txt", "b");
		await fs.endScriptScope();
		const scriptMs = Date.now() - scriptStart;

		expect(probe.windows).toHaveLength(1);
		const window = probe.windows[0]!;
		expect(window.closedAt).toBeDefined();
		const heldMs = window.closedAt! - window.openedAt;
		expect(scriptMs).toBeGreaterThanOrEqual(120);
		// The transaction must not have been open while the script slept.
		expect(heldMs).toBeLessThan(100);
		expect(window.openedAt - scriptStart).toBeGreaterThanOrEqual(120);
	});

	it("replays the mutations in the order the script issued them", async () => {
		const fs = await newFs(probe, true);
		fs.beginScriptScope();
		await fs.mkdir("/home/user/d");
		await fs.writeFile("/home/user/d/a.txt", "a");
		await fs.chmod("/home/user/d/a.txt", 0o600);
		await fs.rm("/home/user/d/a.txt");
		await fs.endScriptScope();

		expect(probe.calls).toEqual([
			"commitBlob",
			"setSandboxContextWithLock",
			"mkdirComposite",
			"writeFileComposite",
			"updateInode",
			"rmComposite",
		]);
	});

	it("takes the writer lock exactly once, and only inside the flush", async () => {
		const fs = await newFs(probe, true);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "a");
		await fs.writeFile("/home/user/b.txt", "b");
		await fs.mkdir("/home/user/d");
		// The legacy shape also takes it once — but it takes it on the FIRST mutation
		// and holds it for the rest of the script. Here nothing has been locked yet.
		expect(probe.calls).not.toContain("setSandboxContextWithLock");
		const beforeFlush = Date.now();
		await fs.endScriptScope();

		expect(probe.calls.filter((c) => c === "setSandboxContextWithLock")).toHaveLength(1);
		expect(probe.windows).toHaveLength(1);
		expect(probe.windows[0]!.openedAt).toBeGreaterThanOrEqual(beforeFlush);
	});

	it("does not buffer file bytes — the composite is replayed without them", async () => {
		const fs = await newFs(probe, true);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "x".repeat(4096));
		await fs.endScriptScope();

		// `commitBlob` already committed the bytes AND backfilled the blob cache, so
		// retaining them in the journal would be pure cost.
		expect(probe.compositeData).toEqual([undefined]);
	});

	it("legacy mode still hands the bytes to the composite for its blob-cache backfill", async () => {
		const fs = await newFs(probe, false);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "abc");
		await fs.endScriptScope();

		expect(probe.compositeData).toHaveLength(1);
		expect(probe.compositeData[0]).toEqual(new TextEncoder().encode("abc"));
	});

	it("an aborted scope issues no SQL at all", async () => {
		const fs = await newFs(probe, true);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "a");
		await fs.mkdir("/home/user/d");
		probe.calls.length = 0;
		await fs.abortScriptScope();

		// Only the recovery reload's read transaction — no write ever reached the DB.
		expect(probe.calls).toEqual(["setSandboxContext", "setSandboxContext"]);
		expect(probe.dialect.writeFileComposite).not.toHaveBeenCalled();
		expect(probe.dialect.mkdirComposite).not.toHaveBeenCalled();
	});

	it("serves read-your-own-writes from cache with no transaction open", async () => {
		const fs = await newFs(probe, true);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "hello");
		expect(await fs.readFile("/home/user/a.txt")).toBe("hello");
		expect((await fs.stat("/home/user/a.txt")).size).toBe(5);
		expect(probe.windows).toEqual([]);
		await fs.endScriptScope();
	});

	it("aborts the whole script when another writer moved the epoch mid-script", async () => {
		const fs = await newFs(probe, true);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "a");
		// A second replica commits while our script runs — impossible in the legacy
		// shape, because the advisory lock kept it out for the script's duration.
		probe.version = 7n;

		await expect(fs.endScriptScope()).rejects.toMatchObject({ code: "ESTALE" });
		expect(probe.dialect.writeFileComposite).not.toHaveBeenCalled();
	});

	it("surfaces a flush failure and discards the caches that led it", async () => {
		const fs = await newFs(probe, true);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/gone.txt", "a");
		expect(fs.getAllPaths()).toContain("/home/user/gone.txt");

		probe.failTransaction = Object.assign(new Error("connection reset"), { code: "08006" });
		await expect(fs.endScriptScope()).rejects.toThrow("connection reset");

		probe.failTransaction = undefined;
		await fs.reload();
		expect(fs.getAllPaths()).not.toContain("/home/user/gone.txt");
	});
});
