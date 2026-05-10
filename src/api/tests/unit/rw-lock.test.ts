/**
 * Unit tests for the async readers-writer lock primitive used by the
 * parallel-readOnly bash exec path.
 *
 * Coverage:
 *  - Multiple readers run in parallel under shared mode.
 *  - Writer waits for in-flight readers to drain before entering.
 *  - New readers wait when a writer is queued (writer-priority — no
 *    reader-starvation).
 *  - Writers wait for prior writer to release.
 *  - Aborting a queued waiter cancels it without affecting holders.
 *  - fn errors release the lock.
 */

import { describe, expect, it } from "vitest";
import { RWLock } from "../../rw-lock.js";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("RWLock", () => {
	it("runs multiple shared acquisitions in parallel", async () => {
		const lock = new RWLock();
		let active = 0;
		let peak = 0;
		const work = async (): Promise<void> => {
			active++;
			peak = Math.max(peak, active);
			await tick();
			active--;
		};

		await Promise.all([lock.runShared(work), lock.runShared(work), lock.runShared(work), lock.runShared(work)]);

		expect(peak).toBe(4);
		expect(lock.activeReaders).toBe(0);
		expect(lock.writerHeld).toBe(false);
	});

	it("a writer waits for in-flight readers to drain", async () => {
		const lock = new RWLock();
		const order: string[] = [];

		let release1!: () => void;
		const reader1 = lock.runShared(async () => {
			order.push("r1-acquired");
			await new Promise<void>((res) => {
				release1 = res;
			});
			order.push("r1-released");
		});

		await tick();
		expect(lock.activeReaders).toBe(1);

		const writer = lock.runExclusive(async () => {
			order.push("w-acquired");
		});

		// Writer must not run while reader holds shared lock.
		await tick();
		await tick();
		expect(order).toEqual(["r1-acquired"]);
		expect(lock.writerHeld).toBe(false);

		release1();
		await reader1;
		await writer;
		expect(order).toEqual(["r1-acquired", "r1-released", "w-acquired"]);
		expect(lock.writerHeld).toBe(false);
	});

	it("new readers wait when a writer is queued (writer-priority)", async () => {
		const lock = new RWLock();
		const order: string[] = [];

		let release1!: () => void;
		const reader1 = lock.runShared(async () => {
			order.push("r1-acquired");
			await new Promise<void>((res) => {
				release1 = res;
			});
			order.push("r1-released");
		});
		await tick();

		// Queue a writer behind the in-flight reader.
		const writer = lock.runExclusive(async () => {
			order.push("w-acquired");
		});
		await tick();

		// New readers arrive while the writer is queued — they must wait
		// behind the writer (no reader-starvation of the writer).
		const reader2 = lock.runShared(async () => {
			order.push("r2-acquired");
		});
		const reader3 = lock.runShared(async () => {
			order.push("r3-acquired");
		});
		await tick();

		expect(order).toEqual(["r1-acquired"]);

		release1();
		await Promise.all([reader1, writer, reader2, reader3]);

		// Writer entered before the queued readers, then both readers proceeded
		// in parallel after the writer released.
		expect(order).toEqual([
			"r1-acquired",
			"r1-released",
			"w-acquired",
			expect.stringMatching(/^r[23]-acquired$/),
			expect.stringMatching(/^r[23]-acquired$/),
		]);
	});

	it("queued shared waiters batch-wake after a writer releases", async () => {
		const lock = new RWLock();
		let release!: () => void;
		const writer = lock.runExclusive(async () => {
			await new Promise<void>((r) => {
				release = r;
			});
		});
		await tick();

		let active = 0;
		let peak = 0;
		const reader = (): Promise<void> =>
			lock.runShared(async () => {
				active++;
				peak = Math.max(peak, active);
				await tick();
				active--;
			});

		const readers = Promise.all([reader(), reader(), reader()]);
		await tick();
		expect(peak).toBe(0); // none have entered yet

		release();
		await writer;
		await readers;
		expect(peak).toBe(3); // all three woke up in one dispatch and ran in parallel
	});

	it("subsequent writer waits for prior writer", async () => {
		const lock = new RWLock();
		const order: string[] = [];

		let release1!: () => void;
		const w1 = lock.runExclusive(async () => {
			order.push("w1-acquired");
			await new Promise<void>((r) => {
				release1 = r;
			});
		});
		await tick();
		const w2 = lock.runExclusive(async () => {
			order.push("w2-acquired");
		});
		await tick();
		expect(order).toEqual(["w1-acquired"]);
		release1();
		await Promise.all([w1, w2]);
		expect(order).toEqual(["w1-acquired", "w2-acquired"]);
	});

	it("aborts a queued shared acquisition without affecting holders", async () => {
		const lock = new RWLock();
		let release!: () => void;
		const writer = lock.runExclusive(async () => {
			await new Promise<void>((r) => {
				release = r;
			});
		});
		await tick();

		const ac = new AbortController();
		const reader = lock.runShared(async () => {
			throw new Error("must not run");
		}, ac.signal);
		await tick();
		expect(lock.pendingCount).toBe(1);

		ac.abort();
		await expect(reader).rejects.toMatchObject({ code: "ABORTED" });
		expect(lock.pendingCount).toBe(0);

		release();
		await writer;
	});

	it("aborts a queued exclusive acquisition without affecting holders", async () => {
		const lock = new RWLock();
		let release!: () => void;
		const reader = lock.runShared(async () => {
			await new Promise<void>((r) => {
				release = r;
			});
		});
		await tick();

		const ac = new AbortController();
		const writer = lock.runExclusive(async () => {
			throw new Error("must not run");
		}, ac.signal);
		await tick();
		ac.abort();
		await expect(writer).rejects.toMatchObject({ code: "ABORTED" });

		release();
		await reader;

		// Lock is fully drained; a fresh exclusive should acquire immediately.
		await lock.runExclusive(async () => {});
	});

	it("rejects immediately for a pre-aborted signal", async () => {
		const lock = new RWLock();
		const ac = new AbortController();
		ac.abort();
		await expect(lock.runShared(async () => {}, ac.signal)).rejects.toMatchObject({ code: "ABORTED" });
		await expect(lock.runExclusive(async () => {}, ac.signal)).rejects.toMatchObject({ code: "ABORTED" });
		expect(lock.pendingCount).toBe(0);
	});

	it("releases the lock when fn throws", async () => {
		const lock = new RWLock();
		await expect(
			lock.runExclusive(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(lock.writerHeld).toBe(false);

		await expect(
			lock.runShared(async () => {
				throw new Error("boom2");
			}),
		).rejects.toThrow("boom2");
		expect(lock.activeReaders).toBe(0);

		// Lock is reusable post-error.
		await lock.runExclusive(async () => {});
	});
});
