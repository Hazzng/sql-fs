/**
 * #181: the test scaffolding must carry production's error contract, not a copy
 * of the leaky pre-#174 one. Guards both halves — that the shared handler still
 * redacts, and that no test file has quietly grown its own handler again.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { testErrorHandler } from "../helpers/error-handler.js";

const TESTS_DIR = fileURLToPath(new URL("../", import.meta.url));
const SELF = "test-app-error-shape.test.ts";

/** The line #174 deleted from production; re-adding it anywhere is the regression. */
const HAND_ROLLED_FALLBACK = '.code ?? "INTERNAL_ERROR"';

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listTsFiles(full));
		else if (entry.name.endsWith(".ts") && entry.name !== SELF) out.push(full);
	}
	return out;
}

function appThrowing(err: Error): Hono {
	const app = new Hono();
	app.get("/boom", () => {
		throw err;
	});
	app.onError(testErrorHandler);
	return app;
}

function errWithCode(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

describe("shared test-app error handler (#181)", () => {
	it("redacts a raw driver code so a test app cannot pass a leak that production blocks", async () => {
		const res = await appThrowing(errWithCode("ECONNRESET", "read ECONNRESET on 10.0.0.4:5432")).request("/boom");

		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({
			error: "Internal server error",
			code: "INTERNAL_ERROR",
			retryable: false,
		});
	});

	it("redacts a bare Postgres SQLSTATE to the synthetic capacity code", async () => {
		const res = await appThrowing(errWithCode("53300", "sorry, too many clients already")).request("/boom");

		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			error: "Internal server error",
			code: "EUNAVAILABLE",
			retryable: true,
		});
	});

	it("passes an allowlisted FS code and its message through unchanged", async () => {
		const res = await appThrowing(errWithCode("ENOENT", "ENOENT: no such file or directory, open '/a.txt'")).request(
			"/boom",
		);

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({
			error: "ENOENT: no such file or directory, open '/a.txt'",
			code: "ENOENT",
			retryable: false,
		});
	});

	it("finds no test file hand-rolling the pre-#174 error-code fallback", () => {
		const offenders = listTsFiles(TESTS_DIR)
			.filter((f) => readFileSync(f, "utf8").includes(HAND_ROLLED_FALLBACK))
			.map((f) => f.slice(TESTS_DIR.length));

		expect(offenders).toEqual([]);
	});
});
