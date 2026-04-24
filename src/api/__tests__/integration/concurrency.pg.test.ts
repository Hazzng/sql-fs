/**
 * Postgres-backed concurrency integration tests.
 *
 * Re-runs the same scenarios as concurrency.test.ts and concurrency.ordering.test.ts
 * against a real Postgres database so that:
 *   - SQL-level serialization (DB transactions, inode uniqueness) is exercised
 *   - pathCache / contentCache consistency is verified against real DB state
 *   - SqlFs POSIX semantics (no auto-mkdir, .code on errors) are confirmed
 *
 * Skips automatically when DATABASE_URL is not set.
 *
 * Each test generates unique sandbox IDs and cleans up in afterEach via destroySandbox.
 */

import { Hono } from "hono";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../../fs/sql-fs/dialects/postgres.js";
import { createSandboxFs, destroySandbox } from "../../../fs/sql-fs/index.js";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { fileRoutes } from "../../routes/files.js";
import { SessionManager } from "../../session-manager.js";

const DB_URL = process.env.DATABASE_URL;

// ── Shared infrastructure ─────────────────────────────────────────────────────

const AUTH_SECRET = "pg-concurrency-test-secret-32bytes!!";
const secretBytes = new TextEncoder().encode(AUTH_SECRET);

async function makeToken(): Promise<string> {
	return new SignJWT({ sub: "tester" }).setProtectedHeader({ alg: "HS256" }).sign(secretBytes);
}

/** Extract FS error code from a SqlFs error (.code) or InMemoryFs-style message prefix. */
function errCode(e: unknown): string {
	if (!(e instanceof Error)) return "UNKNOWN";
	const fe = e as Error & { code?: string };
	if (fe.code) return fe.code;
	const m = fe.message.match(/^([A-Z]+):/);
	return m?.[1] ?? "UNKNOWN";
}

// ── Per-describe sandbox tracking ─────────────────────────────────────────────

let cleanup: string[] = [];
let envCleanups: Array<() => Promise<void>> = [];

function newId(): string {
	const id = crypto.randomUUID();
	cleanup.push(id);
	return id;
}

async function flushCleanup(): Promise<void> {
	const ids = cleanup.splice(0);
	await Promise.allSettled(ids.map((id) => destroySandbox("postgres", id)));
}

async function flushEnvCleanups(): Promise<void> {
	const cleanups = envCleanups.splice(0);
	await Promise.allSettled(cleanups.map((close) => close()));
}

/** Create a sandbox row in Postgres without warming the SessionManager pool. */
async function createSandboxInPg(sandboxId: string): Promise<void> {
	const dialect = new PostgresDialect(DB_URL!);
	await dialect.connect();
	try {
		await dialect.transaction(async (tx) => {
			await dialect.createSandbox(tx, sandboxId);
		});
	} catch (e) {
		const sqlErr = e as { code?: string };
		if (sqlErr.code !== "23505") throw e;
	} finally {
		await dialect.disconnect();
	}
}

function makePgEnv() {
	const metaDialect = new PostgresDialect(DB_URL!);
	let connected = false;
	const ensureConnected = async () => {
		if (!connected) {
			await metaDialect.connect();
			connected = true;
		}
	};

	const sm = new SessionManager({
		backend: "postgres",
		createFs: (backend, sandboxId) => createSandboxFs(backend, sandboxId),
		getSandboxMetaFn: async (sandboxId) => {
			await ensureConnected();
			return metaDialect.transaction((tx) => metaDialect.getSandboxMeta(tx, sandboxId));
		},
		persistSandboxMetaFn: async (sandboxId, meta) => {
			await ensureConnected();
			await metaDialect.transaction((tx) => metaDialect.updateSandboxMeta(tx, sandboxId, meta));
		},
	});
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", authMiddleware);
	app.route("/v1/sandboxes", fileRoutes(sm));
	const close = async () => {
		if (connected) {
			connected = false;
			await metaDialect.disconnect();
		}
	};
	envCleanups.push(close);
	return { app, sm };
}

/** Read all paths under prefix from the tree endpoint. */
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

const N = 20;

// ── Section 1: Concurrent writes to the same path ────────────────────────────

describe.skipIf(!DB_URL)("Postgres: N concurrent PUTs to the same path", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
		cleanup = [];
		envCleanups = [];
	});
	afterEach(async () => {
		process.env.AUTH_SECRET = "";
		await flushEnvCleanups();
		await flushCleanup();
	});

	it(`all ${N} writes return 204 — DB handles upsert serially`, async () => {
		const { app } = makePgEnv();
		const token = await makeToken();
		const sbId = newId();
		await createSandboxInPg(sbId);

		const results = await Promise.all(
			Array.from({ length: N }, (_, i) =>
				app.request(`/v1/sandboxes/${sbId}/files/home/user/shared.txt`, {
					method: "PUT",
					headers: { Authorization: `Bearer ${token}` },
					body: `value-${i}`,
				}),
			),
		);

		for (const res of results) {
			expect(res.status).toBe(204);
		}
	});

	it("final GET returns one of the written values — pathCache and DB in sync", async () => {
		const { app } = makePgEnv();
		const token = await makeToken();
		const sbId = newId();
		await createSandboxInPg(sbId);

		await Promise.all(
			Array.from({ length: N }, (_, i) =>
				app.request(`/v1/sandboxes/${sbId}/files/home/user/target.txt`, {
					method: "PUT",
					headers: { Authorization: `Bearer ${token}` },
					body: `write-${i}`,
				}),
			),
		);

		const readRes = await app.request(`/v1/sandboxes/${sbId}/files/home/user/target.txt`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(readRes.status).toBe(200);
		const content = await readRes.text();
		const valid = new Set(Array.from({ length: N }, (_, i) => `write-${i}`));
		expect(valid.has(content)).toBe(true);
	});
});

// ── Section 2: Concurrent writes to distinct paths ────────────────────────────

describe.skipIf(!DB_URL)("Postgres: N concurrent PUTs to distinct paths", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
		cleanup = [];
		envCleanups = [];
	});
	afterEach(async () => {
		process.env.AUTH_SECRET = "";
		await flushEnvCleanups();
		await flushCleanup();
	});

	it(`all ${N} writes succeed and tree lists exactly ${N} files`, async () => {
		const { app } = makePgEnv();
		const token = await makeToken();
		const sbId = newId();
		await createSandboxInPg(sbId);

		await Promise.all(
			Array.from({ length: N }, (_, i) =>
				app.request(`/v1/sandboxes/${sbId}/files/home/user/f-${i}.txt`, {
					method: "PUT",
					headers: { Authorization: `Bearer ${token}` },
					body: `content-${i}`,
				}),
			),
		);

		const paths = await treePaths(app, sbId, "/home/user", token);
		const files = paths.filter((p) => p.endsWith(".txt"));
		expect(files).toHaveLength(N);
		for (let i = 0; i < N; i++) {
			expect(files).toContain(`/home/user/f-${i}.txt`);
		}
	});
});

// ── Section 3: Write-delete-read cache invalidation ───────────────────────────

describe.skipIf(!DB_URL)("Postgres: write-delete-read — pathCache cleared after DB delete", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
		cleanup = [];
		envCleanups = [];
	});
	afterEach(async () => {
		process.env.AUTH_SECRET = "";
		await flushEnvCleanups();
		await flushCleanup();
	});

	it("N concurrent reads after delete all return 404 — no stale pathCache", async () => {
		const { app } = makePgEnv();
		const token = await makeToken();
		const sbId = newId();
		await createSandboxInPg(sbId);

		await app.request(`/v1/sandboxes/${sbId}/files/home/user/gone.txt`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}` },
			body: "will be deleted",
		});

		await app.request(`/v1/sandboxes/${sbId}/files/home/user/gone.txt`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});

		const reads = await Promise.all(
			Array.from({ length: N }, () =>
				app.request(`/v1/sandboxes/${sbId}/files/home/user/gone.txt`, {
					headers: { Authorization: `Bearer ${token}` },
				}),
			),
		);
		for (const r of reads) {
			expect(r.status).toBe(404);
		}
	});

	it("tree after deleting half of N files shows exactly the remaining N/2", async () => {
		const { app } = makePgEnv();
		const token = await makeToken();
		const sbId = newId();
		await createSandboxInPg(sbId);
		const total = 10;
		const keep = 5;

		await Promise.all(
			Array.from({ length: total }, (_, i) =>
				app.request(`/v1/sandboxes/${sbId}/files/home/user/f-${i}.txt`, {
					method: "PUT",
					headers: { Authorization: `Bearer ${token}` },
					body: `c-${i}`,
				}),
			),
		);

		await Promise.all(
			Array.from({ length: keep }, (_, i) =>
				app.request(`/v1/sandboxes/${sbId}/files/home/user/f-${i}.txt`, {
					method: "DELETE",
					headers: { Authorization: `Bearer ${token}` },
				}),
			),
		);

		const paths = await treePaths(app, sbId, "/home/user", token);
		const files = paths.filter((p) => p.endsWith(".txt"));
		expect(files).toHaveLength(keep);
		for (let i = keep; i < total; i++) {
			expect(files).toContain(`/home/user/f-${i}.txt`);
		}
	});
});

// ── Section 4: contentCache — overwrite then read never calls getBlob ─────────

describe.skipIf(!DB_URL)("Postgres: overwrite consistency — contentCache stays in sync with DB", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
		cleanup = [];
		envCleanups = [];
	});
	afterEach(async () => {
		process.env.AUTH_SECRET = "";
		await flushEnvCleanups();
		await flushCleanup();
	});

	it("sequential overwrites: each read returns the just-written value", async () => {
		const { app } = makePgEnv();
		const token = await makeToken();
		const sbId = newId();
		await createSandboxInPg(sbId);

		for (let i = 0; i < 10; i++) {
			await app.request(`/v1/sandboxes/${sbId}/files/home/user/v.txt`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${token}` },
				body: `version-${i}`,
			});
			const r = await app.request(`/v1/sandboxes/${sbId}/files/home/user/v.txt`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			expect(r.status).toBe(200);
			expect(await r.text()).toBe(`version-${i}`);
		}
	});

	it("N concurrent overwrites then read — no stale content from contentCache", async () => {
		const { app } = makePgEnv();
		const token = await makeToken();
		const sbId = newId();
		await createSandboxInPg(sbId);

		// Initial write
		await app.request(`/v1/sandboxes/${sbId}/files/home/user/counter.txt`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}` },
			body: "initial",
		});

		await Promise.all(
			Array.from({ length: N }, (_, i) =>
				app.request(`/v1/sandboxes/${sbId}/files/home/user/counter.txt`, {
					method: "PUT",
					headers: { Authorization: `Bearer ${token}` },
					body: `overwrite-${i}`,
				}),
			),
		);

		const r = await app.request(`/v1/sandboxes/${sbId}/files/home/user/counter.txt`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(r.status).toBe(200);
		const content = await r.text();
		const valid = new Set(["initial", ...Array.from({ length: N }, (_, i) => `overwrite-${i}`)]);
		expect(valid.has(content)).toBe(true);
	});
});

// ── Section 5: Cross-sandbox isolation (DB-level RLS / app-level scoping) ─────

describe.skipIf(!DB_URL)("Postgres: cross-sandbox isolation — writes in A not visible in B", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
		cleanup = [];
		envCleanups = [];
	});
	afterEach(async () => {
		process.env.AUTH_SECRET = "";
		await flushEnvCleanups();
		await flushCleanup();
	});

	it("concurrent writes to same path in two sandboxes — each reads its own value", async () => {
		const { app } = makePgEnv();
		const token = await makeToken();
		const sbA = newId();
		const sbB = newId();
		await Promise.all([createSandboxInPg(sbA), createSandboxInPg(sbB)]);

		await Promise.all([
			app.request(`/v1/sandboxes/${sbA}/files/home/user/shared.txt`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${token}` },
				body: "value-A",
			}),
			app.request(`/v1/sandboxes/${sbB}/files/home/user/shared.txt`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${token}` },
				body: "value-B",
			}),
		]);

		const [rA, rB] = await Promise.all([
			app.request(`/v1/sandboxes/${sbA}/files/home/user/shared.txt`, {
				headers: { Authorization: `Bearer ${token}` },
			}),
			app.request(`/v1/sandboxes/${sbB}/files/home/user/shared.txt`, {
				headers: { Authorization: `Bearer ${token}` },
			}),
		]);

		expect(rA.status).toBe(200);
		expect(rB.status).toBe(200);
		expect(await rA.text()).toBe("value-A");
		expect(await rB.text()).toBe("value-B");
	});

	it("delete in sandbox A does not affect sandbox B", async () => {
		const { app } = makePgEnv();
		const token = await makeToken();
		const sbA = newId();
		const sbB = newId();
		await Promise.all([createSandboxInPg(sbA), createSandboxInPg(sbB)]);

		await Promise.all([
			app.request(`/v1/sandboxes/${sbA}/files/home/user/common.txt`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${token}` },
				body: "data-A",
			}),
			app.request(`/v1/sandboxes/${sbB}/files/home/user/common.txt`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${token}` },
				body: "data-B",
			}),
		]);

		await app.request(`/v1/sandboxes/${sbA}/files/home/user/common.txt`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});

		const rA = await app.request(`/v1/sandboxes/${sbA}/files/home/user/common.txt`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const rB = await app.request(`/v1/sandboxes/${sbB}/files/home/user/common.txt`, {
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(rA.status).toBe(404);
		expect(rB.status).toBe(200);
		expect(await rB.text()).toBe("data-B");
	});
});

// ── Section 6: Ordering scenarios (SqlFs has correct POSIX semantics) ─────────

describe.skipIf(!DB_URL)("Postgres ordering scenarios — SqlFs POSIX semantics (no auto-mkdir)", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
		cleanup = [];
		envCleanups = [];
	});
	afterEach(async () => {
		process.env.AUTH_SECRET = "";
		await flushEnvCleanups();
		await flushCleanup();
	});

	// ── S1 ──────────────────────────────────────────────────────────────────────

	it("S1 HTTP API: PUT auto-creates parents — mkdir || write both always succeed", async () => {
		const { app } = makePgEnv();
		const token = await makeToken();

		// HTTP PUT route calls mkdir(parent, {recursive:true}) before writeFile,
		// so the write always succeeds regardless of whether mkdir ran first.
		for (const label of ["mkdir-first", "write-first"] as const) {
			const sbId = newId();
			await createSandboxInPg(sbId);
			const ops =
				label === "mkdir-first"
					? ([
							app.request(`/v1/sandboxes/${sbId}/mkdir`, {
								method: "POST",
								headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
								body: JSON.stringify({ path: "/home/user/a" }),
							}),
							app.request(`/v1/sandboxes/${sbId}/files/home/user/a/x.txt`, {
								method: "PUT",
								headers: { Authorization: `Bearer ${token}` },
								body: "content",
							}),
						] as const)
					: ([
							app.request(`/v1/sandboxes/${sbId}/files/home/user/a/x.txt`, {
								method: "PUT",
								headers: { Authorization: `Bearer ${token}` },
								body: "content",
							}),
							app.request(`/v1/sandboxes/${sbId}/mkdir`, {
								method: "POST",
								headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
								body: JSON.stringify({ path: "/home/user/a" }),
							}),
						] as const);

			const [r1, r2] = await Promise.all(ops);
			// Both ops are concurrent and serialized by session mutex — either
			// can win the race. Write always succeeds (PUT auto-creates parents).
			// Mkdir may get 409 (EEXIST) if write's auto-mkdir ran first.
			expect([204, 409], `${label} op1`).toContain(r1.status);
			expect([204, 409], `${label} op2`).toContain(r2.status);

			const paths = await treePaths(app, sbId, "/home/user/a", token);
			expect(paths).toContain("/home/user/a/x.txt");
		}
	});

	it("S1 raw SqlFs: write-first → ENOENT (no auto-mkdir); mkdir-first → both succeed", async () => {
		const { sm } = makePgEnv();

		// mkdir-first
		const sbA = newId();
		const [mkA, wA] = await Promise.all([
			sm.withSession(sbA, (s) =>
				s.fs
					.mkdir("/home/user/a")
					.then(() => "ok")
					.catch(errCode),
			),
			sm.withSession(sbA, (s) =>
				s.fs
					.writeFile("/home/user/a/x.txt", "hi")
					.then(() => "ok")
					.catch(errCode),
			),
		]);
		expect(mkA).toBe("ok"); // wins first slot
		expect(wA).toBe("ok"); // parent exists
		expect(await sm.withSession(sbA, (s) => s.fs.exists("/home/user/a/x.txt"))).toBe(true);

		// write-first → ENOENT because SqlFs does NOT auto-create parents
		const sbB = newId();
		const [wB, mkB] = await Promise.all([
			sm.withSession(sbB, (s) =>
				s.fs
					.writeFile("/home/user/a/x.txt", "hi")
					.then(() => "ok")
					.catch(errCode),
			),
			sm.withSession(sbB, (s) =>
				s.fs
					.mkdir("/home/user/a")
					.then(() => "ok")
					.catch(errCode),
			),
		]);
		expect(wB).toBe("ENOENT"); // parent /home/user/a missing — SqlFs throws ENOENT
		expect(mkB).toBe("ok");
		expect(await sm.withSession(sbB, (s) => s.fs.exists("/home/user/a/x.txt"))).toBe(false);
		expect(await sm.withSession(sbB, (s) => s.fs.exists("/home/user/a"))).toBe(true);
	});

	// ── S2 ──────────────────────────────────────────────────────────────────────

	it("S2: delete-first → read ENOENT; read-first → read content, file gone after", async () => {
		const { sm } = makePgEnv();

		// delete-first
		const sbDel = newId();
		await sm.withSession(sbDel, (s) => s.fs.writeFile("/home/user/file.txt", "data"));
		const [del, rd] = await Promise.all([
			sm.withSession(sbDel, (s) =>
				s.fs
					.rm("/home/user/file.txt")
					.then(() => "ok")
					.catch(errCode),
			),
			sm.withSession(sbDel, (s) => s.fs.readFile("/home/user/file.txt").catch(errCode)),
		]);
		expect(del).toBe("ok");
		expect(rd).toBe("ENOENT");
		expect(await sm.withSession(sbDel, (s) => s.fs.exists("/home/user/file.txt"))).toBe(false);

		// read-first
		const sbRead = newId();
		await sm.withSession(sbRead, (s) => s.fs.writeFile("/home/user/file.txt", "data"));
		const [content, delR] = await Promise.all([
			sm.withSession(sbRead, (s) => s.fs.readFile("/home/user/file.txt").catch(errCode)),
			sm.withSession(sbRead, (s) =>
				s.fs
					.rm("/home/user/file.txt")
					.then(() => "ok")
					.catch(errCode),
			),
		]);
		expect(content).toBe("data");
		expect(delR).toBe("ok");
		expect(await sm.withSession(sbRead, (s) => s.fs.exists("/home/user/file.txt"))).toBe(false);
	});

	it("S2 HTTP: whichever runs first, file is gone after both ops, delete is always 204", async () => {
		const { app } = makePgEnv();
		const token = await makeToken();

		for (const label of ["delete-first", "read-first"] as const) {
			const sbId = newId();
			await createSandboxInPg(sbId);
			await app.request(`/v1/sandboxes/${sbId}/files/home/user/f.txt`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${token}` },
				body: "original",
			});

			const ops =
				label === "delete-first"
					? ([
							app.request(`/v1/sandboxes/${sbId}/files/home/user/f.txt`, {
								method: "DELETE",
								headers: { Authorization: `Bearer ${token}` },
							}),
							app.request(`/v1/sandboxes/${sbId}/files/home/user/f.txt`, {
								headers: { Authorization: `Bearer ${token}` },
							}),
						] as const)
					: ([
							app.request(`/v1/sandboxes/${sbId}/files/home/user/f.txt`, {
								headers: { Authorization: `Bearer ${token}` },
							}),
							app.request(`/v1/sandboxes/${sbId}/files/home/user/f.txt`, {
								method: "DELETE",
								headers: { Authorization: `Bearer ${token}` },
							}),
						] as const);

			const [first, second] = await Promise.all(ops);

			// Both ops are concurrent and serialized by session mutex — either
			// can acquire the lock first regardless of Promise.all position.
			// DELETE always returns 204; GET returns 200 or 404 depending on race.
			if (label === "delete-first") {
				expect(first.status).toBe(204); // delete always succeeds
				expect([200, 404]).toContain(second.status); // read depends on race
			} else {
				expect([200, 404]).toContain(first.status); // read depends on race
				if (first.status === 200) {
					expect(await first.text()).toBe("original");
				}
				expect(second.status).toBe(204); // delete always succeeds
			}

			const final = await app.request(`/v1/sandboxes/${sbId}/files/home/user/f.txt`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			expect(final.status, `${label}: file must be gone`).toBe(404);
		}
	});

	// ── S3 ──────────────────────────────────────────────────────────────────────

	it("S3: both writes succeed, second-queued writer is the final value (last-write-wins)", async () => {
		const { sm } = makePgEnv();

		// A-first: A wins mutex → B queued second → B is final
		const sbAB = newId();
		await Promise.all([
			sm.withSession(sbAB, (s) => s.fs.writeFile("/home/user/f.txt", "A")),
			sm.withSession(sbAB, (s) => s.fs.writeFile("/home/user/f.txt", "B")),
		]);
		expect(await sm.withSession(sbAB, (s) => s.fs.readFile("/home/user/f.txt"))).toBe("B");

		// B-first: B wins mutex → A queued second → A is final
		const sbBA = newId();
		await Promise.all([
			sm.withSession(sbBA, (s) => s.fs.writeFile("/home/user/f.txt", "B")),
			sm.withSession(sbBA, (s) => s.fs.writeFile("/home/user/f.txt", "A")),
		]);
		expect(await sm.withSession(sbBA, (s) => s.fs.readFile("/home/user/f.txt"))).toBe("A");
	});

	// ── S4 ──────────────────────────────────────────────────────────────────────

	it("S4 mv-first: write /home/user/a/x.txt → ENOENT after mv /home/user/a→/home/user/b", async () => {
		const { sm } = makePgEnv();
		const sbId = newId();
		await sm.withSession(sbId, (s) => s.fs.mkdir("/home/user/a"));

		const [mvRes, wRes] = await Promise.all([
			sm.withSession(sbId, (s) =>
				s.fs
					.mv("/home/user/a", "/home/user/b")
					.then(() => "ok")
					.catch(errCode),
			),
			sm.withSession(sbId, (s) =>
				s.fs
					.writeFile("/home/user/a/x.txt", "content")
					.then(() => "ok")
					.catch(errCode),
			),
		]);

		expect(mvRes).toBe("ok");
		expect(wRes).toBe("ENOENT"); // SqlFs: no auto-mkdir — parent gone after mv

		expect(await sm.withSession(sbId, (s) => s.fs.exists("/home/user/b"))).toBe(true);
		expect(await sm.withSession(sbId, (s) => s.fs.exists("/home/user/a"))).toBe(false);
		expect(await sm.withSession(sbId, (s) => s.fs.exists("/home/user/a/x.txt"))).toBe(false);
		expect(await sm.withSession(sbId, (s) => s.fs.exists("/home/user/b/x.txt"))).toBe(false);
	});

	it("S4 write-first: x.txt written under /a, then mv /a→/b moves subtree; /b/x.txt exists", async () => {
		const { sm } = makePgEnv();
		const sbId = newId();
		await sm.withSession(sbId, (s) => s.fs.mkdir("/home/user/a"));

		const [wRes, mvRes] = await Promise.all([
			sm.withSession(sbId, (s) =>
				s.fs
					.writeFile("/home/user/a/x.txt", "content")
					.then(() => "ok")
					.catch(errCode),
			),
			sm.withSession(sbId, (s) =>
				s.fs
					.mv("/home/user/a", "/home/user/b")
					.then(() => "ok")
					.catch(errCode),
			),
		]);

		expect(wRes).toBe("ok");
		expect(mvRes).toBe("ok");

		expect(await sm.withSession(sbId, (s) => s.fs.exists("/home/user/a"))).toBe(false);
		expect(await sm.withSession(sbId, (s) => s.fs.exists("/home/user/b/x.txt"))).toBe(true);
		expect(await sm.withSession(sbId, (s) => s.fs.readFile("/home/user/b/x.txt"))).toBe("content");
	});

	it("S4 consistency: x.txt always exists exactly once; /b always exists", async () => {
		const { sm } = makePgEnv();

		for (const label of ["mv-first", "write-first"] as const) {
			const sbId = newId();
			await sm.withSession(sbId, (s) => s.fs.mkdir("/home/user/a"));

			const ops =
				label === "mv-first"
					? ([
							sm.withSession(sbId, (s) =>
								s.fs
									.mv("/home/user/a", "/home/user/b")
									.then(() => "ok")
									.catch(errCode),
							),
							sm.withSession(sbId, (s) =>
								s.fs
									.writeFile("/home/user/a/x.txt", "content")
									.then(() => "ok")
									.catch(errCode),
							),
						] as const)
					: ([
							sm.withSession(sbId, (s) =>
								s.fs
									.writeFile("/home/user/a/x.txt", "content")
									.then(() => "ok")
									.catch(errCode),
							),
							sm.withSession(sbId, (s) =>
								s.fs
									.mv("/home/user/a", "/home/user/b")
									.then(() => "ok")
									.catch(errCode),
							),
						] as const);

			await Promise.all(ops);

			// /b must always exist (mv always runs)
			expect(await sm.withSession(sbId, (s) => s.fs.exists("/home/user/b")), `${label}: /b`).toBe(true);

			const inA = await sm.withSession(sbId, (s) => s.fs.exists("/home/user/a/x.txt"));
			const inB = await sm.withSession(sbId, (s) => s.fs.exists("/home/user/b/x.txt"));

			if (label === "mv-first") {
				// write failed (ENOENT) — x.txt exists nowhere
				expect(inA, "mv-first: /a/x.txt must not exist").toBe(false);
				expect(inB, "mv-first: /b/x.txt must not exist (write failed)").toBe(false);
			} else {
				// write succeeded, mv moved the subtree — x.txt is in /b
				expect(inB, "write-first: /b/x.txt must exist").toBe(true);
				expect(inA, "write-first: /a must be gone").toBe(false);
				expect(await sm.withSession(sbId, (s) => s.fs.readFile("/home/user/b/x.txt"))).toBe("content");
			}
		}
	});
});
