import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerFileSystem, WorkerScriptScope } from "../../worker-owner/filesystem.js";
import { WorkerOwnerPool, loadWorkerPoolOptions } from "../../worker-owner/pool.js";

const pools: WorkerOwnerPool[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const pool of pools.splice(0)) await pool.shutdown(0);
});

function fixture() {
	const pool = new WorkerOwnerPool(loadWorkerPoolOptions({ SQL_FS_WORKER_COUNT: "1" }));
	pools.push(pool);
	const scope = new WorkerScriptScope(new WorkerFileSystem(pool, "sandbox"));
	const send = vi.spyOn(pool, "send");
	return { scope, send, admitted: <T>(fn: () => Promise<T>) => pool.run("tenant", "sandbox", false, fn) };
}

describe("worker script scope completion", () => {
	it("never invokes the body or aborts a scope when begin is rejected", async () => {
		const { scope, send, admitted } = fixture();
		const primary = new Error("begin rejected");
		const body = vi.fn(async () => "unused");
		send.mockRejectedValue(primary);

		await expect(admitted(() => scope.run(body))).rejects.toBe(primary);

		expect(body).not.toHaveBeenCalled();
		expect(scope.isActive).toBe(false);
		expect(send.mock.calls.map(([command]) => command.kind)).toEqual(["beginScope"]);
	});

	it("clears its active state and preserves the body error when abort fails", async () => {
		const { scope, send, admitted } = fixture();
		const primary = new Error("body failed");
		send.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("abort failed"));

		await expect(admitted(() => scope.run(async () => Promise.reject(primary)))).rejects.toBe(primary);

		expect(scope.isActive).toBe(false);
		expect(send.mock.calls.map(([command]) => command.kind)).toEqual(["beginScope", "abortScope"]);
	});

	it("clears its active state and preserves a failed commit", async () => {
		const { scope, send, admitted } = fixture();
		const primary = new Error("commit failed");
		send.mockResolvedValueOnce(undefined).mockRejectedValueOnce(primary);

		await expect(admitted(() => scope.run(async () => "returned"))).rejects.toBe(primary);

		expect(scope.isActive).toBe(false);
		expect(send.mock.calls.map(([command]) => command.kind)).toEqual(["beginScope", "endScope"]);
	});

	it("leaves a borrowed scope open after success or failure", async () => {
		const { scope, send, admitted } = fixture();
		send.mockResolvedValue(undefined);
		await admitted(async () => {
			await scope.beginScope();
			await expect(scope.run(async () => "nested")).resolves.toBe("nested");
			expect(scope.isActive).toBe(true);
			const primary = new Error("nested failed");
			await expect(scope.run(async () => Promise.reject(primary))).rejects.toBe(primary);
			expect(scope.isActive).toBe(true);
			expect(send.mock.calls.map(([command]) => command.kind)).toEqual(["beginScope"]);
			await scope.abortScope();
			expect(scope.isActive).toBe(false);
		});
	});
});
