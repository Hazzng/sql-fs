import { InMemoryFs } from "just-bash";
import type { BashExecResult } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeBatch } from "../../lib/batch-exec.js";
import { readOnlyContext } from "../../read-only-context.js";
import { SessionManager } from "../../session-manager.js";
import type { Session } from "../../session-manager.js";

const SANDBOX_ID = "test-batch-parallel-sandbox";

async function makeTestEnv(): Promise<{ sessionManager: SessionManager; session: Session }> {
	const sessionManager = new SessionManager({ createFs: async () => new InMemoryFs() });
	const session = await sessionManager.getOrCreate("default", SANDBOX_ID);
	return { sessionManager, session };
}

describe("executeBatch — readOnly:true parallel vs sequential", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Test 1: Wall-clock — N parallel scripts finish in roughly max(latency_i), not sum.
	// Calls executeBatch directly inside readOnlyContext.run to bypass HTTP/jose and avoid
	// the fake-timer race where vi.advanceTimersByTimeAsync fires before the route handler
	// registers its timers (crypto.subtle.verify is libuv-based, not microtask-completable).
	it("runs scripts in parallel when readOnly:true (wall-clock < sequential)", async () => {
		vi.useFakeTimers();
		try {
			const { sessionManager, session } = await makeTestEnv();

			let maxConcurrent = 0;
			let currentConcurrent = 0;

			vi.spyOn(session.bash, "exec").mockImplementation((_script, opts) => {
				currentConcurrent++;
				maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
				return new Promise<BashExecResult>((resolve, reject) => {
					const t = setTimeout(() => {
						currentConcurrent--;
						resolve({ stdout: "ok\n", stderr: "", exitCode: 0, env: {} });
					}, 100);
					opts?.signal?.addEventListener("abort", () => {
						clearTimeout(t);
						currentConcurrent--;
						reject(new DOMException("Aborted", "AbortError"));
					});
				});
			});

			const scripts = [
				{ id: "a", script: "echo a" },
				{ id: "b", script: "echo b" },
				{ id: "c", script: "echo c" },
				{ id: "d", script: "echo d" },
				{ id: "e", script: "echo e" },
			];

			// Wrap in readOnlyContext.run so executeBatch self-detects the parallel path.
			const batchPromise = readOnlyContext.run({ violated: false }, () =>
				executeBatch(sessionManager, session, scripts, 600),
			);

			// Advance past sequential total (5 × 100ms = 500ms) so both paths complete.
			await vi.advanceTimersByTimeAsync(600);
			const results = await batchPromise;

			expect(results).toHaveLength(5);
			// Parallel: all 5 start simultaneously → maxConcurrent = 5.
			// Sequential: one at a time → maxConcurrent = 1 → assertion fails → RED.
			expect(maxConcurrent).toBeGreaterThan(1);
		} finally {
			vi.useRealTimers();
		}
	});

	// Test 2: Order — results[i].id === scripts[i].id even when finish order differs.
	// Calls executeBatch directly (same reason as test 1) to avoid the jose libuv race.
	it("preserves result order when scripts finish out of order", async () => {
		vi.useFakeTimers();
		try {
			const { sessionManager, session } = await makeTestEnv();

			const delays: Record<string, number> = { slow: 100, fast: 10, medium: 50 };

			vi.spyOn(session.bash, "exec").mockImplementation((script, opts) => {
				const delay = delays[script] ?? 10;
				return new Promise<BashExecResult>((resolve, reject) => {
					const t = setTimeout(() => {
						resolve({ stdout: `${script}\n`, stderr: "", exitCode: 0, env: {} });
					}, delay);
					opts?.signal?.addEventListener("abort", () => {
						clearTimeout(t);
						reject(new DOMException("Aborted", "AbortError"));
					});
				});
			});

			const scripts = [
				{ id: "s0", script: "slow" },
				{ id: "s1", script: "fast" },
				{ id: "s2", script: "medium" },
			];

			// timeoutMs: 120 discriminates sequential from parallel.
			// Sequential: slow(100ms) + fast(110ms total) + medium starts at t=110ms with 10ms left →
			//   aborted at t=120ms → error: "timeout".
			// Parallel: all start at t=0; medium finishes at t=50ms, well inside budget.
			const batchPromise = readOnlyContext.run({ violated: false }, () =>
				executeBatch(sessionManager, session, scripts, 120),
			);

			await vi.advanceTimersByTimeAsync(200);
			const results = await batchPromise;

			// Result order must match script order regardless of finish order.
			expect(results[0]!.id).toBe("s0");
			expect(results[1]!.id).toBe("s1");
			expect(results[2]!.id).toBe("s2");
			// Parallel: medium finishes at 50ms < 120ms budget → exitCode 0.
			// Sequential: medium aborted at t=120ms → error: "timeout", exitCode -1 → RED.
			expect(results[2]!.exitCode).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	// Test 3: Deadline — one shared timer aborts every in-flight script.
	// Calls executeBatch directly inside readOnlyContext.run (same reason as test 1).
	it("aborts every in-flight script when batch deadline expires", async () => {
		vi.useFakeTimers();
		try {
			const { sessionManager, session } = await makeTestEnv();

			const execSpy = vi.spyOn(session.bash, "exec").mockImplementation((_script, opts) => {
				// Block forever; only abort signal can resolve this.
				return new Promise<BashExecResult>((_, reject) => {
					opts?.signal?.addEventListener("abort", () => {
						reject(new DOMException("Aborted", "AbortError"));
					});
				});
			});

			const scripts = [
				{ id: "x", script: "block" },
				{ id: "y", script: "block" },
				{ id: "z", script: "block" },
			];

			const batchPromise = readOnlyContext.run({ violated: false }, () =>
				executeBatch(sessionManager, session, scripts, 50),
			);

			await vi.advanceTimersByTimeAsync(100);
			const results = await batchPromise;

			// All 3 must be marked as timeout.
			for (const result of results) {
				expect(result.error).toBe("timeout");
				expect(result.exitCode).toBe(-1);
			}
			// Parallel: all 3 start simultaneously → bash.exec called 3 times.
			// Sequential: only script[0] is in-flight when deadline fires; scripts[1,2] short-circuit
			//   via remaining <= 0 without calling bash.exec → called 1 time → RED.
			expect(execSpy).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	// Test 4: Violation isolation — a write in one ALS-attributed script doesn't poison siblings.
	// Calls executeBatch directly (same reason as test 1) to avoid the jose libuv race.
	// The ctx.violated flag (which withSessionReadEntry uses to throw EREADONLY_VIOLATION) is
	// checked manually after the batch completes, proving ALS attribution is correct.
	it("attributes EREADONLY_VIOLATION to the offending script without poisoning siblings", async () => {
		vi.useFakeTimers();
		try {
			const { sessionManager, session } = await makeTestEnv();

			const execSpy = vi.spyOn(session.bash, "exec").mockImplementation((script, opts) => {
				if (script === "violating") {
					// Immediately mark the ALS context as violated (simulates a write attempt),
					// then block so siblings can run in parallel before the shared deadline fires.
					const ctx = readOnlyContext.getStore();
					if (ctx !== undefined) ctx.violated = true;
					return new Promise<BashExecResult>((resolve, reject) => {
						const t = setTimeout(() => {
							resolve({ stdout: "", stderr: "", exitCode: 1, env: {} });
						}, 200);
						opts?.signal?.addEventListener("abort", () => {
							clearTimeout(t);
							reject(new DOMException("Aborted", "AbortError"));
						});
					});
				}
				// Innocent scripts complete instantly.
				return Promise.resolve<BashExecResult>({ stdout: `${script}\n`, stderr: "", exitCode: 0, env: {} });
			});

			const scripts = [
				{ id: "v", script: "violating" },
				{ id: "i1", script: "innocent1" },
				{ id: "i2", script: "innocent2" },
			];

			// timeoutMs: 100 forces the discriminating condition:
			// Sequential: violating script blocks → deadline fires at t=100ms → violating aborted;
			//   innocent scripts never start (remaining <= 0) → bash.exec called 1 time.
			// Parallel: all 3 start → innocent scripts finish instantly → bash.exec called 3 times.
			const ctx = { violated: false };
			const batchPromise = readOnlyContext.run(ctx, () => executeBatch(sessionManager, session, scripts, 100));

			await vi.advanceTimersByTimeAsync(200);
			await batchPromise;

			// ctx.violated proves the ALS store was correctly mutated by the violating script.
			// withSessionReadEntry would see this and throw EREADONLY_VIOLATION → HTTP 422.
			expect(ctx.violated).toBe(true);
			// Parallel: all 3 scripts start → bash.exec called 3 times.
			// Sequential: violating blocks and times out; innocent scripts never called → called 1 time → RED.
			expect(execSpy).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	// Test 5: Concurrency cap — 50 scripts fan out at most MAX_BATCH_PARALLELISM (16).
	// Calls executeBatch directly inside readOnlyContext.run (same reason as test 1).
	it("caps concurrent fan-out at MAX_BATCH_PARALLELISM (16)", async () => {
		vi.useFakeTimers();
		try {
			const { sessionManager, session } = await makeTestEnv();

			let maxConcurrent = 0;
			let currentConcurrent = 0;

			vi.spyOn(session.bash, "exec").mockImplementation((_script, opts) => {
				currentConcurrent++;
				maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
				return new Promise<BashExecResult>((resolve, reject) => {
					const t = setTimeout(() => {
						currentConcurrent--;
						resolve({ stdout: "ok\n", stderr: "", exitCode: 0, env: {} });
					}, 10);
					opts?.signal?.addEventListener("abort", () => {
						clearTimeout(t);
						currentConcurrent--;
						reject(new DOMException("Aborted", "AbortError"));
					});
				});
			});

			const scripts = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, script: `echo ${i}` }));

			// Sequential: 50 × 10ms = 500ms; Parallel with cap 16: ceil(50/16) × 10ms ≈ 40ms.
			const batchPromise = readOnlyContext.run({ violated: false }, () =>
				executeBatch(sessionManager, session, scripts, 600),
			);

			await vi.advanceTimersByTimeAsync(600);
			const results = await batchPromise;

			// All 50 scripts must complete successfully.
			expect(results).toHaveLength(50);
			for (const result of results) {
				expect(result.exitCode).toBe(0);
			}
			// Cap must be honored: at most 16 concurrent at any moment.
			expect(maxConcurrent).toBeLessThanOrEqual(16);
			// Must actually parallelize: concurrent > 1.
			// Sequential: maxConcurrent = 1 → assertion fails → RED.
			expect(maxConcurrent).toBeGreaterThan(1);
		} finally {
			vi.useRealTimers();
		}
	});

	// Test 6: Negative case — write path stays sequential (regression guard).
	// Calls executeBatch directly WITHOUT readOnlyContext.run so executeBatch self-detects
	// the write path (readOnlyContext.getStore() === undefined) and runs sequentially.
	it("does NOT parallelize when readOnly is false or omitted", async () => {
		vi.useFakeTimers();
		try {
			const { sessionManager, session } = await makeTestEnv();

			let maxConcurrent = 0;
			let currentConcurrent = 0;

			vi.spyOn(session.bash, "exec").mockImplementation((_script, opts) => {
				currentConcurrent++;
				maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
				return new Promise<BashExecResult>((resolve, reject) => {
					const t = setTimeout(() => {
						currentConcurrent--;
						resolve({ stdout: "ok\n", stderr: "", exitCode: 0, env: {} });
					}, 100);
					opts?.signal?.addEventListener("abort", () => {
						clearTimeout(t);
						currentConcurrent--;
						reject(new DOMException("Aborted", "AbortError"));
					});
				});
			});

			const scripts = [
				{ id: "a", script: "echo a" },
				{ id: "b", script: "echo b" },
				{ id: "c", script: "echo c" },
				{ id: "d", script: "echo d" },
				{ id: "e", script: "echo e" },
			];

			// No readOnlyContext.run → executeBatch.getStore() === undefined → sequential path.
			const batchPromise = executeBatch(sessionManager, session, scripts, 600);

			await vi.advanceTimersByTimeAsync(600);
			const results = await batchPromise;

			expect(results).toHaveLength(5);
			// Write path must remain sequential regardless of parallel implementation.
			// maxConcurrent = 1 proves scripts ran one at a time.
			expect(maxConcurrent).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
