import type { Redis } from "ioredis";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { describe, expect, it } from "vitest";
import { rwLockKeys } from "../../distributed-rw-lock.js";
import { sessionLeaseSignal } from "../../session-lease-context.js";
import { SessionManager } from "../../session-manager.js";

interface StringEntry {
	value: string;
	expiresAt: number;
}

class FakeRedis {
	strings = new Map<string, StringEntry>();
	zsets = new Map<string, Map<string, number>>();

	/** When true, RENEW_EXCLUSIVE reports a DEFINITIVE ownership loss (returns 0). */
	forceExclusiveRenewLost = false;

	private gcStrings(): void {
		const now = Date.now();
		for (const [k, e] of this.strings) if (e.expiresAt <= now) this.strings.delete(k);
	}

	private reapZset(key: string, nowMs: number): void {
		const z = this.zsets.get(key);
		if (!z) return;
		for (const [m, score] of z) if (score <= nowMs) z.delete(m);
	}

	getZset(key: string): Map<string, number> {
		let z = this.zsets.get(key);
		if (!z) {
			z = new Map();
			this.zsets.set(key, z);
		}
		return z;
	}

	async set(key: string, value: string, _px: "PX", ms: number, _nx: "NX"): Promise<"OK" | null> {
		this.gcStrings();
		if (this.strings.has(key)) return null;
		this.strings.set(key, { value, expiresAt: Date.now() + ms });
		return "OK";
	}

	async eval(script: string, numKeys: number, ...args: string[]): Promise<unknown> {
		this.gcStrings();
		const keys = args.slice(0, numKeys);
		const argv = args.slice(numKeys);

		if (script.includes("ZREMRANGEBYSCORE") && script.includes("EXISTS")) {
			const [writerKey, readersKey] = keys as [string, string];
			const [token, nowStr, expireAtStr] = argv as [string, string, string];
			this.reapZset(readersKey, Number(nowStr));
			if (this.strings.has(writerKey)) return 0;
			this.getZset(readersKey).set(token, Number(expireAtStr));
			return 1;
		}
		if (script.includes("ZREM") && !script.includes("ZREMRANGEBYSCORE")) {
			const [readersKey] = keys as [string];
			const [token] = argv as [string];
			const z = this.zsets.get(readersKey);
			if (z?.has(token)) {
				z.delete(token);
				return 1;
			}
			return 0;
		}
		if (script.includes("ZSCORE")) {
			const [readersKey] = keys as [string];
			const [token, expireAtStr] = argv as [string, string];
			const z = this.zsets.get(readersKey);
			if (z?.has(token)) {
				z.set(token, Number(expireAtStr));
				return 1;
			}
			return 0;
		}
		if (script.includes("SET") && script.includes("NX")) {
			const [writerKey] = keys as [string];
			const [token, leaseMsStr] = argv as [string, string];
			if (this.strings.has(writerKey)) return null;
			this.strings.set(writerKey, { value: token, expiresAt: Date.now() + Number(leaseMsStr) });
			return "OK";
		}
		if (script.includes("ZCARD")) {
			const [writerKey, readersKey] = keys as [string, string];
			const [token, nowStr] = argv as [string, string];
			const entry = this.strings.get(writerKey);
			if (entry?.value !== token) return -1;
			this.reapZset(readersKey, Number(nowStr));
			return this.zsets.get(readersKey)?.size ?? 0;
		}
		if (script.includes("PEXPIRE")) {
			if (this.forceExclusiveRenewLost) return 0; // definitive loss
			const [writerKey] = keys as [string];
			const [token, leaseMsStr] = argv as [string, string];
			const entry = this.strings.get(writerKey);
			if (entry?.value === token) {
				entry.expiresAt = Date.now() + Number(leaseMsStr);
				return 1;
			}
			return 0;
		}
		if (script.includes("DEL")) {
			const [writerKey] = keys as [string];
			const [token] = argv as [string];
			const entry = this.strings.get(writerKey);
			if (entry?.value === token) {
				this.strings.delete(writerKey);
				return 1;
			}
			return 0;
		}
		throw new Error(`FakeRedis: unrecognised eval script: ${script.slice(0, 60)}`);
	}
}

function asRedis(f: FakeRedis): Redis {
	return f as unknown as Redis;
}

// ── Recording script-tx FS ──────────────────────────────────────────────────────
//
interface ScriptTxRecord {
	begins: number;
	ends: number;
	aborts: number;
}

function makeRecordingScriptTxFs(record: ScriptTxRecord): IFileSystem {
	const base = new InMemoryFs();
	let scopeActive = false;
	let committed = false; // set on endScope (commit), cleared on abortScope (rollback)

	const ext: Record<string, unknown> = {
		// ── IScriptTxFs ──
		beginScriptScope(): void {
			scopeActive = true;
			committed = false;
			record.begins++;
		},
		async endScriptScope(): Promise<void> {
			scopeActive = false;
			committed = true; // simulates COMMIT
			record.ends++;
		},
		async abortScriptScope(): Promise<void> {
			scopeActive = false;
			committed = false; // simulates ROLLBACK — no mutation survives
			record.aborts++;
		},
		get scriptScopeActive(): boolean {
			return scopeActive;
		},
		get scriptTxOpen(): boolean {
			return scopeActive;
		},
		// ── ICoherentFs ──
		async reload(): Promise<void> {},
		wasDirty(): boolean {
			return committed;
		},
		clearDirty(): void {
			committed = false;
		},
		poisoned(): boolean {
			return false;
		},
		async bulkIngest(): Promise<void> {},
	};

	return new Proxy(base, {
		get(target, prop, receiver) {
			if (prop in ext) {
				const v = ext[prop as string];
				return typeof v === "function" ? (v as () => unknown).bind(ext) : v;
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as unknown as IFileSystem;
}

const T = "default";

// Fast lock options so the heartbeat fires inside the test window.
const FAST_LOCK = { leaseMs: 5_000, renewMs: 60, acquireTimeoutMs: 3_000, acquireRetryMs: 10, readerLeaseMs: 5_000 };

describe("F2-L1: abort exec on definitive lease loss before commit", () => {
	it("keeps overlapping shared leases independent when one reader finishes before the other loses ownership", async () => {
		const redis = new FakeRedis();
		const sm = new SessionManager({
			createFs: async () => new InMemoryFs(),
			redis: asRedis(redis),
			execLockOptions: FAST_LOCK,
		});
		await sm.getOrCreate(T, "sbx-overlap");
		let finishFirst: () => void = () => {};
		const firstCanFinish = new Promise<void>((resolve) => {
			finishFirst = resolve;
		});
		let startedFirst: () => void = () => {};
		const firstStarted = new Promise<void>((resolve) => {
			startedFirst = resolve;
		});
		let firstSignal: AbortSignal | undefined;
		const first = sm.withSessionRead(T, "sbx-overlap", async () => {
			firstSignal = sessionLeaseSignal();
			startedFirst();
			await firstCanFinish;
			expect(sessionLeaseSignal()).toBe(firstSignal);
		});
		await firstStarted;
		let startedSecond: () => void = () => {};
		const secondStarted = new Promise<void>((resolve) => {
			startedSecond = resolve;
		});
		let firstFinished: () => void = () => {};
		const firstHasFinished = new Promise<void>((resolve) => {
			firstFinished = resolve;
		});
		const second = sm.withSessionRead(T, "sbx-overlap", async () => {
			const signal = sessionLeaseSignal();
			expect(signal).toBeDefined();
			expect(signal).not.toBe(firstSignal);
			const lost = new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			startedSecond();
			await firstHasFinished;
			expect(sessionLeaseSignal()).toBe(signal);
			expect(signal?.aborted).toBe(false);
			redis.getZset(rwLockKeys(T, "sbx-overlap").readers).clear();
			await lost;
			expect(sessionLeaseSignal()).toBe(signal);
			expect(sessionLeaseSignal()?.aborted).toBe(true);
			expect(firstSignal?.aborted).toBe(false);
		});
		const rejected = expect(second).rejects.toMatchObject({ code: "ELOCKLOST" });
		await secondStarted;
		finishFirst();
		await first;
		firstFinished();
		await rejected;
		expect(sessionLeaseSignal()).toBeUndefined();
		await sm.shutdown();
	});

	it("definitive loss mid-exec rolls back the script transaction with retryable ELOCKLOST", async () => {
		const redis = new FakeRedis();
		const record: ScriptTxRecord = { begins: 0, ends: 0, aborts: 0 };
		const sm = new SessionManager({
			createFs: () => Promise.resolve(makeRecordingScriptTxFs(record)),
			redis: asRedis(redis),
			execLockOptions: FAST_LOCK,
		});

		const err = await sm
			.withSession(T, "sbx-loss", async (session) => {
				// The lost-signal must be exposed to the exec path for this region.
				expect(sessionLeaseSignal()).toBeDefined();
				// Force the heartbeat's next renew to report a definitive loss, then
				// run a script slow enough that the abort interrupts it mid-flight.
				// The route layer composes lockLostSignal into the exec signal; mimic
				// that here so bash.exec actually observes the abort.
				redis.forceExclusiveRenewLost = true;
				return sm.execWithRuntimeThrottle(session, "for i in $(seq 1 50); do sleep 0.05; done; echo done", {
					signal: sessionLeaseSignal(),
				});
			})
			.then(
				() => undefined,
				(e) => e as Error,
			);

		// Surfaced error is the retryable LockLostError (NOT a committed-then-failed lie).
		expect(err).toBeDefined();
		expect((err as Error & { code?: string }).code).toBe("ELOCKLOST");

		// Script-tx opened then ROLLED BACK — never committed.
		expect(record.begins).toBe(1);
		expect(record.aborts).toBe(1);
		expect(record.ends).toBe(0);

		await sm.shutdown();
	});

	it("the lost-signal is cleared after the locked region (no leak into the next turn)", async () => {
		const redis = new FakeRedis();
		const record: ScriptTxRecord = { begins: 0, ends: 0, aborts: 0 };
		const sm = new SessionManager({
			createFs: () => Promise.resolve(makeRecordingScriptTxFs(record)),
			redis: asRedis(redis),
			execLockOptions: FAST_LOCK,
		});

		let captured: AbortSignal | undefined;
		await sm.withSession(T, "sbx-clear", async (session) => {
			captured = sessionLeaseSignal();
			expect(captured).toBeDefined();
			return sm.execWithRuntimeThrottle(session, "echo hi");
		});

		// After the region the field is cleared; the captured signal never aborted.
		expect(sessionLeaseSignal()).toBeUndefined();
		expect(captured?.aborted).toBe(false);

		await sm.shutdown();
	});

	it("a TRANSIENT renew blip does NOT abort the exec (only definitive loss does)", async () => {
		const redis = new FakeRedis();
		const record: ScriptTxRecord = { begins: 0, ends: 0, aborts: 0 };
		const sm = new SessionManager({
			createFs: () => Promise.resolve(makeRecordingScriptTxFs(record)),
			redis: asRedis(redis),
			execLockOptions: FAST_LOCK,
		});

		// Make the renew EVAL transiently throw for a window, then recover. The
		// heartbeat treats a thrown renew as "transient" (lease still valid) and
		// must NOT abort. Recovery before the lease expires keeps ownership.
		const origEval = redis.eval.bind(redis);
		let blips = 0;
		redis.eval = async (script: string, numKeys: number, ...args: string[]) => {
			if (script.includes("PEXPIRE") && blips < 1) {
				blips++;
				throw new Error("transient redis blip");
			}
			return origEval(script, numKeys, ...args);
		};

		const result = await sm.withSession(T, "sbx-transient", async (session) => {
			expect(sessionLeaseSignal()?.aborted).toBe(false);
			const r = await sm.execWithRuntimeThrottle(session, "for i in $(seq 1 6); do sleep 0.05; done; echo ok", {
				signal: sessionLeaseSignal(),
			});
			// Signal stayed un-aborted across the transient blip.
			expect(sessionLeaseSignal()?.aborted).toBe(false);
			return r;
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("ok");
		// Committed normally — no rollback.
		expect(record.ends).toBe(1);
		expect(record.aborts).toBe(0);

		await sm.shutdown();
	});
});
