import { describe, expect, it } from "vitest";
import { deferred, file, fixture, root } from "./freshness-helpers.js";

describe("SqlFs committed views", () => {
	it.each(["ready", "reload"] as const)(
		"%s pairs paths and bigint epoch across a concurrent commit",
		async (method) => {
			const { fs, state, paths } = fixture();
			if (method === "reload") await fs.ready();
			state.epoch = 9007199254740993n;
			const sampled = deferred();
			const resume = deferred();
			paths.mockImplementationOnce(async (tx) => {
				sampled.resolve();
				await resume.promise;
				return tx.rows;
			});
			const loading = fs[method]();
			await sampled.promise;
			state.epoch++;
			state.rows = [root, file("/value", "new")];
			resume.resolve();
			await loading;
			expect(await fs.readFile("/value")).toBe("old");
			await fs.ensureFresh();
			expect(await fs.readFile("/value")).toBe("new");
		},
	);

	it("seals concurrent cohorts before sampling and sends late arrivals to another sample", async () => {
		const { fs, state, probes, paths } = fixture();
		await fs.ready();
		probes.mockClear();
		paths.mockClear();
		const sampled = deferred();
		const resume = deferred();
		probes.mockImplementationOnce(async (tx) => {
			sampled.resolve();
			await resume.promise;
			return tx.epoch;
		});
		const first = fs.ensureFresh();
		const peer = fs.ensureFresh();
		await sampled.promise;
		state.epoch++;
		state.rows = [root, file("/value", "new")];
		const late = fs.ensureFresh();
		resume.resolve();
		await Promise.all([first, peer, late]);
		expect(probes).toHaveBeenCalledTimes(2);
		expect(paths).toHaveBeenCalledOnce();
		expect(await fs.readFile("/value")).toBe("new");
	});

	it("validates unchanged views without scanning paths", async () => {
		const { fs, paths, probes } = fixture();
		await fs.ready();
		paths.mockClear();
		probes.mockClear();
		await fs.ensureFresh();
		expect(probes).toHaveBeenCalledOnce();
		expect(paths).not.toHaveBeenCalled();
		expect(await fs.readFile("/value")).toBe("old");
	});

	it("does not install a view until its transaction succeeds", async () => {
		const { fs, state } = fixture();
		await fs.ready();
		state.epoch++;
		state.rows = [root, file("/value", "new")];
		state.failCommit = true;
		await expect(fs.ensureFresh()).rejects.toThrow("commit failed");
		expect(await fs.readFile("/value")).toBe("old");
		state.failCommit = false;
		await fs.ensureFresh();
		expect(await fs.readFile("/value")).toBe("new");
	});

	it("rejects authority failures even with a warm unchanged view, then recovers", async () => {
		const { fs, probes } = fixture();
		await fs.ready();
		probes.mockRejectedValueOnce(Object.assign(new Error("unavailable"), { code: "08006" }));
		await expect(fs.ensureFresh()).rejects.toMatchObject({ code: "08006" });
		await fs.ensureFresh();
		expect(await fs.readFile("/value")).toBe("old");
	});

	it("refuses freshness admission inside a script scope", async () => {
		const { fs } = fixture();
		await fs.ready();
		fs.beginScriptScope();
		expect(() => fs.ensureFresh()).toThrow("Freshness admission");
		await fs.reload();
		expect(await fs.readFile("/value")).toBe("old");
		await fs.abortScriptScope();
	});
});
