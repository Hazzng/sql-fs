import { describe, expect, it, vi } from "vitest";
import { deferred, file, fixture, root } from "./freshness-helpers.js";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("SqlFs content cache fills", () => {
	it("returns from ready while prewarm is pending and coalesces readers onto it", async () => {
		const { fs, prewarm, blob } = fixture();
		const pending = deferred<Array<{ inodeId: bigint; data: Uint8Array }>>();
		prewarm.mockReturnValueOnce(pending.promise);
		await fs.ready();
		const readers = Array.from({ length: 5 }, () => fs.readFile("/value"));
		pending.resolve([{ inodeId: 2n, data: bytes("old") }]);
		expect(await Promise.all(readers)).toEqual(Array(5).fill("old"));
		expect(prewarm).toHaveBeenCalledOnce();
		expect(blob).not.toHaveBeenCalled();
	});

	it("passes the cache byte cap to bulk fetch", async () => {
		const { fs, prewarm } = fixture();
		await fs.ready();
		expect(prewarm).toHaveBeenCalledWith("freshness", fs._getContentCache().maxSize);
	});

	it("falls back to lazy fetch when prewarm fails", async () => {
		const { fs, prewarm, blob } = fixture();
		prewarm.mockRejectedValueOnce(new Error("prewarm unavailable"));
		await fs.ready();
		expect(await fs.readFile("/value")).toBe("old");
		expect(blob).toHaveBeenCalledOnce();
	});

	it("falls back to lazy fetch for entries excluded by the prewarm cap", async () => {
		const { fs, state, prewarm, blob } = fixture();
		state.rows.push(file("/second", "new", 3n));
		prewarm.mockResolvedValue([{ inodeId: 2n, data: bytes("old") }]);
		await fs.ready();
		expect(await fs.readFile("/value")).toBe("old");
		expect(blob).not.toHaveBeenCalled();
		expect(await fs.readFile("/second")).toBe("new");
		expect(blob).toHaveBeenCalledOnce();
	});

	it("refuses prewarm bytes whose hash differs from the committed view", async () => {
		const { fs, prewarm, blob } = fixture();
		prewarm.mockResolvedValue([{ inodeId: 2n, data: bytes("new") }]);
		await fs.ready();
		expect(await fs.readFile("/value")).toBe("old");
		expect(blob).toHaveBeenCalledOnce();
	});

	it("discards a delayed prewarm from an earlier generation and warms the new view", async () => {
		const { fs, state, prewarm, blob } = fixture();
		const pending = deferred<Array<{ inodeId: bigint; data: Uint8Array }>>();
		prewarm.mockReturnValueOnce(pending.promise).mockResolvedValue([{ inodeId: 2n, data: bytes("new") }]);
		await fs.ready();
		state.epoch++;
		state.rows = [root, file("/value", "new")];
		await fs.ensureFresh();
		expect(prewarm).toHaveBeenCalledOnce();
		pending.resolve([{ inodeId: 2n, data: bytes("old") }]);
		await vi.waitFor(() => expect(prewarm).toHaveBeenCalledTimes(2));
		expect(await fs.readFile("/value")).toBe("new");
		expect(blob).not.toHaveBeenCalled();
	});

	it("does not install a delayed lazy read into a newer view", async () => {
		const { fs, state, blob } = fixture();
		await fs.ready();
		const pending = deferred<Uint8Array>();
		const started = deferred();
		blob.mockImplementationOnce(async () => {
			started.resolve();
			return pending.promise;
		});
		const oldRead = fs.readFile("/value");
		await started.promise;
		state.epoch++;
		state.rows = [root, file("/value", "new")];
		await fs.ensureFresh();
		pending.resolve(bytes("old"));
		expect(await oldRead).toBe("old");
		expect(await fs.readFile("/value")).toBe("new");
	});

	it("reload clears cached content and starts a new prewarm", async () => {
		const { fs, state, prewarm } = fixture();
		prewarm.mockResolvedValueOnce([{ inodeId: 2n, data: bytes("old") }]);
		await fs.ready();
		expect(await fs.readFile("/value")).toBe("old");
		state.rows = [root, file("/value", "new")];
		prewarm.mockResolvedValueOnce([{ inodeId: 2n, data: bytes("new") }]);
		await fs.reload();
		expect(await fs.readFile("/value")).toBe("new");
		expect(prewarm).toHaveBeenCalledTimes(2);
	});
});
