/**
 * F2-L1 for the write routes: a definitive exec-lock loss must roll the script-tx scope back.
 *
 * ELOCKLOST is mapped to a retryable 503 on the promise that nothing committed. The exec path
 * keeps that promise by aborting its scope; `runInScriptTx` is what keeps it for PATCH edits and
 * bulk writes, which would otherwise commit on the way out and then report "not written".
 */

import { InMemoryFs } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { editFile } from "../../lib/file-ops.js";
import { runInScriptTx } from "../../lib/script-tx.js";
import type { Session } from "../../session-manager.js";

/** Scope mock whose active flag tracks begin/end, so `run` sees what the real fs would. */
function makeScriptTx(): { scriptTx: Session["scriptTx"]; calls: string[] } {
	const calls: string[] = [];
	let active = false;
	const scriptTx = {
		get isActive() {
			return active;
		},
		beginScope: vi.fn(() => {
			calls.push("begin");
			active = true;
		}),
		endScope: vi.fn(async () => {
			calls.push("end");
			active = false;
		}),
		abortScope: vi.fn(async () => {
			calls.push("abort");
			active = false;
		}),
		async run<T>(fn: () => Promise<T>): Promise<T> {
			const owns = !active;
			if (owns) this.beginScope();
			try {
				const result = await fn();
				if (owns) await this.endScope();
				return result;
			} catch (err) {
				if (owns) await this.abortScope();
				throw err;
			}
		},
	};
	return { scriptTx: scriptTx as unknown as Session["scriptTx"], calls };
}

function makeSession(lockLost: boolean, fs: InMemoryFs = new InMemoryFs()): { session: Session; calls: string[] } {
	const { scriptTx, calls } = makeScriptTx();
	const controller = new AbortController();
	if (lockLost) controller.abort();
	return { session: { fs, scriptTx, lockLostSignal: controller.signal } as unknown as Session, calls };
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
	// The rollback itself belongs to the backend's transaction; what this asserts is that the edit
	// path reaches for it instead of ending the scope (the mock fs has nothing to roll back).
	it("aborts the scope rather than committing the write", async () => {
		const fs = new InMemoryFs();
		await fs.writeFile("/f.txt", "before\n");
		const { session, calls } = makeSession(true, fs);

		await expect(editFile(session, "/f.txt", { oldString: "before", newString: "after" }, 1024)).rejects.toMatchObject({
			code: "ELOCKLOST",
		});
		expect(calls).toEqual(["begin", "abort"]);
	});
});
