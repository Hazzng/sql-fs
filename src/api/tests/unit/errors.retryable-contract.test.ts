/**
 * US-175 unit tests: the `retryable` durability discriminator.
 *
 * Six codes share HTTP 503 and they disagree about whether the request's
 * effects landed. `retryable` is the field that tells them apart, so a client
 * never has to enumerate codes to learn that retrying an ECOHERENCE exec
 * re-applies an already-committed write.
 */

import { describe, expect, it, vi } from "vitest";
import { isRetryableError, mapFsErrorToStatus } from "../../errors.js";
import { app } from "../../server.js";

function errWithCode(code: string, message = "boom"): Error {
	return Object.assign(new Error(message), { code });
}

describe("isRetryableError", () => {
	it.each(["ELOCKTIMEOUT", "ELOCKLOST", "ECOHERENCE_UNAPPLIED", "ESESSIONCLOSING", "ESHUTTINGDOWN", "ERUNTIME_BUSY"])(
		"reports %s as retryable — the request applied nothing",
		(code) => {
			expect(isRetryableError(errWithCode(code))).toBe(true);
		},
	);

	it("reports ECOHERENCE as NOT retryable — the write committed", () => {
		expect(isRetryableError(errWithCode("ECOHERENCE"))).toBe(false);
	});

	it.each(["53300", "53400", "57P03"])("reports capacity SQLSTATE %s as retryable", (sqlstate) => {
		expect(isRetryableError(errWithCode(sqlstate))).toBe(true);
	});

	it.each(["08000", "08003", "08006", "08P01"])(
		"reports connection-exception SQLSTATE %s as NOT retryable — a COMMIT lost mid-flight is in doubt",
		(sqlstate) => {
			expect(isRetryableError(errWithCode(sqlstate))).toBe(false);
		},
	);

	// Negative guards below: `false` is the default, so these pass on the
	// pre-#175 code too. They exist to catch a future over-broad allowlist, not
	// to prove this change.
	it("reports a client error as not retryable", () => {
		expect(isRetryableError(errWithCode("ENOENT"))).toBe(false);
	});

	it("reports an unknown code as not retryable", () => {
		expect(isRetryableError(errWithCode("ECONNRESET"))).toBe(false);
	});

	it("reports an error carrying no code as not retryable", () => {
		expect(isRetryableError(new Error("boom"))).toBe(false);
	});

	it("reports a non-Error throwable as not retryable", () => {
		expect(isRetryableError({ code: "ELOCKLOST" })).toBe(false);
	});
});

describe("mapFsErrorToStatus — coherence codes", () => {
	// Regression guard: ECOHERENCE already mapped to 503 before #175. Pinned here
	// so the split cannot silently demote the applied case to a 500.
	it("maps ECOHERENCE to 503", () => {
		expect(mapFsErrorToStatus(errWithCode("ECOHERENCE"))).toBe(503);
	});

	it("maps ECOHERENCE_UNAPPLIED to 503", () => {
		expect(mapFsErrorToStatus(errWithCode("ECOHERENCE_UNAPPLIED"))).toBe(503);
	});
});

// Exercises the real `app.onError` in server.ts via a throwing probe route
// (auth only covers /v1/*). Mirrors errors.client-safe-code.test.ts.
let probeError: unknown = new Error("unset");
app.get("/__test/retryable-probe", (): never => {
	throw probeError;
});

describe("app.onError — retryable field", () => {
	async function probe(err: unknown): Promise<{ status: number; body: unknown }> {
		probeError = err;
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const res = await app.request("/__test/retryable-probe");
			return { status: res.status, body: await res.json() };
		} finally {
			logSpy.mockRestore();
		}
	}

	it("marks a 503 ECOHERENCE not retryable and never tells the client to retry", async () => {
		const message =
			"ECOHERENCE: write committed but cross-replica version publish failed; the write IS applied — do not blindly retry";
		expect(await probe(errWithCode("ECOHERENCE", message))).toEqual({
			status: 503,
			body: { error: message, code: "ECOHERENCE", retryable: false },
		});
	});

	it("marks a 503 ECOHERENCE_UNAPPLIED retryable", async () => {
		const message = "ECOHERENCE_UNAPPLIED: cache poisoned by failed reload; nothing was applied, retry is safe";
		expect(await probe(errWithCode("ECOHERENCE_UNAPPLIED", message))).toEqual({
			status: 503,
			body: { error: message, code: "ECOHERENCE_UNAPPLIED", retryable: true },
		});
	});

	it("marks a 503 ELOCKLOST retryable, distinguishing it from ECOHERENCE at the same status", async () => {
		expect(await probe(errWithCode("ELOCKLOST", "ELOCKLOST: exec lock lease lost"))).toEqual({
			status: 503,
			body: { error: "ELOCKLOST: exec lock lease lost", code: "ELOCKLOST", retryable: true },
		});
	});
});
