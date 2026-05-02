/**
 * Ordering-dependent concurrency scenarios.
 *
 * Each scenario has two possible execution orders (A-first or B-first), determined
 * by whichever operation wins the per-sandbox mutex.  The test fires both operations
 * concurrently and asserts that whichever ordering occurred, the final state is
 * fully consistent — no corruption, no phantom reads, no stale cache.
 *
 * The four scenarios under test:
 *   S1 — mkdir /a  ||  writeFile /a/x.txt  (parent-creation race)
 *   S2 — rm /a/file.txt  ||  readFile /a/file.txt  (delete-read race)
 *   S3 — writeFile "A"  ||  writeFile "B"  (last-write-wins)
 *   S4 — mv /a→/b  ||  writeFile /a/x.txt  (rename-then-write race)
 *
 * S1–S3 are tested at two layers:
 *   - HTTP API   (PUT / DELETE / GET routes, which auto-create parent dirs on write)
 *   - Raw fs     (session.fs.* calls via sm.withSession, no auto-mkdir safety net)
 *
 * S4 is tested at the raw-fs layer because no HTTP mv endpoint exists.
 *
 * Uses InMemoryFs — no DB required.
 */

import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthVariables, createAuthMiddleware } from "../../auth.js";
import { fileRoutes } from "../../routes/files.js";
import { SessionManager } from "../../session-manager.js";
import { stubTenantConfig } from "../helpers/tenant.js";

// ── Infrastructure ────────────────────────────────────────────────────────────

const AUTH_SECRET = "test-secret-ordering-at-least-32bytes!!";
const secretBytes = new TextEncoder().encode(AUTH_SECRET);

async function makeToken(): Promise<string> {
	return new SignJWT({ sub: "tester" }).setProtectedHeader({ alg: "HS256" }).sign(secretBytes);
}

function makeEnv(): {
	app: Hono<{ Variables: AuthVariables }>;
	sm: SessionManager;
} {
	const sm = new SessionManager({ createFs: async () => new InMemoryFs() });
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", createAuthMiddleware(stubTenantConfig()));
	app.route("/v1/sandboxes", fileRoutes(sm));
	return { app, sm };
}

/**
 * Extract the FS error code from either a SqlFs error (.code property) or an
 * InMemoryFs error (code is the first word of the message: "ENOENT: ...").
 * Falls back to "UNKNOWN" if neither matches.
 */
function errCode(e: unknown): string {
	if (!(e instanceof Error)) return "UNKNOWN";
	const fe = e as Error & { code?: string };
	if (fe.code) return fe.code;
	const m = fe.message.match(/^([A-Z]+):/);
	return m?.[1] ?? "UNKNOWN";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Read all paths under a prefix from the tree endpoint. */
async function treePaths(
	app: Hono<{ Variables: AuthVariables }>,
	sbId: string,
	prefix: string,
	token: string,
): Promise<string[]> {
	const res = await app.request(`/v1/sandboxes/${sbId}/tree?prefix=${prefix}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	type Entry = { path: string };
	return ((await res.json()) as Entry[]).map((e) => e.path);
}

// ── S1 — mkdir /a  ||  writeFile /a/x.txt ────────────────────────────────────
// Possible orderings:
//   A-first (mkdir wins): mkdir 204, write 204 → /a and /a/x.txt both exist
//   B-first (write wins):
//     HTTP layer  → PUT auto-creates /a, so write still 204 → same as A-first
//     Raw fs layer → write fails ENOENT, mkdir 204 → /a exists, /a/x.txt absent

describe("S1 — concurrent mkdir /a and writeFile /a/x.txt", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});
	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("HTTP API: PUT auto-creates parents — both orderings always succeed", async () => {
		// The HTTP PUT route calls mkdir(parent, {recursive:true}) before writeFile.
		// So even if the write mutex-slot runs before mkdir, the route creates /a itself.
		const { app, sm } = makeEnv();
		const token = await makeToken();

		for (const sbId of ["s1-http-mkdir-first", "s1-http-write-first"]) {
			await sm.getOrCreate("default", sbId);
			const [mkRes, wRes] = await Promise.all([
				app.request(`/v1/sandboxes/${sbId}/mkdir`, {
					method: "POST",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
					body: JSON.stringify({ path: "/a" }),
				}),
				app.request(`/v1/sandboxes/${sbId}/files/a/x.txt`, {
					method: "PUT",
					headers: { Authorization: `Bearer ${token}` },
					body: "content",
				}),
			]);

			// mkdir may return 204 or 409 (EEXIST) if the PUT created /a first
			expect([204, 409], `mkdir status for ${sbId}`).toContain(mkRes.status);
			expect(wRes.status, `write status for ${sbId}`).toBe(204);

			const paths = await treePaths(app, sbId, "/a", token);
			expect(paths).toContain("/a/x.txt");
		}
	});

	it("raw fs: InMemoryFs auto-creates parents, both orderings produce consistent final state", async () => {
		// NOTE: InMemoryFs.writeFile silently creates missing parent dirs (unlike SqlFs which
		// throws ENOENT on a missing parent).  That means write to /a/x.txt ALWAYS succeeds
		// here regardless of ordering.  The consistency guarantee is what we verify:
		// whichever ran first, /a and /a/x.txt must both exist afterwards.
		const { sm } = makeEnv();

		// ── Ordering A: mkdir first ──
		const sbA = "s1-raw-mkdir-first";
		const [mkA, wA] = await Promise.all([
			sm.withSession("default", sbA, (s) =>
				s.fs
					.mkdir("/a")
					.then(() => "ok")
					.catch(errCode),
			),
			sm.withSession("default", sbA, (s) =>
				s.fs
					.writeFile("/a/x.txt", "hi")
					.then(() => "ok")
					.catch(errCode),
			),
		]);
		expect(mkA).toBe("ok"); // mkdir wins first slot
		expect(wA).toBe("ok"); // write succeeds — parent exists
		expect(await sm.withSession("default", sbA, (s) => s.fs.exists("/a/x.txt"))).toBe(true);

		// ── Ordering B: write first ──
		const sbB = "s1-raw-write-first";
		const [wB, mkB] = await Promise.all([
			sm.withSession("default", sbB, (s) =>
				s.fs
					.writeFile("/a/x.txt", "hi")
					.then(() => "ok")
					.catch(errCode),
			),
			sm.withSession("default", sbB, (s) =>
				s.fs
					.mkdir("/a")
					.then(() => "ok")
					.catch(errCode),
			),
		]);
		expect(wB).toBe("ok"); // InMemoryFs auto-created /a; write succeeds
		// mkdir may return ok or EEXIST (InMemoryFs created /a for the write already)
		expect(["ok", "EEXIST"]).toContain(mkB);
		// Consistency: /a and /a/x.txt both exist regardless of ordering
		expect(await sm.withSession("default", sbB, (s) => s.fs.exists("/a"))).toBe(true);
		expect(await sm.withSession("default", sbB, (s) => s.fs.exists("/a/x.txt"))).toBe(true);
	});
});

// ── S2 — rm /a/file.txt  ||  readFile /a/file.txt ────────────────────────────
// Possible orderings:
//   A-first (delete wins): delete 204, read 404  → file gone
//   B-first (read wins):   read 200, delete 204  → file gone

describe("S2 — concurrent delete and read of the same file", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});
	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("HTTP API: concurrent delete + read — delete always 204, final state file-absent", async () => {
		const { app, sm } = makeEnv();
		const token = await makeToken();

		// Same as S3: Promise.all does not order which request hits the per-sandbox mutex first.
		// We only fix client-side array order ([DELETE, GET] vs [GET, DELETE]) and assert all
		// admissible (first, second) pairs, then a definitive final read.
		for (const [sbId, delFirstInArray] of [
			["s2-http-delete-then-get-array", true],
			["s2-http-get-then-delete-array", false],
		] as const) {
			await sm.getOrCreate("default", sbId);
			await app.request(`/v1/sandboxes/${sbId}/files/a/file.txt`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${token}` },
				body: "original",
			});

			const del = app.request(`/v1/sandboxes/${sbId}/files/a/file.txt`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${token}` },
			});
			const get = app.request(`/v1/sandboxes/${sbId}/files/a/file.txt`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const [first, second] = await Promise.all(delFirstInArray ? [del, get] : [get, del]);

			if (delFirstInArray) {
				expect(first.status, "DELETE response status").toBe(204);
				expect([404, 200], "GET sees delete-first → 404, read-first → 200").toContain(second.status);
				if (second.status === 200) expect(await second.text()).toBe("original");
			} else {
				expect(second.status, "DELETE response status").toBe(204);
				if (first.status === 200) {
					expect(await first.text()).toBe("original");
				} else {
					expect(first.status, "GET when delete won mutex first").toBe(404);
				}
			}

			const finalRead = await app.request(`/v1/sandboxes/${sbId}/files/a/file.txt`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			expect(finalRead.status, `${sbId}: file must be gone`).toBe(404);
		}
	});

	it("raw fs: delete-first → read ENOENT; read-first → read content then deleted", async () => {
		// errCode() handles both InMemoryFs (code in message) and SqlFs (.code property).
		const { sm } = makeEnv();

		// ── delete first ──
		const sbDel = "s2-raw-delete-first";
		await sm.withSession("default", sbDel, (s) => s.fs.writeFile("/file.txt", "data"));
		const [del, rd] = await Promise.all([
			sm.withSession("default", sbDel, (s) =>
				s.fs
					.rm("/file.txt")
					.then(() => "ok")
					.catch(errCode),
			),
			sm.withSession("default", sbDel, (s) => s.fs.readFile("/file.txt").catch(errCode)),
		]);
		expect(del).toBe("ok");
		expect(rd).toBe("ENOENT"); // delete won the lock first — pathCache cleared before read ran
		expect(await sm.withSession("default", sbDel, (s) => s.fs.exists("/file.txt"))).toBe(false);

		// ── read first ──
		const sbRead = "s2-raw-read-first";
		await sm.withSession("default", sbRead, (s) => s.fs.writeFile("/file.txt", "data"));
		const [content, delR] = await Promise.all([
			sm.withSession("default", sbRead, (s) => s.fs.readFile("/file.txt").catch(errCode)),
			sm.withSession("default", sbRead, (s) =>
				s.fs
					.rm("/file.txt")
					.then(() => "ok")
					.catch(errCode),
			),
		]);
		expect(content).toBe("data"); // read won the lock — saw file before delete ran
		expect(delR).toBe("ok");
		expect(await sm.withSession("default", sbRead, (s) => s.fs.exists("/file.txt"))).toBe(false);
	});
});

// ── S3 — writeFile "A"  ||  writeFile "B" (last-write-wins) ──────────────────
// Mutex serializes writers. For raw `withSession`, Promise.all order is stable enough
// in practice. For HTTP, two concurrent inbound requests are not ordered by client
// array order — only that both succeed and the final file is exactly A or B.

describe("S3 — concurrent writes with different content (last-write-wins)", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});
	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("HTTP API: concurrent PUTs both 204; final content is A or B (mutex last-writer)", async () => {
		const { app, sm } = makeEnv();
		const token = await makeToken();

		for (const sbId of ["s3-http-a-first", "s3-http-b-first"] as const) {
			await sm.getOrCreate("default", sbId);
			const [r1, r2] = await Promise.all([
				app.request(`/v1/sandboxes/${sbId}/files/f.txt`, {
					method: "PUT",
					headers: { Authorization: `Bearer ${token}` },
					body: "A",
				}),
				app.request(`/v1/sandboxes/${sbId}/files/f.txt`, {
					method: "PUT",
					headers: { Authorization: `Bearer ${token}` },
					body: "B",
				}),
			]);
			expect(r1.status).toBe(204);
			expect(r2.status).toBe(204);
			const final = await app.request(`/v1/sandboxes/${sbId}/files/f.txt`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const text = await final.text();
			expect(text === "A" || text === "B").toBe(true);
		}
	});

	it("raw fs: both succeed, the second-queued write is the final value", async () => {
		const { sm } = makeEnv();

		// A-first (A runs first, B queued second → B is final)
		const sbAB = "s3-raw-ab";
		await Promise.all([
			sm.withSession("default", sbAB, (s) => s.fs.writeFile("/f.txt", "A")),
			sm.withSession("default", sbAB, (s) => s.fs.writeFile("/f.txt", "B")),
		]);
		expect(await sm.withSession("default", sbAB, (s) => s.fs.readFile("/f.txt"))).toBe("B");

		// B-first (B runs first, A queued second → A is final)
		const sbBA = "s3-raw-ba";
		await Promise.all([
			sm.withSession("default", sbBA, (s) => s.fs.writeFile("/f.txt", "B")),
			sm.withSession("default", sbBA, (s) => s.fs.writeFile("/f.txt", "A")),
		]);
		expect(await sm.withSession("default", sbBA, (s) => s.fs.readFile("/f.txt"))).toBe("A");
	});
});

// ── S4 — mv /a→/b  ||  writeFile /a/x.txt ────────────────────────────────────
// Possible outcomes with InMemoryFs (which auto-creates missing parents on write):
//
//   mv-first:    mv succeeds (/a→/b). InMemoryFs then auto-creates /a for the write.
//                Result: /b exists (empty dir), /a re-created, /a/x.txt written.
//
//   write-first: write auto-creates /a (or uses existing) and writes /a/x.txt.
//                mv then moves /a→/b (including x.txt). Result: /b/x.txt exists, /a gone.
//
// Key consistency invariant (both orderings):
//   - mv always succeeds
//   - write always succeeds (InMemoryFs auto-mkdir)
//   - x.txt exists somewhere (/a/x.txt or /b/x.txt) but never in both places
//   - /a gone after mv-first write-second (mv removes /a, write re-creates it)
//
// Tested at raw-fs layer (no HTTP mv endpoint exists).

describe("S4 — concurrent mv /a→/b and writeFile /a/x.txt", () => {
	it("mv-first: mv succeeds, InMemoryFs auto-recreates /a for write; /b and /a/x.txt both exist", async () => {
		const { sm } = makeEnv();
		const sbId = "s4-mv-first";
		await sm.withSession("default", sbId, (s) => s.fs.mkdir("/a"));

		const [mvRes, wRes] = await Promise.all([
			sm.withSession("default", sbId, (s) =>
				s.fs
					.mv("/a", "/b")
					.then(() => "ok")
					.catch(errCode),
			),
			sm.withSession("default", sbId, (s) =>
				s.fs
					.writeFile("/a/x.txt", "content")
					.then(() => "ok")
					.catch(errCode),
			),
		]);

		expect(mvRes).toBe("ok");
		// InMemoryFs auto-creates /a for the write (unlike SqlFs which would ENOENT)
		expect(wRes).toBe("ok");

		expect(await sm.withSession("default", sbId, (s) => s.fs.exists("/b"))).toBe(true);
		// /a was re-created by InMemoryFs auto-mkdir; /a/x.txt was written there
		expect(await sm.withSession("default", sbId, (s) => s.fs.exists("/a/x.txt"))).toBe(true);
		// /b/x.txt absent — x.txt was written to the newly auto-created /a, not the original
		expect(await sm.withSession("default", sbId, (s) => s.fs.exists("/b/x.txt"))).toBe(false);
	});

	it("write-first: write succeeds, mv moves the whole /a subtree to /b; /b/x.txt exists", async () => {
		const { sm } = makeEnv();
		const sbId = "s4-write-first";
		await sm.withSession("default", sbId, (s) => s.fs.mkdir("/a"));

		const [wRes, mvRes] = await Promise.all([
			sm.withSession("default", sbId, (s) =>
				s.fs
					.writeFile("/a/x.txt", "content")
					.then(() => "ok")
					.catch(errCode),
			),
			sm.withSession("default", sbId, (s) =>
				s.fs
					.mv("/a", "/b")
					.then(() => "ok")
					.catch(errCode),
			),
		]);

		expect(wRes).toBe("ok");
		expect(mvRes).toBe("ok");

		// /a (with x.txt) was moved to /b — /b/x.txt exists, /a is gone
		expect(await sm.withSession("default", sbId, (s) => s.fs.exists("/a"))).toBe(false);
		expect(await sm.withSession("default", sbId, (s) => s.fs.exists("/b/x.txt"))).toBe(true);
		expect(await sm.withSession("default", sbId, (s) => s.fs.readFile("/b/x.txt"))).toBe("content");
	});

	it("both orderings are consistent: x.txt exists exactly once and /b always exists", async () => {
		// Regardless of InMemoryFs auto-mkdir behavior, the invariant is:
		//   - mv always succeeds → /b always exists
		//   - write always succeeds → x.txt exists exactly once (/a/x.txt or /b/x.txt)
		//   - no data corruption, no missing file
		const { sm } = makeEnv();

		const orderings: Array<["mv-first" | "write-first", string]> = [
			["mv-first", "s4-cons-mv"],
			["write-first", "s4-cons-wr"],
		];

		for (const [label, sbId] of orderings) {
			await sm.withSession("default", sbId, (s) => s.fs.mkdir("/a"));

			const ops =
				label === "mv-first"
					? ([
							sm.withSession("default", sbId, (s) =>
								s.fs
									.mv("/a", "/b")
									.then(() => "ok")
									.catch(errCode),
							),
							sm.withSession("default", sbId, (s) =>
								s.fs
									.writeFile("/a/x.txt", "content")
									.then(() => "ok")
									.catch(errCode),
							),
						] as const)
					: ([
							sm.withSession("default", sbId, (s) =>
								s.fs
									.writeFile("/a/x.txt", "content")
									.then(() => "ok")
									.catch(errCode),
							),
							sm.withSession("default", sbId, (s) =>
								s.fs
									.mv("/a", "/b")
									.then(() => "ok")
									.catch(errCode),
							),
						] as const);

			const [r1, r2] = await Promise.all(ops);
			expect(r1, `${label} op1`).toBe("ok");
			expect(r2, `${label} op2`).toBe("ok");

			// /b must always exist (mv always runs)
			expect(await sm.withSession("default", sbId, (s) => s.fs.exists("/b")), `${label}: /b must exist`).toBe(true);

			// x.txt must exist exactly once — either at /a/x.txt or /b/x.txt (not both, not neither)
			const inA = await sm.withSession("default", sbId, (s) => s.fs.exists("/a/x.txt"));
			const inB = await sm.withSession("default", sbId, (s) => s.fs.exists("/b/x.txt"));
			expect(inA || inB, `${label}: x.txt must exist somewhere`).toBe(true);
			expect(inA && inB, `${label}: x.txt must not exist in both places`).toBe(false);

			// Content must be intact wherever it landed
			const where = inB ? "/b/x.txt" : "/a/x.txt";
			expect(await sm.withSession("default", sbId, (s) => s.fs.readFile(where))).toBe("content");
		}
	});
});
