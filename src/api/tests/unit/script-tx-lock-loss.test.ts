/**
 * F2-L1 for the write routes: a definitive exec-lock loss must roll the script-tx scope back.
 *
 * ELOCKLOST is mapped to a retryable 503 on the promise that nothing committed. The exec path
 * keeps that promise by aborting its scope; `runInScriptTx` is what keeps it for PATCH edits,
 * whole-file writes and bulk writes, which would otherwise commit on the way out and then report
 * "not written".
 */

import { InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { SessionScopedFs } from "../../../sql-fs/session-scoped-fs.js";
import type { IScriptTxFs } from "../../../sql-fs/sql-fs.js";
import { editFile, writeFileAtPath } from "../../lib/file-ops.js";
import { runInScriptTx } from "../../lib/script-tx.js";
import type { Session } from "../../session-manager.js";

/**
 * Backing fs with the rollback `InMemoryFs` lacks: the scope snapshots on open and restores on
 * abort, standing in for the transaction a SQL backend would roll back. Without it a test asserting
 * "the edit did not land" passes just as happily on a `writeFile` that very much did.
 *
 * Driven through the real `SessionScopedFs` rather than a copy of it, so the commit/rollback and
 * nesting rules under test are the ones production runs.
 */
function makeScriptTxFs(fs: InMemoryFs): { scriptTxFs: IScriptTxFs; calls: string[] } {
	const calls: string[] = [];
	let active = false;
	let snap: { files: Map<string, Uint8Array>; dirs: Set<string> } | undefined;

	// Directories too: `writeFileAtPath` creates parents, and restoring only file contents would
	// leave `/nested/dir` standing — not a rollback.
	const snapshot = async (): Promise<{ files: Map<string, Uint8Array>; dirs: Set<string> }> => {
		const files = new Map<string, Uint8Array>();
		const dirs = new Set<string>();
		for (const path of fs.getAllPaths()) {
			if ((await fs.stat(path)).isDirectory) dirs.add(path);
			else files.set(path, await fs.readFileBuffer(path));
		}
		return { files, dirs };
	};

	const scriptTxFs = {
		get scriptScopeActive() {
			return active;
		},
		get scriptTxOpen() {
			return active;
		},
		beginScriptScope(): void {
			calls.push("begin");
			active = true;
		},
		async endScriptScope(): Promise<void> {
			calls.push("end");
			active = false;
		},
		async abortScriptScope(): Promise<void> {
			calls.push("abort");
			active = false;
			if (snap === undefined) return;
			const taken = snap;
			const created: string[] = [];
			for (const path of fs.getAllPaths()) {
				if ((await fs.stat(path)).isDirectory) {
					if (!taken.dirs.has(path)) created.push(path);
					continue;
				}
				const before = taken.files.get(path);
				if (before === undefined) created.push(path);
				else await fs.writeFile(path, before);
			}
			// Deepest first, so a directory is empty by the time it is removed.
			for (const path of created.sort((a, b) => b.length - a.length)) {
				await fs.rm(path, { recursive: true });
			}
		},
	} as unknown as IScriptTxFs;

	// `beginScriptScope` is synchronous, so the snapshot is taken by the caller that opens the
	// scope; `SessionScopedFs.run` calls begin immediately after, with nothing in between.
	const scoped = new Proxy(scriptTxFs, {
		get(target, prop, receiver) {
			if (prop === "beginScriptScope") {
				return async () => {
					snap = await snapshot();
					target.beginScriptScope();
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	});
	return { scriptTxFs: scoped, calls };
}

function makeSession(lockLost: boolean, fs: InMemoryFs = new InMemoryFs()): { session: Session; calls: string[] } {
	const { scriptTxFs, calls } = makeScriptTxFs(fs);
	const controller = new AbortController();
	if (lockLost) controller.abort();
	const session = {
		fs,
		scriptTx: new SessionScopedFs(scriptTxFs),
		lockLostSignal: controller.signal,
	} as unknown as Session;
	return { session, calls };
}

describe("runInScriptTx", () => {
	it("commits when the lock held for the whole write", async () => {
		const { session, calls } = makeSession(false);

		await expect(runInScriptTx(session, async () => "written")).resolves.toBe("written");
		expect(calls).toEqual(["begin", "end"]);
	});

	it("rolls back and reports ELOCKLOST when the lease was lost mid-write", async () => {
		const { session, calls } = makeSession(true);

		await expect(runInScriptTx(session, async () => "written")).rejects.toMatchObject({ code: "ELOCKLOST" });
		expect(calls).toEqual(["begin", "abort"]);
	});

	it("rolls back on the write's own failure", async () => {
		const { session, calls } = makeSession(false);

		await expect(
			runInScriptTx(session, async () => {
				throw new Error("write failed");
			}),
		).rejects.toThrow("write failed");
		expect(calls).toEqual(["begin", "abort"]);
	});

	it("runs directly on a backend without script-tx", async () => {
		const session = { fs: new InMemoryFs(), scriptTx: undefined } as unknown as Session;

		await expect(runInScriptTx(session, async () => "written")).resolves.toBe("written");
	});
});

describe("editFile under a lost lease", () => {
	it("leaves the file at its pre-edit content instead of committing the write", async () => {
		const fs = new InMemoryFs();
		await fs.writeFile("/f.txt", "before\n");
		const { session, calls } = makeSession(true, fs);

		await expect(editFile(session, "/f.txt", { oldString: "before", newString: "after" }, 1024)).rejects.toMatchObject({
			code: "ELOCKLOST",
		});
		expect(calls).toEqual(["begin", "abort"]);
		expect(await fs.readFile("/f.txt")).toBe("before\n");
	});

	// Companion to the rollback assertion above: proves the backing scope commits a held-lease edit
	// rather than restoring unconditionally, so "still `before`" means rollback, not an inert fake.
	it("commits the edit when the lease held", async () => {
		const fs = new InMemoryFs();
		await fs.writeFile("/f.txt", "before\n");
		const { session, calls } = makeSession(false, fs);

		await expect(editFile(session, "/f.txt", { oldString: "before", newString: "after" }, 1024)).resolves.toEqual({
			kind: "ok",
			replacements: 1,
			size: 6,
		});
		expect(calls).toEqual(["begin", "end"]);
		expect(await fs.readFile("/f.txt")).toBe("after\n");
	});
});

describe("writeFileAtPath under a lost lease", () => {
	it("leaves neither the file nor its created parents behind", async () => {
		const fs = new InMemoryFs();
		const { session, calls } = makeSession(true, fs);

		await expect(writeFileAtPath(session, "/nested/dir/new.txt", new TextEncoder().encode("hi"))).rejects.toMatchObject(
			{ code: "ELOCKLOST" },
		);
		expect(calls).toEqual(["begin", "abort"]);
		expect(await fs.exists("/nested/dir/new.txt")).toBe(false);
		// The parents the write created go back too, or the rollback left half the change standing.
		expect(await fs.exists("/nested/dir")).toBe(false);
		expect(await fs.exists("/nested")).toBe(false);
	});

	it("commits the file and its parents when the lease held", async () => {
		const fs = new InMemoryFs();
		const { session, calls } = makeSession(false, fs);

		await expect(writeFileAtPath(session, "/nested/dir/new.txt", new TextEncoder().encode("hi"))).resolves.toEqual({
			kind: "ok",
		});
		expect(calls).toEqual(["begin", "end"]);
		expect(await fs.readFile("/nested/dir/new.txt")).toBe("hi");
	});
});
