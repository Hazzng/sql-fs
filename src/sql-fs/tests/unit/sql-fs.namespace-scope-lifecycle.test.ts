import { describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import { BUFFER_ON, type DialectProbe, makeProbeDialect } from "../fixtures/buffered-dialect.js";

function pauseCreation(probe: DialectProbe, directory: boolean, composite: boolean) {
	let release!: () => void;
	let entered!: () => void;
	const waiting = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	if (!composite) {
		probe.dialect.writeFileComposite = undefined;
		probe.dialect.mkdirComposite = undefined;
	}
	const method = composite
		? directory
			? probe.dialect.mkdirComposite!
			: probe.dialect.writeFileComposite!
		: probe.dialect.createInode;
	vi.mocked(method).mockImplementationOnce(async () => {
		entered();
		await gate;
		return 9000n;
	});
	return { waiting, release: () => release() };
}

describe.each([false, true])("namespace lifecycle, composite=%s", (composite) => {
	it.each([
		[false, false],
		[false, true],
		[true, false],
		[true, true],
	] as const)(
		"rejects in-flight and queued metadata after abort, directory=%s replacement=%s",
		async (directory, replace) => {
			const probe = makeProbeDialect();
			const fs = new SqlFs({ dialect: probe.dialect, sandboxId: "s-metadata-abort" });
			await fs.ready();
			fs.beginScriptScope();
			const pause = pauseCreation(probe, directory, composite);
			const pending = fs.createExclusive("/home/user/pending", { mode: 0o700, directory });
			await pause.waiting;
			const results = Promise.allSettled([pending, fs.createExclusive("/home/user/pending", { mode: 0o600 })]);
			await fs.abortScriptScope();
			if (replace) fs.beginScriptScope();
			pause.release();
			const outcomes = await results;
			expect(outcomes).toMatchObject([
				{ status: "rejected", reason: expect.any(Error) },
				{ status: "rejected", reason: expect.any(Error) },
			]);
			if (replace) {
				expect(outcomes).toMatchObject([{ reason: { code: "ESTALE" } }, { reason: { code: "ESTALE" } }]);
			}
			expect(await fs.exists("/home/user/pending")).toBe(false);
			expect(fs.wasDirty()).toBe(false);
			expect(fs._getContentCache().calculatedSize).toBe(0);
			await fs.createExclusive("/home/user/pending", { mode: 0o600 });
			if (replace) await fs.endScriptScope();
		},
	);

	it.each([false, true])("keeps committed metadata that started outside a scope, directory=%s", async (directory) => {
		const probe = makeProbeDialect();
		const fs = new SqlFs({ dialect: probe.dialect, sandboxId: "s-metadata-committed" });
		await fs.ready();
		const pause = pauseCreation(probe, directory, composite);
		const pending = fs.createExclusive("/home/user/committed", { mode: 0o700, directory });
		await pause.waiting;
		fs.beginScriptScope();
		pause.release();
		await pending;
		expect((await fs.stat("/home/user/committed")).mode).toBe(0o700);
		expect(fs.wasDirty()).toBe(true);
		await fs.endScriptScope();
		expect(await fs.exists("/home/user/committed")).toBe(true);
	});

	it.each([false, true])("rejects an outside-scope queued writer after a scope change, scope ended=%s", async (end) => {
		const probe = makeProbeDialect();
		const fs = new SqlFs({ dialect: probe.dialect, sandboxId: "s-queued-scope-change" });
		await fs.ready();
		const pause = pauseCreation(probe, false, composite);
		const committed = fs.createExclusive("/home/user/pending", { mode: 0o600 });
		await pause.waiting;
		const results = Promise.allSettled([committed, fs.writeFile("/home/user/pending", "queued bytes")]);
		fs.beginScriptScope();
		if (end) await fs.endScriptScope();
		pause.release();
		expect(await results).toMatchObject([{ status: "fulfilled" }, { status: "rejected", reason: { code: "ESTALE" } }]);
		const stat = await fs.stat("/home/user/pending");
		expect({ mode: stat.mode, size: stat.size }).toEqual({ mode: 0o600, size: 0 });
		expect(probe.dialect.commitBlob).not.toHaveBeenCalled();
		if (!end) await fs.endScriptScope();
	});
});

it("does not refresh a replacement scope's epoch from a completed old transaction", async () => {
	const probe = makeProbeDialect();
	const fs = new SqlFs({ dialect: probe.dialect, sandboxId: "s-metadata-epoch" });
	await fs.ready();
	fs.beginScriptScope();
	const pause = pauseCreation(probe, false, true);
	const pending = fs.createExclusive("/home/user/old", { mode: 0o600 });
	const results = Promise.allSettled([pending]);
	await pause.waiting;
	await fs.abortScriptScope();
	fs.beginScriptScope();
	await fs.createExclusive("/home/user/current", { mode: 0o600 });
	const epochCalls = vi.mocked(probe.dialect.getSandboxEpoch).mock.calls.length;
	pause.release();
	await expect(results).resolves.toMatchObject([{ status: "rejected", reason: { code: "ESTALE" } }]);
	expect(vi.mocked(probe.dialect.getSandboxEpoch).mock.calls.slice(epochCalls)).toEqual([]);
	expect(await fs.exists("/home/user/old")).toBe(false);
	expect(await fs.exists("/home/user/current")).toBe(true);
	await fs.endScriptScope();
});

describe.each([false, true])("buffered metadata before cache publication, directory=%s", (directory) => {
	it("rejects a mutation whose scope is aborted in the next microtask", async () => {
		const probe = makeProbeDialect();
		const fs = new SqlFs({ dialect: probe.dialect, sandboxId: "s-buffered-metadata-abort", scriptTxBuffer: BUFFER_ON });
		await fs.ready();
		fs.beginScriptScope();
		const pending = fs.createExclusive("/home/user/pending", { mode: 0o700, directory });
		const results = Promise.allSettled([pending]);
		let aborted!: Promise<void>;
		queueMicrotask(() => {
			aborted = fs.abortScriptScope();
		});
		await expect(results).resolves.toMatchObject([{ status: "rejected", reason: { code: "ESTALE" } }]);
		await aborted;
		expect(await fs.exists("/home/user/pending")).toBe(false);
		expect(fs.wasDirty()).toBe(false);
		expect(probe.calls).not.toContain("writeFileComposite");
		expect(probe.calls).not.toContain("mkdirComposite");
	});
});

describe.each([false, true])("pending outside-scope blob writes, buffering=%s", (buffered) => {
	it.each(["writeFile", "appendFile"] as const)("rejects %s before it enters a newly opened scope", async (method) => {
		const probe = makeProbeDialect();
		const fs = new SqlFs({
			dialect: probe.dialect,
			sandboxId: "s-outside-blob-scope",
			scriptTxBuffer: buffered ? BUFFER_ON : undefined,
		});
		await fs.ready();
		let release!: () => void;
		let entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(probe.dialect.commitBlob!).mockImplementationOnce(async () => {
			entered();
			await gate;
		});
		const pending = fs[method]("/home/user/pending", "outside bytes");
		const results = Promise.allSettled([pending]);
		await waiting;
		fs.beginScriptScope();
		release();
		expect(await results).toMatchObject([{ status: "rejected", reason: { code: "ESTALE" } }]);
		expect(probe.dialect.writeFileComposite).not.toHaveBeenCalled();
		expect(await fs.exists("/home/user/pending")).toBe(false);
		expect(fs.wasDirty()).toBe(false);
		await fs.endScriptScope();
		expect(probe.dialect.writeFileComposite).not.toHaveBeenCalled();
	});
});
