import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retirePostgresSandboxGeneration } from "../../../sql-fs/index.js";
import { readOnlyContext } from "../../read-only-context.js";
import { loadWorkerPoolOptions, WorkerOwnerPool } from "../../worker-owner/pool.js";
import { OutcomeUnknownError, type OwnerCommand, type OwnerIdentity } from "../../worker-owner/protocol.js";
import { latestMockWorker, MockOwnerWorker } from "../fixtures/mock-owner-worker.js";

vi.mock("node:worker_threads", async () => {
	const { MockOwnerWorker } = await import("../fixtures/mock-owner-worker.js");
	return { Worker: MockOwnerWorker };
});
vi.mock("../../../sql-fs/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../sql-fs/index.js")>()),
	retirePostgresSandboxGeneration: vi.fn(async () => {}),
}));

const pools: WorkerOwnerPool[] = [];
const retire = vi.mocked(retirePostgresSandboxGeneration);
const identity: OwnerIdentity = {
	tenantId: "tenant",
	sandboxId: "sandbox",
	connectionString: "unused-original",
	owner: "original",
	cwd: "/home/user",
	runtimeOptions: { python: false, javascript: false, network: false },
	openExisting: true,
};

beforeEach(() => {
	retire.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown(0);
	MockOwnerWorker.instances.length = 0;
	vi.restoreAllMocks();
});

function checkpoint() {
	let release = () => {};
	const reached = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { reached, release };
}

function fixture() {
	const pool = new WorkerOwnerPool(loadWorkerPoolOptions({ SQL_FS_WORKER_COUNT: "1" }));
	pools.push(pool);
	return { pool, admitted: <T>(fn: () => Promise<T>) => pool.run(identity.tenantId, identity.sandboxId, false, fn) };
}

function coded(code: string): Error & { code: string } {
	return Object.assign(new Error(code), { code });
}

describe("worker request outcomes", () => {
	it.each([
		{ openExisting: false, code: "EEXEC_OUTCOME_UNKNOWN", recoveries: 1 },
		{ openExisting: true, code: "ELOCKLOST", recoveries: 0 },
	])(
		"classifies lease loss after an attach with openExisting=$openExisting",
		async ({ openExisting, code, recoveries }) => {
			const { pool, admitted } = fixture();
			await pool.start();
			const worker = latestMockWorker();
			worker.onPost = (request) => worker.reply(request, { ok: false, error: coded("ELOCKLOST") });

			await expect(
				admitted(() => pool.withLease(undefined, () => pool.attach({ ...identity, openExisting }))),
			).rejects.toMatchObject({
				code,
			});
			expect(retire).toHaveBeenCalledTimes(recoveries);
			expect(worker.terminationCalls).toBe(recoveries);
			expect(pool.metrics.unknownOutcomes).toBe(recoveries);
		},
	);

	it("does not advertise effects when creating attach fails before postMessage succeeds", async () => {
		const { pool, admitted } = fixture();
		await pool.start();
		const worker = latestMockWorker();
		worker.postFailure = new Error("message rejected before dispatch");

		await expect(
			admitted(() => pool.withLease(undefined, () => pool.attach({ ...identity, openExisting: false }))),
		).rejects.toMatchObject({
			code: "EWORKER_UNAVAILABLE",
		});
		expect(worker.requests).toEqual([]);
		expect(retire).not.toHaveBeenCalled();
		expect(pool.metrics.unknownOutcomes).toBe(0);
	});

	it("preserves lease loss before any dispatch without recovery", async () => {
		const { pool, admitted } = fixture();
		const error = coded("ELOCKLOST");

		await expect(admitted(() => pool.withLease(undefined, async () => Promise.reject(error)))).rejects.toBe(error);
		expect(retire).not.toHaveBeenCalled();
		expect(pool.metrics.unknownOutcomes).toBe(0);
	});

	it("keeps buffered write acknowledgments distinct from committed effects on lease loss", async () => {
		const { pool, admitted } = fixture();
		const error = coded("ELOCKLOST");
		await admitted(async () => {
			await pool.attach(identity);
			await expect(
				pool.withLease(undefined, async () => {
					await pool.send({ kind: "beginScope" });
					await pool.send({ kind: "writeFile", args: ["/pending", "buffered"] });
					throw error;
				}),
			).rejects.toBe(error);
			await pool.send({ kind: "abortScope" });
			expect(latestMockWorker().terminationCalls).toBe(0);
		});
		expect(retire).not.toHaveBeenCalled();
		expect(pool.metrics.unknownOutcomes).toBe(0);
	});

	it("reports transport loss after an acknowledged buffered write as unknown", async () => {
		const { pool, admitted } = fixture();
		await admitted(async () => {
			await pool.attach(identity);
			await pool.send({ kind: "beginScope" });
			await pool.send({ kind: "writeFile", args: ["/pending", "buffered"] });
			const worker = latestMockWorker();
			worker.onPost = () => queueMicrotask(() => worker.emit("exit", 1));

			await expect(pool.send({ kind: "paths" })).rejects.toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN" });
		});
	});

	it("keeps a lost read reply without an effectful prefix unavailable", async () => {
		const { pool, admitted } = fixture();
		await admitted(async () => {
			await pool.attach(identity);
			const worker = latestMockWorker();
			worker.onPost = () => queueMicrotask(() => worker.emit("exit", 1));

			await expect(pool.send({ kind: "paths" })).rejects.toMatchObject({ code: "EWORKER_UNAVAILABLE" });
		});
	});

	it.each([
		{ name: "no prefix", commands: [], readOnly: false, code: "ERUNTIME_BUSY" },
		{
			name: "exec prefix",
			commands: [{ kind: "exec", script: "external POST", options: {} }],
			readOnly: false,
			code: "EEXEC_OUTCOME_UNKNOWN",
		},
		{
			name: "read-only exec prefix",
			commands: [{ kind: "exec", script: "external POST", options: {} }],
			readOnly: true,
			code: "EEXEC_OUTCOME_UNKNOWN",
		},
		{
			name: "committed file prefix",
			commands: [{ kind: "writeFile", args: ["/prefix", "applied"] }],
			readOnly: false,
			code: "EEXEC_OUTCOME_UNKNOWN",
		},
		{
			name: "buffered file prefix",
			commands: [{ kind: "beginScope" }, { kind: "writeFile", args: ["/prefix", "pending"] }],
			readOnly: false,
			code: "ERUNTIME_BUSY",
		},
		{
			name: "committed scope prefix",
			commands: [{ kind: "beginScope" }, { kind: "writeFile", args: ["/prefix", "pending"] }, { kind: "endScope" }],
			readOnly: false,
			code: "EEXEC_OUTCOME_UNKNOWN",
		},
	] satisfies Array<{ name: string; commands: OwnerCommand[]; readOnly: boolean; code: string }>)(
		"classifies runtime refusal after $name without retiring the worker",
		async ({ commands, readOnly, code }) => {
			const { pool, admitted } = fixture();
			await admitted(async () => {
				await pool.attach(identity);
				const run = () =>
					pool.withLease(undefined, async () => {
						for (const command of commands) await pool.send(command);
						throw coded("ERUNTIME_BUSY");
					});

				await expect(readOnly ? readOnlyContext.run({ violated: false }, run) : run()).rejects.toMatchObject({ code });
				expect(latestMockWorker().terminationCalls).toBe(0);
			});
			expect(retire).not.toHaveBeenCalled();
			expect(pool.metrics.unknownOutcomes).toBe(0);
		},
	);

	it("promotes ECOHERENCE after dispatched exec and retires the worker without replay", async () => {
		const { pool, admitted } = fixture();
		await admitted(async () => {
			await pool.attach(identity);
			const worker = latestMockWorker();
			worker.onPost = (request) => {
				if (request.command.kind === "exec") {
					worker.reply(request, {
						ok: false,
						error: coded("ECOHERENCE"),
					});
					return;
				}
				worker.reply(request, { ok: true, value: undefined });
			};
			let outcome: unknown;
			try {
				await pool.withLease(undefined, async () => {
					try {
						await pool.send({ kind: "exec", script: "echo once", options: {} });
					} catch (error) {
						await pool.recover(error);
						expect(pool.metrics.unknownOutcomes).toBe(0);
						throw error;
					}
				});
			} catch (error) {
				outcome = error;
			}
			expect(outcome).toMatchObject({
				code: "EEXEC_OUTCOME_UNKNOWN",
				message: expect.stringContaining("inspect sandbox state before proceeding"),
			});
			expect(worker.requests.filter(({ command }) => command.kind === "exec")).toHaveLength(1);
			expect(worker.terminationCalls).toBe(1);
		});
		expect(retire).toHaveBeenCalledTimes(1);
		expect(pool.metrics.unknownOutcomes).toBe(1);
	});

	it("preserves input-budget errors after exec dispatch because execution was refused", async () => {
		const { pool, admitted } = fixture();
		await admitted(async () => {
			await pool.attach(identity);
			const worker = latestMockWorker();
			worker.onPost = (request) => worker.reply(request, { ok: false, error: coded("EEXEC_INPUT_LIMIT") });
			await expect(
				pool.withLease(undefined, () => pool.send({ kind: "exec", script: "too large", options: {} })),
			).rejects.toMatchObject({ code: "EEXEC_INPUT_LIMIT" });
			expect(worker.terminationCalls).toBe(0);
		});
		expect(retire).not.toHaveBeenCalled();
		expect(pool.metrics.unknownOutcomes).toBe(0);
	});

	it("does not promote runtime refusal for an unacknowledged creating attach alone", async () => {
		const { pool, admitted } = fixture();
		await pool.start();
		const worker = latestMockWorker();
		worker.onPost = (request) => worker.reply(request, { ok: false, error: coded("ECREATE") });
		await admitted(async () => {
			await expect(pool.attach({ ...identity, openExisting: false })).rejects.toMatchObject({ code: "ECREATE" });
			await expect(pool.withLease(undefined, async () => Promise.reject(coded("ERUNTIME_BUSY")))).rejects.toMatchObject(
				{
					code: "ERUNTIME_BUSY",
				},
			);
		});
		expect(retire).not.toHaveBeenCalled();
		expect(pool.metrics.unknownOutcomes).toBe(0);
	});

	it.each(["ECOHERENCE", "EDRIVERFAULT", "08006", "ELOCKLOST_APPLIED", "EEXEC_OUTCOME_UNKNOWN"])(
		"preserves the existing ambiguous %s error after lease loss",
		async (code) => {
			const { pool, admitted } = fixture();
			const lease = new AbortController();
			const primary = coded(code);
			await expect(
				admitted(async () => {
					await pool.attach(identity);
					return pool.withLease(lease.signal, async () => {
						await pool.send({ kind: "exec", script: "applied", options: {} });
						lease.abort();
						throw primary;
					});
				}),
			).rejects.toBe(primary);
			expect(retire).toHaveBeenCalledTimes(1);
			expect(pool.metrics.unknownOutcomes).toBe(1);
		},
	);

	it("handles loss discovered after completed work without replaying it", async () => {
		const { pool, admitted } = fixture();
		await admitted(async () => {
			await pool.attach(identity);
			await pool.withLease(undefined, () => pool.send({ kind: "exec", script: "once", options: {} }));
			await expect(pool.leaseLostAfterWork()).rejects.toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN" });
			expect(latestMockWorker().requests.filter(({ command }) => command.kind === "exec")).toHaveLength(1);
		});
		expect(retire).toHaveBeenCalledTimes(1);
	});

	it("memoizes rejected recovery and permits a later replacement generation to recover", async () => {
		const { pool, admitted } = fixture();
		const failure = new Error("retirement failed");
		retire.mockRejectedValueOnce(failure);
		await admitted(async () => {
			await pool.attach(identity);
			await expect(pool.recover(new OutcomeUnknownError())).rejects.toBe(failure);
			await expect(pool.recover(new OutcomeUnknownError())).rejects.toBe(failure);
			expect(retire).toHaveBeenCalledTimes(1);
			expect(pool.metrics.unknownOutcomes).toBe(1);

			await pool.attach(identity);
			await pool.recover(new OutcomeUnknownError());
			expect(retire).toHaveBeenCalledTimes(2);
			expect(pool.metrics.unknownOutcomes).toBe(2);
		});
	});

	it("shares an in-flight recovery within one reservation and generation", async () => {
		const { pool, admitted } = fixture();
		const started = checkpoint();
		const finish = checkpoint();
		retire.mockImplementationOnce(async () => {
			started.release();
			await finish.reached;
		});
		await admitted(async () => {
			await pool.attach(identity);
			const first = pool.recover(new OutcomeUnknownError());
			await started.reached;
			const second = pool.recover(new OutcomeUnknownError());
			try {
				expect(retire).toHaveBeenCalledTimes(1);
				expect(pool.metrics.unknownOutcomes).toBe(1);
			} finally {
				finish.release();
			}
			await Promise.all([first, second]);
			expect(retire).toHaveBeenCalledTimes(1);
		});
	});

	it("retains an applied prefix when the request attaches a replacement generation", async () => {
		const { pool, admitted } = fixture();
		await admitted(async () => {
			await pool.attach(identity);
			await pool.send({ kind: "exec", script: "prefix applied", options: {} });
			await pool.recover(new OutcomeUnknownError());
			await pool.attach(identity);

			await expect(pool.withLease(undefined, async () => Promise.reject(coded("ERUNTIME_BUSY")))).rejects.toMatchObject(
				{
					code: "EEXEC_OUTCOME_UNKNOWN",
				},
			);
			expect(latestMockWorker().terminationCalls).toBe(0);
			expect(retire).toHaveBeenCalledTimes(1);
			expect(pool.metrics.unknownOutcomes).toBe(1);
		});
	});

	it("treats an acknowledged creating attach as a committed prefix for runtime refusal", async () => {
		const { pool, admitted } = fixture();
		await admitted(async () => {
			await pool.attach({ ...identity, openExisting: false });

			await expect(pool.withLease(undefined, async () => Promise.reject(coded("ERUNTIME_BUSY")))).rejects.toMatchObject(
				{
					code: "EEXEC_OUTCOME_UNKNOWN",
				},
			);
			expect(latestMockWorker().terminationCalls).toBe(0);
		});
		expect(retire).not.toHaveBeenCalled();
		expect(pool.metrics.unknownOutcomes).toBe(0);
	});

	it("does not close scope history until scope completion is acknowledged", async () => {
		const { pool, admitted } = fixture();
		await admitted(async () => {
			await pool.attach(identity);
			await pool.send({ kind: "beginScope" });
			const worker = latestMockWorker();
			worker.onPost = (request) => worker.reply(request, { ok: false, error: coded("ECOMMIT") });
			await expect(pool.send({ kind: "endScope" })).rejects.toMatchObject({ code: "ECOMMIT" });
			worker.onPost = undefined;
			await pool.send({ kind: "writeFile", args: ["/pending", "buffered"] });

			await expect(pool.withLease(undefined, async () => Promise.reject(coded("ERUNTIME_BUSY")))).rejects.toMatchObject(
				{
					code: "ERUNTIME_BUSY",
				},
			);
			await pool.send({ kind: "abortScope" });
			await pool.send({ kind: "writeFile", args: ["/standalone", "committed"] });
			await expect(pool.withLease(undefined, async () => Promise.reject(coded("ERUNTIME_BUSY")))).rejects.toMatchObject(
				{
					code: "EEXEC_OUTCOME_UNKNOWN",
				},
			);
		});
		expect(retire).not.toHaveBeenCalled();
	});

	it("reports an aborted lease after a successful callback as unknown", async () => {
		const { pool, admitted } = fixture();
		const lease = new AbortController();
		await expect(
			admitted(async () => {
				await pool.attach(identity);
				return pool.withLease(lease.signal, async () => {
					await pool.send({ kind: "exec", script: "once", options: {} });
					lease.abort();
					return "completed";
				});
			}),
		).rejects.toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN" });
		expect(retire).toHaveBeenCalledTimes(1);
	});

	it("captures the retired identity while attachment waits for old termination", async () => {
		const { pool, admitted } = fixture();
		await admitted(async () => {
			await pool.attach(identity);
			const oldWorker = latestMockWorker();
			const finish = checkpoint();
			oldWorker.termination = finish.reached;
			const recovery = pool.recover(new OutcomeUnknownError());
			const replacement = { ...identity, owner: "replacement", connectionString: "unused-replacement" };
			const attached = pool.attach(replacement);
			try {
				expect(retire).not.toHaveBeenCalled();
				expect(oldWorker.terminationCalls).toBe(1);
			} finally {
				finish.release();
			}
			await recovery;
			expect(await attached).toMatchObject({ owner: "replacement" });
			expect(retire).toHaveBeenCalledWith(identity.connectionString, identity.sandboxId);
			expect(latestMockWorker().terminationCalls).toBe(0);
		});
	});

	it("keeps replacement residency when the old generation finishes recovery later", async () => {
		const { pool, admitted } = fixture();
		const started = checkpoint();
		const finish = checkpoint();
		retire.mockImplementationOnce(async () => {
			started.release();
			await finish.reached;
		});
		await admitted(async () => {
			await pool.attach(identity);
			const recovery = pool.recover(new OutcomeUnknownError());
			await started.reached;
			try {
				await pool.attach({ ...identity, owner: "replacement" });
				expect(pool.metadata).toMatchObject({ owner: "replacement" });
			} finally {
				finish.release();
			}
			await recovery;
			expect(pool.metadata).toMatchObject({ owner: "replacement" });
			expect(await pool.send({ kind: "paths" })).toEqual(["/home/user"]);
			expect(latestMockWorker().terminationCalls).toBe(0);
		});
	});

	it("keeps separate pool reservations independent for the same sandbox", async () => {
		const { pool: first, admitted: firstRun } = fixture();
		const { pool: second, admitted: secondRun } = fixture();
		await firstRun(async () => {
			expect(first.hasReservation(identity.sandboxId)).toBe(true);
			expect(second.hasReservation(identity.sandboxId)).toBe(false);
			await secondRun(async () => {
				expect(first.hasReservation(identity.sandboxId)).toBe(true);
				expect(second.hasReservation(identity.sandboxId)).toBe(true);
				expect(first.metrics.active).toBe(1);
				expect(second.metrics.active).toBe(1);
				second.markRunning();
				expect(first.metrics.lockWaiting).toBe(1);
				expect(second.metrics.runningOperations).toBe(1);
			});
			expect(first.hasReservation(identity.sandboxId)).toBe(true);
			expect(second.hasReservation()).toBe(false);
			expect(first.metrics.active).toBe(1);
			expect(second.metrics).toMatchObject({ active: 0, admitted: 1, completed: 1 });
		});
		expect(first.hasReservation()).toBe(false);
		expect(second.hasReservation()).toBe(false);
		expect(first.metrics).toMatchObject({ active: 0, admitted: 1, completed: 1 });
	});

	it("exposes reservation and operation phases through intent methods and metrics", async () => {
		const { pool, admitted } = fixture();
		expect(pool.hasReservation()).toBe(false);
		await admitted(async () => {
			expect(pool.hasReservation(identity.sandboxId)).toBe(true);
			expect(pool.hasReservation("other")).toBe(false);
			expect(pool.metrics.lockWaiting).toBe(1);
			await pool.attach(identity);
			pool.markRunning();
			expect(pool.metrics).toMatchObject({ lockWaiting: 0, runningOperations: 1 });
			await pool.recover(coded("EWORKER_UNAVAILABLE"));
			expect(pool.metrics).toMatchObject({ runningOperations: 0, recoveringOperations: 1, unknownOutcomes: 0 });
		});
		expect(pool.hasReservation()).toBe(false);
	});
});
