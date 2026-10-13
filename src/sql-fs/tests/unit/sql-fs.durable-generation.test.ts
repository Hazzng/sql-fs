import { describe, expect, it, vi } from "vitest";
import { ownerCancellation } from "../../../execution/owner-cancellation.js";
import { PostgresDialect } from "../../dialects/postgres.js";
import { SqlFs } from "../../sql-fs.js";
import { makeProbeDialect } from "../fixtures/buffered-dialect.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

describe("durable generation hooks", () => {
	it("preserves dialects without durable generation support", async () => {
		const probe = makeProbeDialect();
		const fs = new SqlFs({ dialect: probe.dialect, sandboxId: "local" });
		await fs.ready();
		const transactions = probe.windows.length;
		await fs.claimGeneration();
		expect(probe.windows).toHaveLength(transactions);
		await fs.ensureFresh();
		expect(probe.windows).toHaveLength(transactions + 1);
		await expect(fs.writeFile("/home/user/local", "works")).resolves.toBeUndefined();
		expect(await fs.readFile("/home/user/local")).toBe("works");
	});

	it("does not retire the replacement generation after losing its lease while waiting for the writer lock", async () => {
		const probe = makeProbeDialect();
		const postgres = new PostgresDialect("postgres://unused");
		const blocked = deferred<void>();
		const resume = deferred<void>();
		let waitForLock = true;
		vi.spyOn(postgres, "setSandboxContextWithLock").mockImplementation(async () => {
			if (waitForLock) {
				waitForLock = false;
				blocked.resolve();
				await resume.promise;
			}
		});
		const tx = async () => [{ prior_epoch: String(probe.version), version: String(++probe.version) }];
		probe.dialect.retireSandboxGeneration = (_tx, id, ...guard) =>
			postgres.retireSandboxGeneration(tx as never, id, ...guard);
		const stale = new SqlFs({ dialect: probe.dialect, sandboxId: "durable" });
		const replacement = new SqlFs({ dialect: probe.dialect, sandboxId: "durable" });
		await Promise.all([stale.ready(), replacement.ready()]);
		const cancellation = new Int32Array(new SharedArrayBuffer(8));
		const claiming = ownerCancellation.run(cancellation, () => stale.claimGeneration());
		const settled = claiming.then(
			() => undefined,
			(error: unknown) => error,
		);
		await blocked.promise;
		Atomics.store(cancellation, 1, 1);
		await replacement.claimGeneration();
		const replacementEpoch = probe.version;
		resume.resolve();
		expect(await settled).toMatchObject({ code: "ELOCKLOST" });
		expect(probe.version).toBe(replacementEpoch);
		await expect(replacement.writeFile("/home/user/new-owner", "writable")).resolves.toBeUndefined();
		expect(await replacement.readFile("/home/user/new-owner")).toBe("writable");
	});

	it("rejects a generation claim before entering a transaction when the owner lease is already lost", async () => {
		const probe = makeProbeDialect();
		const retire = vi.fn(async () => ({ priorEpoch: probe.version, epoch: ++probe.version }));
		probe.dialect.retireSandboxGeneration = retire;
		const fs = new SqlFs({ dialect: probe.dialect, sandboxId: "durable" });
		await fs.ready();
		const cancellation = new Int32Array(new SharedArrayBuffer(8));
		Atomics.store(cancellation, 1, 1);
		await expect(ownerCancellation.run(cancellation, () => fs.claimGeneration())).rejects.toMatchObject({
			code: "ELOCKLOST",
		});
		expect(retire).not.toHaveBeenCalled();
	});

	it("rolls back a claim if the owner lease is lost during the epoch update", async () => {
		const probe = makeProbeDialect();
		const cancellation = new Int32Array(new SharedArrayBuffer(8));
		probe.dialect.retireSandboxGeneration = async () => {
			Atomics.store(cancellation, 1, 1);
			return { priorEpoch: probe.version, epoch: ++probe.version };
		};
		const fs = new SqlFs({ dialect: probe.dialect, sandboxId: "durable" });
		await fs.ready();
		const originalEpoch = probe.version;
		probe.dialect.transaction = async (fn) => {
			const snapshot = probe.version;
			try {
				return await fn({});
			} catch (error) {
				probe.version = snapshot;
				throw error;
			}
		};
		await expect(ownerCancellation.run(cancellation, () => fs.claimGeneration())).rejects.toMatchObject({
			code: "ELOCKLOST",
		});
		expect(probe.version).toBe(originalEpoch);
	});

	it("discards prewarm bytes when their cache image was replaced", async () => {
		const probe = makeProbeDialect();
		probe.dialect.retireSandboxGeneration = async () => ({ priorEpoch: probe.version, epoch: ++probe.version });
		const pending = deferred<Array<{ inodeId: bigint; data: Uint8Array }>>();
		const loaded = deferred<void>();
		probe.dialect.getBlobsForSandbox = vi.fn(async () => {
			loaded.resolve();
			return pending.promise;
		});
		const fs = new SqlFs({ dialect: probe.dialect, sandboxId: "durable" });
		await fs.ready();
		await loaded.promise;
		await fs.writeFile("/home/user/file.txt", "new");
		pending.resolve([{ inodeId: 4n, data: new TextEncoder().encode("obsolete") }]);
		await pending.promise;
		await Promise.resolve();
		await Promise.resolve();
		expect(fs._getContentCache().has(4n)).toBe(false);
		expect(await fs.readFile("/home/user/file.txt")).toBe("new");
	});
});
