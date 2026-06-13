/**
 * F2-L1 regression: a DEFINITIVE distributed-lock loss mid-exec must abort the
 * exec so its script-tx ROLLS BACK BEFORE any commit, surface the retryable
 * LockLostError, and NOT bump the version counter (no committed-then-lie).
 * A TRANSIENT renew blip must NOT abort the exec.
 *
 * No real Redis — the FakeRedis mirrors the RW lock's ZSET + string-key surface
 * (same shape as distributed-rw-lock.test.ts / session-manager.exec-lock.test.ts)
 * with a switch to force the exclusive RENEW to report definitive loss.
 */

import type { Redis } from "ioredis";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { describe, expect, it } from "vitest";
import { versionKey } from "../../../sql-fs/redis-path-snapshot.js";
import { SessionManager } from "../../session-manager.js";

// ── FakeRedis (ZSET-aware, with forced exclusive renew loss + version INCR) ─────

interface StringEntry {
	value: string;
	expiresAt: number;
}

class FakeRedis {
	strings = new Map<string, StringEntry>();
	zsets = new Map<string, Map<string, number>>();
	counters = new Map<string, number>();

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

	// Version-counter surface used by publishVersionIfDirty / ensureFreshCache.
	async incr(key: string): Promise<number> {
		const next = (this.counters.get(key) ?? 0) + 1;
		this.counters.set(key, next);
		return next;
	}
	async expire(_key: string, _seconds: number): Promise<number> {
		return 1;
	}
	async getex(key: string, _ex: "EX", _seconds: number): Promise<string | null> {
		const v = this.counters.get(key);
		return v === undefined ? null : String(v);
	}
	async del(key: string): Promise<number> {
		return this.counters.delete(key) ? 1 : 0;
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
// A Proxy over InMemoryFs (so bash.exec has a real filesystem to run against)
// that also satisfies IScriptTxFs + ICoherentFs and records begin/end/abort so we
// can assert the script-tx rolled back rather than committed. `wasDirty()` returns
// true only while a scope committed (endScope) and false after an abort — this is
// what publishVersionIfDirty consults to decide whether to INCR the version.

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
	it("definitive loss mid-exec → script-tx ROLLS BACK, no version INCR, retryable ELOCKLOST", async () => {
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
				expect(session.lockLostSignal).toBeDefined();
				// Force the heartbeat's next renew to report a definitive loss, then
				// run a script slow enough that the abort interrupts it mid-flight.
				// The route layer composes lockLostSignal into the exec signal; mimic
				// that here so bash.exec actually observes the abort.
				redis.forceExclusiveRenewLost = true;
				return sm.execWithRuntimeThrottle(session, "for i in $(seq 1 50); do sleep 0.05; done; echo done", {
					signal: session.lockLostSignal,
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

		// No version bump was published (the write did not commit).
		expect(redis.counters.get(versionKey(T, "sbx-loss")) ?? 0).toBe(0);

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
			captured = session.lockLostSignal;
			expect(captured).toBeDefined();
			return sm.execWithRuntimeThrottle(session, "echo hi");
		});

		// After the region the field is cleared; the captured signal never aborted.
		const after = sm.getSession(T, "sbx-clear");
		expect(after?.lockLostSignal).toBeUndefined();
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
			expect(session.lockLostSignal?.aborted).toBe(false);
			const r = await sm.execWithRuntimeThrottle(session, "for i in $(seq 1 6); do sleep 0.05; done; echo ok", {
				signal: session.lockLostSignal,
			});
			// Signal stayed un-aborted across the transient blip.
			expect(session.lockLostSignal?.aborted).toBe(false);
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
