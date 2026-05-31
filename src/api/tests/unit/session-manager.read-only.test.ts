/**
 * Unit tests for SessionManager's parallel-readOnly bash exec entry point.
 *
 * Coverage:
 *  - Multiple withSessionRead calls run in parallel against the same sandbox.
 *  - withSessionRead waits for an in-flight write; a new write waits for
 *    in-flight readers.
 *  - The session FS is put into a read-only scope before fn runs and
 *    restored on exit; a violated flag surfaces EREADONLY_VIOLATION.
 *  - ensureFreshCache is single-flighted across parallel readers (one Redis
 *    GET, one reload).
 */

import type { Redis } from "ioredis";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { readOnlyContext } from "../../read-only-context.js";
import { SessionManager } from "../../session-manager.js";

const T = "default";

/**
 * Reference-counted IReadOnlyScopeFs that piggybacks on InMemoryFs. The
 * production SqlFs uses the same refcount + AsyncLocalStorage scheme — this
 * mock tracks depth so concurrent readers don't collide on a boolean flag.
 *
 * The host also exposes `simulateViolation(ctx)` so a test can mark a
 * specific reader's `readOnlyContext` store as violated, exercising the
 * per-cohort attribution path the SessionManager uses.
 */
class TestReadOnlyFs {
	readonly inner: InMemoryFs;
	depth = 0;
	beginCount = 0;
	endCount = 0;
	constructor() {
		this.inner = new InMemoryFs();
	}
	get readOnlyScopeActive(): boolean {
		return this.depth > 0;
	}
	beginReadOnlyScope(): void {
		this.depth++;
		this.beginCount++;
	}
	endReadOnlyScope(): void {
		if (this.depth === 0) throw new Error("no active read-only scope");
		this.depth--;
		this.endCount++;
	}
}

function adaptReadOnlyFs(host: TestReadOnlyFs): IFileSystem {
	// Proxy: forward IFileSystem calls to InMemoryFs but expose the
	// IReadOnlyScopeFs surface (begin/end/active) on the same object so
	// SessionManager's `asReadOnlyFs` duck-typed check sees it.
	const fs = host.inner as unknown as Record<string, unknown>;
	const merged = new Proxy(host as unknown as Record<string, unknown>, {
		get(target, prop, receiver) {
			if (prop in target) return Reflect.get(target, prop, receiver);
			const v = fs[prop as string];
			return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(host.inner) : v;
		},
	});
	return merged as unknown as IFileSystem;
}

/** Minimal ICoherentFs around InMemoryFs so ensureFreshCache will probe Redis. */
class CoherentInMemoryFs {
	readonly inner: InMemoryFs;
	#dirty = false;
	reloadCount = 0;
	constructor() {
		this.inner = new InMemoryFs();
	}
	wasDirty(): boolean {
		return this.#dirty;
	}
	clearDirty(): void {
		this.#dirty = false;
	}
	async reload(): Promise<void> {
		this.reloadCount++;
	}
}

function adaptCoherentFs(host: CoherentInMemoryFs): IFileSystem {
	const fs = host.inner as unknown as Record<string, unknown>;
	return new Proxy(host as unknown as Record<string, unknown>, {
		get(target, prop, receiver) {
			if (prop in target) return Reflect.get(target, prop, receiver);
			const v = fs[prop as string];
			return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(host.inner) : v;
		},
	}) as unknown as IFileSystem;
}

describe("SessionManager.withSessionRead", () => {
	it("multiple readOnly calls run in parallel on the same sandbox (refcounted scope)", async () => {
		// Uses a real IReadOnlyScopeFs mock so the refcount path is exercised.
		// The pre-fix impl threw "scope already active" on the second concurrent
		// reader against a scoped FS; this test would have caught that.
		const host = new TestReadOnlyFs();
		const sm = new SessionManager({ createFs: async () => adaptReadOnlyFs(host) });
		await sm.getOrCreate(T, "sb-parallel");

		let active = 0;
		let peak = 0;
		let peakDepth = 0;
		const work = async (): Promise<void> => {
			active++;
			peak = Math.max(peak, active);
			peakDepth = Math.max(peakDepth, host.depth);
			await new Promise((r) => setImmediate(r));
			active--;
		};

		await Promise.all([
			sm.withSessionRead(T, "sb-parallel", work),
			sm.withSessionRead(T, "sb-parallel", work),
			sm.withSessionRead(T, "sb-parallel", work),
			sm.withSessionRead(T, "sb-parallel", work),
		]);

		expect(peak).toBe(4); // all four ran simultaneously
		expect(peakDepth).toBe(4); // refcount tracked all four under shared scope
		expect(host.depth).toBe(0); // last reader cleared the scope
		expect(host.beginCount).toBe(4);
		expect(host.endCount).toBe(4);
	});

	it("readOnly waits for an in-flight writer", async () => {
		const sm = new SessionManager({ createFs: async () => new InMemoryFs() });
		await sm.getOrCreate(T, "sb-w-blocks-r");
		const order: string[] = [];

		let releaseW!: () => void;
		const writer = sm.withSession(T, "sb-w-blocks-r", async () => {
			order.push("w-start");
			await new Promise<void>((r) => {
				releaseW = r;
			});
			order.push("w-end");
		});

		// Wait for writer to enter
		await new Promise((r) => setImmediate(r));

		const reader = sm.withSessionRead(T, "sb-w-blocks-r", async () => {
			order.push("r-start");
			order.push("r-end");
		});

		await new Promise((r) => setImmediate(r));
		expect(order).toEqual(["w-start"]);

		releaseW();
		await Promise.all([writer, reader]);
		expect(order).toEqual(["w-start", "w-end", "r-start", "r-end"]);
	});

	it("a writer waits for in-flight readers and queues new readers behind it", async () => {
		const sm = new SessionManager({ createFs: async () => new InMemoryFs() });
		await sm.getOrCreate(T, "sb-r-blocks-w");
		const order: string[] = [];

		let releaseR1!: () => void;
		const reader1 = sm.withSessionRead(T, "sb-r-blocks-w", async () => {
			order.push("r1-start");
			await new Promise<void>((r) => {
				releaseR1 = r;
			});
			order.push("r1-end");
		});
		await new Promise((r) => setImmediate(r));

		const writer = sm.withSession(T, "sb-r-blocks-w", async () => {
			order.push("w-acquired");
		});
		await new Promise((r) => setImmediate(r));

		// New reader must wait behind the queued writer (writer-priority)
		const reader2 = sm.withSessionRead(T, "sb-r-blocks-w", async () => {
			order.push("r2-acquired");
		});
		await new Promise((r) => setImmediate(r));
		expect(order).toEqual(["r1-start"]);

		releaseR1();
		await Promise.all([reader1, writer, reader2]);
		expect(order).toEqual(["r1-start", "r1-end", "w-acquired", "r2-acquired"]);
	});

	it("opens and closes the read-only scope around fn on a scoped FS", async () => {
		const host = new TestReadOnlyFs();
		const sm = new SessionManager({ createFs: async () => adaptReadOnlyFs(host) });
		await sm.getOrCreate(T, "sb-scope");

		let activeDuringFn: boolean | undefined;
		await sm.withSessionRead(T, "sb-scope", async () => {
			activeDuringFn = host.readOnlyScopeActive;
		});
		expect(activeDuringFn).toBe(true);
		expect(host.readOnlyScopeActive).toBe(false);
		expect(host.beginCount).toBe(1);
		expect(host.endCount).toBe(1);
	});

	it("surfaces EREADONLY_VIOLATION when the per-call context was marked", async () => {
		const host = new TestReadOnlyFs();
		const sm = new SessionManager({ createFs: async () => adaptReadOnlyFs(host) });
		await sm.getOrCreate(T, "sb-violation");

		await expect(
			sm.withSessionRead(T, "sb-violation", async () => {
				// Simulate the SqlFs `#assertWritable` path marking *this* call's
				// AsyncLocalStorage context.
				const ctx = readOnlyContext.getStore();
				if (ctx !== undefined) ctx.violated = true;
			}),
		).rejects.toMatchObject({ code: "EREADONLY_VIOLATION" });

		// Scope is still closed even on the violation throw
		expect(host.readOnlyScopeActive).toBe(false);
		expect(host.endCount).toBe(1);
	});

	it("does not falsely flag an innocent concurrent reader when a sibling is lying", async () => {
		// Two readers run in parallel under one shared scope. Reader A's fn
		// triggers a violation on its own ALS context. Reader B's context
		// stays clean — it must not surface EREADONLY_VIOLATION.
		const host = new TestReadOnlyFs();
		const sm = new SessionManager({ createFs: async () => adaptReadOnlyFs(host) });
		await sm.getOrCreate(T, "sb-mixed");

		let releaseInnocent!: () => void;
		const innocentBlocker = new Promise<void>((r) => {
			releaseInnocent = r;
		});

		const liarP = sm.withSessionRead(T, "sb-mixed", async () => {
			// Wait until innocent reader is also in-flight so depth is 2.
			await new Promise((r) => setImmediate(r));
			expect(host.depth).toBe(2);
			const ctx = readOnlyContext.getStore();
			if (ctx !== undefined) ctx.violated = true;
		});

		const innocentP = sm.withSessionRead(T, "sb-mixed", async () => {
			await innocentBlocker;
		});

		await expect(liarP).rejects.toMatchObject({ code: "EREADONLY_VIOLATION" });
		releaseInnocent();
		await expect(innocentP).resolves.toBeUndefined();
		expect(host.depth).toBe(0);
	});

	it("remaps a raw EREADONLY thrown by fn to EREADONLY_VIOLATION", async () => {
		// Bash redirections (`echo > f`) let SqlFs's synchronous EREADONLY
		// reject through bash.exec rather than turning it into a non-zero exit.
		// withSessionReadEntry must remap the raw fs error to EREADONLY_VIOLATION
		// so route mapping is uniform.
		const host = new TestReadOnlyFs();
		const sm = new SessionManager({ createFs: async () => adaptReadOnlyFs(host) });
		await sm.getOrCreate(T, "sb-raw-ereadonly");

		await expect(
			sm.withSessionRead(T, "sb-raw-ereadonly", async () => {
				throw Object.assign(new Error("EREADONLY: read-only filesystem, writeFile '/x'"), { code: "EREADONLY" });
			}),
		).rejects.toMatchObject({ code: "EREADONLY_VIOLATION" });
		expect(host.readOnlyScopeActive).toBe(false);
		expect(host.endCount).toBe(1);
	});

	it("preserves the original error when fn throws even if a violation was recorded", async () => {
		const host = new TestReadOnlyFs();
		const sm = new SessionManager({ createFs: async () => adaptReadOnlyFs(host) });
		await sm.getOrCreate(T, "sb-violation-throw");

		await expect(
			sm.withSessionRead(T, "sb-violation-throw", async () => {
				const ctx = readOnlyContext.getStore();
				if (ctx !== undefined) ctx.violated = true;
				throw new Error("script blew up");
			}),
		).rejects.toThrow("script blew up");
		expect(host.readOnlyScopeActive).toBe(false);
	});

	it("audits the violation even when fn throws an unrelated error (e.g. timeout)", async () => {
		// Scenario: bash records EREADONLY mid-script (sets ctx.violated=true)
		// but the script keeps running and later aborts on a timeout — bash.exec
		// throws an AbortError. The original error must win as the caller-visible
		// throw, but the violation must STILL be audited so the security event
		// surfaces to monitoring.
		const host = new TestReadOnlyFs();
		const sm = new SessionManager({ createFs: async () => adaptReadOnlyFs(host) });
		await sm.getOrCreate(T, "sb-audit-on-throw");

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await expect(
			sm.withSessionRead(T, "sb-audit-on-throw", async () => {
				const ctx = readOnlyContext.getStore();
				if (ctx !== undefined) ctx.violated = true;
				throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
			}),
		).rejects.toThrow("The operation was aborted");

		const audited = logSpy.mock.calls.some((call) => {
			const arg = call[0];
			return typeof arg === "string" && arg.includes('"event":"read_only_violation"');
		});
		expect(audited).toBe(true);
		logSpy.mockRestore();
	});

	it("does not leak inFlight when fn throws", async () => {
		const host = new TestReadOnlyFs();
		const sm = new SessionManager({ createFs: async () => adaptReadOnlyFs(host) });
		const session = await sm.getOrCreate(T, "sb-inflight");
		expect(session.inFlight).toBe(0);

		await expect(
			sm.withSessionRead(T, "sb-inflight", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(session.inFlight).toBe(0);
		expect(host.depth).toBe(0);
	});

	it("single-flights ensureFreshCache across parallel readers", async () => {
		// Fake Redis that records every GET. The probe done by getOrCreate
		// for the initial version returns immediately; the probes done by
		// ensureFreshCache for the parallel readers block on `block` so we
		// can observe how many concurrent GETs are in-flight.
		const getCalls: string[] = [];
		let blockReads = false;
		let onceResolve!: () => void;
		const block = new Promise<void>((r) => {
			onceResolve = r;
		});
		const recordingRead = async (key: string): Promise<string> => {
			getCalls.push(key);
			if (blockReads) await block;
			return "0";
		};
		const fakeRedis: Partial<Redis> = {
			get: vi.fn(recordingRead),
			// ensureFreshCache + getOrCreate now read via GETEX (TTL refresh, audit H6).
			getex: vi.fn(recordingRead) as unknown as Redis["getex"],
			incr: vi.fn(async () => 1),
			expire: vi.fn(async () => 1),
			// eval is needed by withExecLockShared (distributed RW shared lock).
			// Return 1 so all shared acquire/renew/release ops succeed.
			eval: vi.fn(async () => 1),
		};

		const host = new CoherentInMemoryFs();
		const sm = new SessionManager({
			createFs: async () => adaptCoherentFs(host),
			redis: fakeRedis as Redis,
		});
		await sm.getOrCreate(T, "sb-single-flight");
		const initialGets = getCalls.length;
		blockReads = true;

		// Five readers in flight before the first GET resolves.
		const readers = Array.from({ length: 5 }, () => sm.withSessionRead(T, "sb-single-flight", async () => "ok"));

		// Let the readers progress through lock acquisition and reach ensureFreshCache.
		await new Promise<void>((r) => {
			const poll = (): void => {
				if (getCalls.length > initialGets) r();
				else setImmediate(poll);
			};
			setImmediate(poll);
		});
		// All five share one in-flight GET (single-flight ensureFreshCache).
		expect(getCalls.length - initialGets).toBe(1);

		onceResolve();
		await Promise.all(readers);
		// And no extra GET was issued for the rest of the cohort.
		expect(getCalls.length - initialGets).toBe(1);

		await sm.shutdown();
	});
});
