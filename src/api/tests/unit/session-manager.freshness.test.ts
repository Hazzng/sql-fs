import { InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../../sql-fs/tests/unit/freshness-helpers.js";
import { SessionManager } from "../../session-manager.js";

function setup() {
	const fs = Object.assign(new InMemoryFs(), {
		ensureFresh: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
		wasDirty: () => false,
		clearDirty: () => {},
		poisoned: () => false,
		disconnect: vi.fn(async () => {}),
	});
	const manager = new SessionManager({ createFs: async () => fs, idleMs: 1 });
	managers.push(manager);
	return { fs, manager };
}
const managers: SessionManager[] = [];
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
});

describe("SessionManager authoritative admission lifecycle", () => {
	it.each(["withSession", "withSessionRead"] as const)(
		"%s probes under local protection before the callback",
		async (method) => {
			const { fs, manager } = setup();
			const session = await manager.getOrCreate("default", "sbx");
			fs.ensureFresh.mockImplementation(async () => {
				expect(session.lock.writerHeld || session.lock.activeReaders > 0).toBe(true);
				expect(session.inFlight).toBe(1);
			});
			const callback = vi.fn(async () => "fresh");
			expect(await manager[method]("default", "sbx", callback)).toBe("fresh");
			expect(fs.ensureFresh).toHaveBeenCalledOnce();
			expect(callback).toHaveBeenCalledOnce();
			expect(session.inFlight).toBe(0);
		},
	);

	it("a reader queued behind a local writer cannot probe or reload the open writer", async () => {
		const { fs, manager } = setup();
		await manager.getOrCreate("default", "sbx");
		const entered = deferred();
		const release = deferred();
		const writer = manager.withSession("default", "sbx", async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		const reader = manager.withSessionRead("default", "sbx", async () => "fresh");
		await Promise.resolve();
		await Promise.resolve();
		expect(fs.ensureFresh).toHaveBeenCalledOnce();
		release.resolve();
		await writer;
		expect(await reader).toBe("fresh");
		expect(fs.ensureFresh).toHaveBeenCalledTimes(2);
	});

	it("rejects authority failure without invoking the callback", async () => {
		const { fs, manager } = setup();
		const error = Object.assign(new Error("authority unavailable"), { code: "08006" });
		await manager.getOrCreate("default", "sbx");
		fs.ensureFresh.mockRejectedValueOnce(error);
		const callback = vi.fn(async () => "stale");
		await expect(manager.withSessionRead("default", "sbx", callback)).rejects.toBe(error);
		expect(callback).not.toHaveBeenCalled();
	});

	it("deletion tears down after all shared readers release without upgrading their locks", async () => {
		const { fs, manager } = setup();
		const session = await manager.getOrCreate("default", "sbx");
		const entered = deferred();
		const release = deferred();
		const earlier = manager.withSessionRead("default", "sbx", async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		fs.ensureFresh.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
		const callback = vi.fn(async () => "ghost");
		const gone = manager.withSessionRead("default", "sbx", callback);
		const assertion = expect(gone).rejects.toMatchObject({ code: "ENOENT" });
		await vi.waitFor(() => expect(session.state).toBe("closing"));
		expect(fs.disconnect).not.toHaveBeenCalled();
		const shutdown = manager.shutdown();
		release.resolve();
		await earlier;
		await assertion;
		await shutdown;
		expect(fs.disconnect).toHaveBeenCalledOnce();
		expect(callback).not.toHaveBeenCalled();
		expect(manager.getSession("default", "sbx")).toBeUndefined();
	});

	it("shutdown during a sample waits for protection and rejects the queued admission", async () => {
		const { fs, manager } = setup();
		await manager.getOrCreate("default", "sbx");
		const sampled = deferred();
		const release = deferred();
		fs.ensureFresh.mockImplementation(async () => {
			sampled.resolve();
			await release.promise;
		});
		const callback = vi.fn(async () => "stale");
		const reader = manager.withSessionRead("default", "sbx", callback);
		const assertion = expect(reader).rejects.toMatchObject({ code: "ESESSIONCLOSING" });
		await sampled.promise;
		const shutdown = manager.shutdown();
		expect(fs.disconnect).not.toHaveBeenCalled();
		release.resolve();
		await assertion;
		await shutdown;
		expect(callback).not.toHaveBeenCalled();
		expect(fs.disconnect).toHaveBeenCalledOnce();
	});
	it("preserves the closing error when authority rejects during shutdown", async () => {
		const { fs, manager } = setup();
		await manager.getOrCreate("default", "sbx");
		const sampled = deferred();
		const release = deferred();
		fs.ensureFresh.mockImplementation(async () => {
			sampled.resolve();
			await release.promise;
			throw new Error("pool is disconnected");
		});
		const callback = vi.fn(async () => "stale");
		const reader = manager.withSessionRead("default", "sbx", callback);
		const assertion = expect(reader).rejects.toMatchObject({ code: "ESESSIONCLOSING" });
		await sampled.promise;
		const shutdown = manager.shutdown();
		release.resolve();
		await assertion;
		await shutdown;
		expect(callback).not.toHaveBeenCalled();
	});
});
