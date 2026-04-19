/**
 * Unit tests for the JWT/HMAC auth middleware.
 * US-057: JWT/HMAC auth middleware
 */

import { Hono } from "hono";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthVariables, authMiddleware } from "../auth.js";

const SECRET = "test-secret-at-least-32-bytes-long!!";
const secretBytes = new TextEncoder().encode(SECRET);

function makeApp() {
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", authMiddleware);
	app.get("/v1/ping", (c) => c.json({ owner: c.get("owner") }));
	return app;
}

async function makeValidToken(sub = "agent-1"): Promise<string> {
	return new SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).sign(secretBytes);
}

async function makeExpiredToken(): Promise<string> {
	return new SignJWT({ sub: "agent-1" })
		.setProtectedHeader({ alg: "HS256" })
		.setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
		.sign(secretBytes);
}

describe("authMiddleware", () => {
	let savedSecret: string | undefined;

	beforeEach(() => {
		savedSecret = process.env.AUTH_SECRET;
		process.env.AUTH_SECRET = SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = savedSecret ?? "";
	});

	it("valid token passes with correct sub extracted", async () => {
		const app = makeApp();
		const token = await makeValidToken("my-agent");
		const res = await app.request("/v1/ping", {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { owner: string };
		expect(body.owner).toBe("my-agent");
	});

	it("expired token returns 401", async () => {
		const app = makeApp();
		const token = await makeExpiredToken();
		const res = await app.request("/v1/ping", {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("AUTH_INVALID");
	});

	it("tampered token returns 401", async () => {
		const app = makeApp();
		const token = await makeValidToken();
		// Corrupt the signature portion (last segment of the JWT)
		const parts = token.split(".");
		parts[2] = `${parts[2]?.slice(0, -4)}XXXX`;
		const tampered = parts.join(".");
		const res = await app.request("/v1/ping", {
			headers: { Authorization: `Bearer ${tampered}` },
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("AUTH_INVALID");
	});

	it("missing Authorization header returns 401", async () => {
		const app = makeApp();
		const res = await app.request("/v1/ping");
		expect(res.status).toBe(401);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("AUTH_REQUIRED");
	});
});
