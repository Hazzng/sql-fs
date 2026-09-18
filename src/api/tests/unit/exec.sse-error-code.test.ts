/**
 * Unit tests for the SSE error frame's error code.
 * US-174: onError leaks raw driver and SQLSTATE codes to clients
 */

import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { execRoutes } from "../../routes/exec.js";
import { SessionManager } from "../../session-manager.js";

const AUTH_SECRET = "test-secret-for-exec-tests-at-least-32bytes!";
const SANDBOX_ID = "test-exec-sse-error-code";
const secretBytes = new TextEncoder().encode(AUTH_SECRET);

async function makeToken(): Promise<string> {
	return new SignJWT({ sub: "agent-1" }).setProtectedHeader({ alg: "HS256" }).sign(secretBytes);
}

function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
	const events: Array<{ event: string; data: unknown }> = [];
	for (const block of body.split("\n\n").filter((b) => b.trim())) {
		let event = "message";
		let data = "";
		for (const line of block.split("\n")) {
			if (line.startsWith("event: ")) event = line.slice(7).trim();
			if (line.startsWith("data: ")) data = line.slice(6).trim();
		}
		if (data) events.push({ event, data: JSON.parse(data) });
	}
	return events;
}

/** Runs an exec whose underlying bash.exec rejects with `err`; returns the SSE error frame. */
async function execFailingWith(err: Error, sandboxId: string): Promise<unknown> {
	const sessionManager = new SessionManager({ createFs: async () => new InMemoryFs() });
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", authMiddleware);
	app.route("/v1/sandboxes", execRoutes(sessionManager));

	const session = await sessionManager.getOrCreate("default", sandboxId, undefined, "agent-1");
	vi.spyOn(session.bash, "exec").mockRejectedValue(err);
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

	try {
		const res = await app.request(`/v1/sandboxes/${sandboxId}/exec`, {
			method: "POST",
			headers: { Authorization: `Bearer ${await makeToken()}`, "Content-Type": "application/json" },
			body: JSON.stringify({ script: "echo hi" }),
		});
		const events = parseSseEvents(await res.text());
		return events.find((e) => e.event === "error")?.data;
	} finally {
		errorSpy.mockRestore();
		vi.restoreAllMocks();
	}
}

describe("POST /v1/sandboxes/:id/exec — SSE error frame", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("does not echo a raw driver code", async () => {
		const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
		expect(await execFailingWith(err, `${SANDBOX_ID}-driver`)).toEqual({
			t: "error",
			code: "INTERNAL_ERROR",
			error: "internal error",
		});
	});

	it("does not echo a raw SQLSTATE", async () => {
		const err = Object.assign(new Error("violates foreign key constraint"), { code: "23503" });
		expect(await execFailingWith(err, `${SANDBOX_ID}-sqlstate`)).toEqual({
			t: "error",
			code: "INTERNAL_ERROR",
			error: "internal error",
		});
	});

	it("reports a connection-class SQLSTATE as EUNAVAILABLE", async () => {
		const err = Object.assign(new Error("sorry, too many clients already"), { code: "53300" });
		expect(await execFailingWith(err, `${SANDBOX_ID}-capacity`)).toEqual({
			t: "error",
			code: "EUNAVAILABLE",
			error: "internal error",
		});
	});

	it("still surfaces an allowlisted FS code", async () => {
		const err = Object.assign(new Error("ELOCKLOST: exec lock lease lost"), { code: "ELOCKLOST" });
		expect(await execFailingWith(err, `${SANDBOX_ID}-allowlisted`)).toEqual({
			t: "error",
			code: "ELOCKLOST",
			error: "ELOCKLOST: exec lock lease lost",
		});
	});
});
