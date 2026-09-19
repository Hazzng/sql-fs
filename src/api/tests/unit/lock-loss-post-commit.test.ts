/**
 * #175 M1: a lease lost AFTER the guarded work returned must not be advertised
 * retryable.
 *
 * `withDistributedLock` wraps `getOrCreate` + `withSessionEntry`, so a
 * successful `fn` return means the script transaction already COMMITted and
 * `publishVersionIfDirty` already ran. The F2-L1 pre-commit guard closes the
 * common case by keying off `lockLostSignal` before `endScope`, but `markLost()`
 * fires from a heartbeat tick and can land during the COMMIT itself or the
 * Redis INCR after it. Surfacing the retryable `ELOCKLOST` there tells an
 * auto-retrying client to re-apply a durable `echo L >> /counter.txt`.
 */

import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockLostAfterCommitError, LockLostError, execLockKey, withDistributedLock } from "../../distributed-lock.js";
import { type RWLockKeys, rwLockKeys, withDistributedRWLock } from "../../distributed-rw-lock.js";
import { isRetryableError } from "../../errors.js";

/**
 * Redis fake that grants every acquire and then reports the lease as lost on
 * the first renew — the shape of a heartbeat tick landing during the COMMIT.
 */
class LosingRedis {
	async set(): Promise<"OK"> {
		return "OK";
	}
	async eval(script: string): Promise<number | string | null> {
		// Acquires: writer flag (SET ... NX) and shared ZADD both succeed.
		if (script.includes('"SET"')) return "OK";
		if (script.includes("ZADD") && script.includes("ZREMRANGEBYSCORE")) return 1;
		// Readers-drained probe: flag still ours, zero readers.
		if (script.includes("ZCARD")) return 0;
		// Releases succeed; every renew reports "not yours any more".
		if (script.includes("DEL") || script.includes("del") || script.includes("ZREM")) return 1;
		return 0;
	}
	get client(): Redis {
		return this as unknown as Redis;
	}
}

const KEY = execLockKey("default", "sbx-post-commit");
const KEYS: RWLockKeys = rwLockKeys("default", "sbx-post-commit");
const FAST = { leaseMs: 5_000, renewMs: 20, acquireTimeoutMs: 2_000, acquireRetryMs: 10 } as const;
const FAST_RW = { ...FAST, readerLeaseMs: 5_000 } as const;

/** Long enough for at least one renew tick to mark the lease lost. */
const slowSuccess = async (): Promise<string> => {
	await new Promise((res) => setTimeout(res, 80));
	return "committed";
};

function codeOf(err: unknown): string | undefined {
	return (err as Error & { code?: string }).code;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("lease lost after the guarded work completed", () => {
	it("withDistributedLock throws the non-retryable ELOCKLOST_APPLIED", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const err = await withDistributedLock(new LosingRedis().client, KEY, slowSuccess, FAST).catch((e) => e);
		expect(err).toBeInstanceOf(LockLostAfterCommitError);
		expect(codeOf(err)).toBe("ELOCKLOST_APPLIED");
		expect(isRetryableError(err)).toBe(false);
	});

	it("logs lock_lost_post_commit at critical on the write path", async () => {
		const errLog = vi.spyOn(console, "error").mockImplementation(() => {});
		await withDistributedLock(new LosingRedis().client, KEY, slowSuccess, FAST).catch(() => undefined);
		const events = errLog.mock.calls
			.map((c) => JSON.parse(c[0] as string) as Record<string, unknown>)
			.filter((e) => e.event === "lock_lost_post_commit");
		expect(events).toEqual([{ event: "lock_lost_post_commit", key: KEY, readOnly: false, severity: "critical" }]);
	});

	it("keeps the retryable ELOCKLOST on a read-only holder of the legacy lock", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const err = await withDistributedLock(new LosingRedis().client, KEY, slowSuccess, {
			...FAST,
			readOnly: true,
		}).catch((e) => e);
		expect(err).toBeInstanceOf(LockLostError);
		expect(codeOf(err)).toBe("ELOCKLOST");
		expect(isRetryableError(err)).toBe(true);
	});

	it("keeps the retryable ELOCKLOST when fn threw instead of returning (pre-commit abort)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const err = await withDistributedLock(
			new LosingRedis().client,
			KEY,
			async () => {
				await new Promise((res) => setTimeout(res, 80));
				throw new Error("aborted mid-script");
			},
			FAST,
		).catch((e) => e);
		expect(err).toBeInstanceOf(LockLostError);
		expect(codeOf(err)).toBe("ELOCKLOST");
		expect(isRetryableError(err)).toBe(true);
	});

	it("rw-lock exclusive throws the non-retryable ELOCKLOST_APPLIED", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const err = await withDistributedRWLock(new LosingRedis().client, KEYS, "exclusive", slowSuccess, FAST_RW).catch(
			(e) => e,
		);
		expect(err).toBeInstanceOf(LockLostAfterCommitError);
		expect(codeOf(err)).toBe("ELOCKLOST_APPLIED");
		expect(isRetryableError(err)).toBe(false);
	});

	it("rw-lock shared keeps the retryable ELOCKLOST — a reader commits nothing", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const err = await withDistributedRWLock(new LosingRedis().client, KEYS, "shared", slowSuccess, FAST_RW).catch(
			(e) => e,
		);
		expect(err).toBeInstanceOf(LockLostError);
		expect(codeOf(err)).toBe("ELOCKLOST");
		expect(isRetryableError(err)).toBe(true);
	});
});
