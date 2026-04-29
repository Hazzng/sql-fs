/**
 * Unit tests for signToken / verifyToken.
 */

import { describe, expect, it } from "vitest";
import { signToken, verifyToken } from "./jwt.js";

const SECRET = "test-secret-for-jwt-round-trip-at-least-32b";

describe("signToken / verifyToken", () => {
	it("round-trips the sub claim", async () => {
		const token = await signToken({ sub: "agent-1", secret: SECRET });
		const payload = await verifyToken({ token, secret: SECRET });
		expect(payload.sub).toBe("agent-1");
		expect(payload.tenant).toBeUndefined();
	});

	it("round-trips the tenant claim when provided", async () => {
		const token = await signToken({ sub: "agent-1", tenant: "tenant-a", secret: SECRET });
		const payload = await verifyToken({ token, secret: SECRET });
		expect(payload.sub).toBe("agent-1");
		expect(payload.tenant).toBe("tenant-a");
	});

	it("does not include tenant claim when undefined", async () => {
		const token = await signToken({ sub: "agent-1", secret: SECRET });
		// Decode the JWT body and confirm no `tenant` key is emitted.
		const body = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<
			string,
			unknown
		>;
		expect(body.sub).toBe("agent-1");
		expect("tenant" in body).toBe(false);
	});

	it("respects expiresIn and includes exp claim", async () => {
		const token = await signToken({ sub: "agent-1", expiresIn: "24h", secret: SECRET });
		const payload = await verifyToken({ token, secret: SECRET });
		expect(typeof payload.exp).toBe("number");
	});

	it("emits no exp when expiresIn is undefined or 'never'", async () => {
		const tokenNone = await signToken({ sub: "a", secret: SECRET });
		const tokenNever = await signToken({ sub: "a", expiresIn: "never", secret: SECRET });
		const payloadNone = await verifyToken({ token: tokenNone, secret: SECRET });
		const payloadNever = await verifyToken({ token: tokenNever, secret: SECRET });
		expect(payloadNone.exp).toBeUndefined();
		expect(payloadNever.exp).toBeUndefined();
	});

	it("includes jti claim when provided", async () => {
		const token = await signToken({ sub: "agent-1", jti: "abc-123", secret: SECRET });
		const body = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<
			string,
			unknown
		>;
		expect(body.jti).toBe("abc-123");
	});

	it("omits jti claim when not provided", async () => {
		const token = await signToken({ sub: "agent-1", secret: SECRET });
		const body = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<
			string,
			unknown
		>;
		expect("jti" in body).toBe(false);
	});
});
