/**
 * Integration test for bulk-write (`writeFiles`) atomicity (audit H10).
 *
 * Exercises the REAL Postgres-backed SqlFs script-tx path (the unit tests use
 * InMemoryFs, which has no script-tx and takes the non-atomic fallback). A
 * mid-batch failure must roll back the ENTIRE batch — earlier files in the same
 * request must NOT persist.
 *
 * Skipped when DATABASE_URL is not set.
 */

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../../sql-fs/dialects/postgres.js";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { clientSafeErrorMessage, mapFsErrorToStatus } from "../../errors.js";
import { fileRoutes } from "../../routes/files.js";
import { sandboxRoutes } from "../../routes/sandboxes.js";
import { SessionManager } from "../../session-manager.js";

const AUTH_SECRET = "test-secret-writefiles-atomicity-at-least-32b!";
const secretBytes = new TextEncoder().encode(AUTH_SECRET);
const OWNER = "wf-atomicity-owner";

async function token(): Promise<string> {
	return new SignJWT({ sub: OWNER }).setProtectedHeader({ alg: "HS256" }).sign(secretBytes);
}

describe.skipIf(!process.env.DATABASE_URL)("writeFiles atomicity (H10, real Postgres)", () => {
	// Per-test dialect: SqlFs.disconnect() (triggered by session teardown) closes
	// the dialect, so a shared one would be torn down by the first test.
	let dialect: PostgresDialect;
	let sessionManager: SessionManager;
	let app: Hono<{ Variables: AuthVariables }>;

	afterEach(async () => {
		await sessionManager?.shutdown().catch(() => {});
		await dialect?.disconnect().catch(() => {});
	});

	beforeEach(async () => {
		process.env.AUTH_SECRET = AUTH_SECRET;
		dialect = new PostgresDialect(process.env.DATABASE_URL!);
		await dialect.connect();
		sessionManager = new SessionManager({
			createFs: async (_tenantId: string, sandboxId: string) => {
				// Each sandbox gets its own SqlFs (script-tx capable) over this dialect.
				const { SqlFs } = await import("../../../sql-fs/sql-fs.js");
				const fs = new SqlFs({ dialect, sandboxId, allowSymlinks: false });
				await dialect.transaction((tx) => dialect.createSandbox(tx, sandboxId, OWNER));
				await fs.ready();
				return fs;
			},
		});
		app = new Hono<{ Variables: AuthVariables }>();
		app.use("/v1/*", authMiddleware);
		app.route("/v1/sandboxes", sandboxRoutes(sessionManager));
		app.route("/v1/sandboxes", fileRoutes(sessionManager));
		// Mirror the production error handler so FS errors map to their status
		// (e.g. EISDIR → 400) instead of a generic 500.
		app.onError((err, c) => {
			const code = (err as Error & { code?: string }).code ?? "INTERNAL_ERROR";
			return c.json({ error: clientSafeErrorMessage(err), code }, mapFsErrorToStatus(err) as ContentfulStatusCode);
		});
	});

	it("rolls back the whole batch when one entry fails mid-write (no partial persist)", async () => {
		const t = await token();
		const id = `wf-atomic-${Date.now()}`;
		const auth = { Authorization: `Bearer ${t}` };

		// Seed the session + make /blocker a directory so a later write over it fails.
		await sessionManager.getOrCreate("default", id, undefined, OWNER);
		const mk = await app.request(`/v1/sandboxes/${id}/mkdir`, {
			method: "POST",
			headers: { ...auth, "Content-Type": "application/json" },
			body: JSON.stringify({ path: "/blocker" }),
		});
		expect(mk.status).toBe(204);

		// Batch: first.txt (ok) → blocker (EISDIR: write over a dir) → third.txt (ok).
		const res = await app.request(`/v1/sandboxes/${id}/writeFiles`, {
			method: "POST",
			headers: { ...auth, "Content-Type": "application/json" },
			body: JSON.stringify({ files: { "first.txt": "A", blocker: "X", "third.txt": "C" } }),
		});
		// The mid-batch EISDIR surfaces as a 4xx (EISDIR → 400).
		expect(res.status).toBe(400);

		// ATOMICITY: neither sibling must have persisted.
		const first = await app.request(`/v1/sandboxes/${id}/files/first.txt`, { headers: auth });
		const third = await app.request(`/v1/sandboxes/${id}/files/third.txt`, { headers: auth });
		expect(first.status).toBe(404);
		expect(third.status).toBe(404);

		// And the DB itself must not contain the rolled-back file (no cache illusion).
		const rows = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, id);
			return tx<{ name: string }[]>`SELECT name FROM dirents WHERE sandbox_id = ${id} AND name = 'first.txt'`;
		});
		expect(rows.length).toBe(0);
	});

	it("commits the whole batch when all entries succeed", async () => {
		const t = await token();
		const id = `wf-ok-${Date.now()}`;
		const auth = { Authorization: `Bearer ${t}` };
		await sessionManager.getOrCreate("default", id, undefined, OWNER);

		const res = await app.request(`/v1/sandboxes/${id}/writeFiles`, {
			method: "POST",
			headers: { ...auth, "Content-Type": "application/json" },
			body: JSON.stringify({ files: { "a.txt": "A", "dir/b.txt": "B" } }),
		});
		expect(res.status).toBe(204);
		expect((await app.request(`/v1/sandboxes/${id}/files/a.txt`, { headers: auth })).status).toBe(200);
		expect((await app.request(`/v1/sandboxes/${id}/files/dir/b.txt`, { headers: auth })).status).toBe(200);
	});
});
