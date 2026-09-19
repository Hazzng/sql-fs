/**
 * Unit tests for client-safe error code filtering.
 * US-174: onError leaks raw driver and SQLSTATE codes to clients
 */

import { describe, expect, it, vi } from "vitest";
import { clientSafeErrorCode, mapFsErrorToStatus } from "../../errors.js";
import { app } from "../../server.js";

function errWithCode(code: string, message = "boom"): Error {
	return Object.assign(new Error(message), { code });
}

describe("clientSafeErrorCode", () => {
	it("returns an allowlisted FS code unchanged", () => {
		expect(clientSafeErrorCode(errWithCode("ENOENT"))).toBe("ENOENT");
	});

	it("replaces a raw driver code with INTERNAL_ERROR", () => {
		expect(clientSafeErrorCode(errWithCode("ECONNRESET"))).toBe("INTERNAL_ERROR");
	});

	it("replaces a driver-internal code with INTERNAL_ERROR", () => {
		expect(clientSafeErrorCode(errWithCode("CONNECTION_CLOSED"))).toBe("INTERNAL_ERROR");
	});

	it("replaces a non-connection SQLSTATE with INTERNAL_ERROR", () => {
		expect(clientSafeErrorCode(errWithCode("23503"))).toBe("INTERNAL_ERROR");
	});

	it("returns INTERNAL_ERROR for an error carrying no code", () => {
		expect(clientSafeErrorCode(new Error("boom"))).toBe("INTERNAL_ERROR");
	});

	it("returns INTERNAL_ERROR for a non-Error throwable", () => {
		expect(clientSafeErrorCode({ code: "ECONNRESET" })).toBe("INTERNAL_ERROR");
	});

	it("honours an explicit fallback", () => {
		expect(clientSafeErrorCode(errWithCode("ECONNRESET"), "UNKNOWN")).toBe("UNKNOWN");
	});

	it.each(["53300", "53400", "57P03", "08000", "08003", "08006", "08P01"])(
		"maps connection-class SQLSTATE %s to EUNAVAILABLE",
		(sqlstate) => {
			expect(clientSafeErrorCode(errWithCode(sqlstate))).toBe("EUNAVAILABLE");
		},
	);
});

describe("mapFsErrorToStatus — connection-class SQLSTATEs", () => {
	it.each(["53300", "53400", "57P03", "08000", "08003", "08006", "08P01"])(
		"returns 503 for SQLSTATE %s",
		(sqlstate) => {
			expect(mapFsErrorToStatus(errWithCode(sqlstate))).toBe(503);
		},
	);

	it("returns 500 for an unrecognised SQLSTATE", () => {
		expect(mapFsErrorToStatus(errWithCode("23503"))).toBe(500);
	});

	it("returns 500 for a raw driver code", () => {
		expect(mapFsErrorToStatus(errWithCode("ECONNRESET"))).toBe(500);
	});
});

// Exercises the real `app.onError` in server.ts. Hono has no way to invoke the
// handler directly, so a throwing probe route is registered on the imported app
// (unauthenticated: auth only covers /v1/*). The route exists only in this test
// process.
let probeError: unknown = new Error("unset");
app.get("/__test/onerror-probe", (): never => {
	throw probeError;
});

describe("app.onError", () => {
	async function probe(err: unknown): Promise<{ status: number; body: unknown }> {
		probeError = err;
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const res = await app.request("/__test/onerror-probe");
			return { status: res.status, body: await res.json() };
		} finally {
			logSpy.mockRestore();
		}
	}

	it("does not echo a raw driver code", async () => {
		expect(await probe(errWithCode("ECONNRESET", "read ECONNRESET"))).toEqual({
			status: 500,
			body: { error: "Internal server error", code: "INTERNAL_ERROR" },
		});
	});

	it("does not echo a raw SQLSTATE", async () => {
		expect(await probe(errWithCode("23503", "insert or update on table violates foreign key"))).toEqual({
			status: 500,
			body: { error: "Internal server error", code: "INTERNAL_ERROR" },
		});
	});

	it("returns a retryable 503 with EUNAVAILABLE for too_many_connections", async () => {
		expect(await probe(errWithCode("53300", "sorry, too many clients already"))).toEqual({
			status: 503,
			body: { error: "Internal server error", code: "EUNAVAILABLE" },
		});
	});

	it("still surfaces an allowlisted FS code and message", async () => {
		expect(await probe(errWithCode("ENOENT", "ENOENT: no such file or directory, '/a.txt'"))).toEqual({
			status: 404,
			body: { error: "ENOENT: no such file or directory, '/a.txt'", code: "ENOENT" },
		});
	});
});
