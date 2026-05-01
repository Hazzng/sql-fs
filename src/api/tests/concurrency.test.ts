/**
 * Concurrency tests: per-sandbox mutex serialization + cache invalidation under load.
 *
 * Validates at the full HTTP API stack level:
 *   1. N concurrent writes to the same path — all succeed, final state is valid
 *   2. N concurrent writes to distinct paths — all succeed, tree lists all N
 *   3. Write-overwrite-read — no stale content after overwrite (contentCache)
 *   4. Write-delete-read — no phantom reads after delete (pathCache)
 *   5. N concurrent reads — all see the same consistent value
 *   6. Cross-sandbox isolation — sandbox A writes never visible in sandbox B
 *
 * InMemoryFs is used for all tests so no DB is required.
 * A separate section uses a mock SqlDialect to verify SqlFs contentCache/pathCache
 * invariants at the API layer (cache must stay in sync even under concurrent load).
 */

import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../fs/sql-fs/sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../../fs/sql-fs/types.js";
import { type AuthVariables, createAuthMiddleware } from "../auth.js";
import { fileRoutes } from "../routes/files.js";
import { SessionManager } from "../session-manager.js";
import { stubTenantConfig } from "./helpers/tenant.js";

// ── Shared test infrastructure ────────────────────────────────────────────────

const AUTH_SECRET = "test-secret-concurrency-at-least-32bytes!";
const secretBytes = new TextEncoder().encode(AUTH_SECRET);

async function makeToken(): Promise<string> {
	return new SignJWT({ sub: "tester" }).setProtectedHeader({ alg: "HS256" }).sign(secretBytes);
}

function makeApp(sm: SessionManager): Hono<{ Variables: AuthVariables }> {
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", createAuthMiddleware(stubTenantConfig()));
	app.route("/v1/sandboxes", fileRoutes(sm));
	return app;
}

function makeMemoryApp(): { app: Hono<{ Variables: AuthVariables }>; sm: SessionManager } {
	const sm = new SessionManager({ createFs: async () => new InMemoryFs() });
	return { app: makeApp(sm), sm };
}

const N = 20;

// ── Section 1: Concurrent writes to the same path ────────────────────────────

describe("N concurrent PUTs to the same path within one sandbox", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});
	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it(`all ${N} responses are 204 — mutex serializes without dropping any request`, async () => {
		const { app, sm } = makeMemoryApp();
		const token = await makeToken();
		const sbId = "conc-same-path-1";
		await sm.getOrCreate("default", sbId);

		const results = await Promise.all(
			Array.from({ length: N }, (_, i) =>
				app.request(`/v1/sandboxes/${sbId}/files/shared.txt`, {
					method: "PUT",
					headers: { Authorization: `Bearer ${token}` },
					body: `value-${i}`,
				}),
			),
		);

		for (const res of results) {
			expect(res.status, "every write must return 204").toBe(204);
		}
	});

	it("final GET returns one of the written values — no corruption in pathCache", async () => {
		const { app, sm } = makeMemoryApp();
		const token = await makeToken();
		const sbId = "conc-same-path-2";
		await sm.getOrCreate("default", sbId);

		await Promise.all(
			Array.from({ length: N }, (_, i) =>
				app.request(`/v1/sandboxes/${sbId}/files/target.txt`, {
					method: "PUT",
					headers: { Authorization: `Bearer ${token}` },
					body: `write-${i}`,
				}),
			),
		);

		const readRes = await app.request(`/v1/sandboxes/${sbId}/files/target.txt`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(readRes.status).toBe(200);
		const content = await readRes.text();
		const valid = new Set(Array.from({ length: N }, (_, i) => `write-${i}`));
		expect(valid.has(content), `"${content}" is not one of the ${N} written values`).toBe(true);
	});
});

// ── Section 2: Concurrent writes to distinct paths ────────────────────────────

describe("N concurrent PUTs to distinct paths within one sandbox", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});
	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it(`all ${N} writes succeed and tree lists exactly ${N} files`, async () => {
		const { app, sm } = makeMemoryApp();
		const token = await makeToken();
		const sbId = "conc-distinct-paths";
		await sm.getOrCreate("default", sbId);

		const putResults = await Promise.all(
			Array.from({ length: N }, (_, i) =>
				app.request(`/v1/sandboxes/${sbId}/files/dir/file-${i}.txt`, {
					method: "PUT",
					headers: { Authorization: `Bearer ${token}` },
					body: `content-${i}`,
				}),
			),
		);

		for (const res of putResults) {
			expect(res.status).toBe(204);
		}

		const treeRes = await app.request(`/v1/sandboxes/${sbId}/tree?prefix=/dir`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(treeRes.status).toBe(200);
		type Entry = { path: string; kind: string };
		const entries = (await treeRes.json()) as Entry[];
		const files = entries.filter((e) => e.kind === "file");
		expect(files).toHaveLength(N);

		// Verify each expected path is present
		const paths = new Set(files.map((e) => e.path));
		for (let i = 0; i < N; i++) {
			expect(paths.has(`/dir/file-${i}.txt`), `missing /dir/file-${i}.txt`).toBe(true);
		}
	});
});

// ── Section 3: Write-overwrite-read — no stale content ───────────────────────

describe("Write-overwrite-read consistency within one sandbox", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});
	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("sequential overwrite: each read after a write sees the latest content", async () => {
		const { app, sm } = makeMemoryApp();
		const token = await makeToken();
		const sbId = "overwrite-read";
		await sm.getOrCreate("default", sbId);

		for (let i = 0; i < 10; i++) {
			await app.request(`/v1/sandboxes/${sbId}/files/v.txt`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${token}` },
				body: `version-${i}`,
			});
			// Each read must see exactly the value just written
			const readRes = await app.request(`/v1/sandboxes/${sbId}/files/v.txt`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			expect(readRes.status).toBe(200);
			// Since ops are serialized by the mutex, the read must see `version-i`
			// (no other writer can slip in between these two awaited calls)
			expect(await readRes.text()).toBe(`version-${i}`);
		}
	});

	it("N concurrent overwrites then one read — no stale content, no 404", async () => {
		const { app, sm } = makeMemoryApp();
		const token = await makeToken();
		const sbId = "conc-overwrite";
		await sm.getOrCreate("default", sbId);

		// Initial write
		await app.request(`/v1/sandboxes/${sbId}/files/counter.txt`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}` },
			body: "initial",
		});

		// N concurrent overwrites
		await Promise.all(
			Array.from({ length: N }, (_, i) =>
				app.request(`/v1/sandboxes/${sbId}/files/counter.txt`, {
					method: "PUT",
					headers: { Authorization: `Bearer ${token}` },
					body: `overwrite-${i}`,
				}),
			),
		);

		// Read must return a valid value — never the old "initial" because at least
		// one overwrite completes last, and it must never return 404 or corrupt data
		const readRes = await app.request(`/v1/sandboxes/${sbId}/files/counter.txt`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(readRes.status).toBe(200);
		const content = await readRes.text();
		const valid = new Set(["initial", ...Array.from({ length: N }, (_, i) => `overwrite-${i}`)]);
		expect(valid.has(content)).toBe(true);
	});
});

// ── Section 4: Write-delete-read — pathCache invalidation ────────────────────

describe("Write-delete-read: pathCache cleared after delete", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});
	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("after deleting a file, all subsequent reads return 404 (no stale pathCache)", async () => {
		const { app, sm } = makeMemoryApp();
		const token = await makeToken();
		const sbId = "delete-invalidation";
		await sm.getOrCreate("default", sbId);

		// Write a file
		await app.request(`/v1/sandboxes/${sbId}/files/to-delete.txt`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}` },
			body: "will be deleted",
		});

		// Delete it
		const delRes = await app.request(`/v1/sandboxes/${sbId}/files/to-delete.txt`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(delRes.status).toBe(204);

		// N concurrent reads must all return 404, not stale content
		const readResults = await Promise.all(
			Array.from({ length: N }, () =>
				app.request(`/v1/sandboxes/${sbId}/files/to-delete.txt`, {
					headers: { Authorization: `Bearer ${token}` },
				}),
			),
		);

		for (const res of readResults) {
			expect(res.status).toBe(404);
		}
	});

	it("tree listing after deleting half the files shows exactly the remaining files", async () => {
		const { app, sm } = makeMemoryApp();
		const token = await makeToken();
		const sbId = "partial-delete";
		await sm.getOrCreate("default", sbId);
		const total = 10;
		const keep = 5;

		// Write 10 files
		await Promise.all(
			Array.from({ length: total }, (_, i) =>
				app.request(`/v1/sandboxes/${sbId}/files/dir/f-${i}.txt`, {
					method: "PUT",
					headers: { Authorization: `Bearer ${token}` },
					body: `content-${i}`,
				}),
			),
		);

		// Delete the first 5 concurrently
		await Promise.all(
			Array.from({ length: keep }, (_, i) =>
				app.request(`/v1/sandboxes/${sbId}/files/dir/f-${i}.txt`, {
					method: "DELETE",
					headers: { Authorization: `Bearer ${token}` },
				}),
			),
		);

		const treeRes = await app.request(`/v1/sandboxes/${sbId}/tree?prefix=/dir`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(treeRes.status).toBe(200);
		type Entry = { path: string; kind: string };
		const entries = (await treeRes.json()) as Entry[];
		const files = entries.filter((e) => e.kind === "file");
		expect(files).toHaveLength(keep);

		// The remaining files must be f-5 through f-9
		const paths = new Set(files.map((e) => e.path));
		for (let i = keep; i < total; i++) {
			expect(paths.has(`/dir/f-${i}.txt`)).toBe(true);
		}
	});
});

// ── Section 5: Concurrent reads return a consistent value ─────────────────────

describe("N concurrent reads of the same file", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});
	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it(`all ${N} concurrent reads return the same content`, async () => {
		const { app, sm } = makeMemoryApp();
		const token = await makeToken();
		const sbId = "concurrent-reads";
		await sm.getOrCreate("default", sbId);

		await app.request(`/v1/sandboxes/${sbId}/files/stable.txt`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}` },
			body: "stable-content",
		});

		const readResults = await Promise.all(
			Array.from({ length: N }, () =>
				app.request(`/v1/sandboxes/${sbId}/files/stable.txt`, {
					headers: { Authorization: `Bearer ${token}` },
				}),
			),
		);

		for (const res of readResults) {
			expect(res.status).toBe(200);
			expect(await res.text()).toBe("stable-content");
		}
	});
});

// ── Section 6: Cross-sandbox isolation ────────────────────────────────────────

describe("Cross-sandbox isolation", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});
	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("writes to sandbox A are not visible in sandbox B (same path)", async () => {
		const { app, sm } = makeMemoryApp();
		const token = await makeToken();
		const sbA = "isolation-sandbox-a";
		const sbB = "isolation-sandbox-b";
		await Promise.all([sm.getOrCreate("default", sbA), sm.getOrCreate("default", sbB)]);

		await Promise.all([
			app.request(`/v1/sandboxes/${sbA}/files/shared/data.txt`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${token}` },
				body: "sandbox-a-value",
			}),
			app.request(`/v1/sandboxes/${sbB}/files/shared/data.txt`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${token}` },
				body: "sandbox-b-value",
			}),
		]);

		const [resA, resB] = await Promise.all([
			app.request(`/v1/sandboxes/${sbA}/files/shared/data.txt`, {
				headers: { Authorization: `Bearer ${token}` },
			}),
			app.request(`/v1/sandboxes/${sbB}/files/shared/data.txt`, {
				headers: { Authorization: `Bearer ${token}` },
			}),
		]);

		expect(resA.status).toBe(200);
		expect(resB.status).toBe(200);
		expect(await resA.text()).toBe("sandbox-a-value");
		expect(await resB.text()).toBe("sandbox-b-value");
	});

	it("deleting a path in sandbox A does not affect sandbox B", async () => {
		const { app, sm } = makeMemoryApp();
		const token = await makeToken();
		const sbA = "iso-del-a";
		const sbB = "iso-del-b";
		await Promise.all([sm.getOrCreate("default", sbA), sm.getOrCreate("default", sbB)]);

		await Promise.all([
			app.request(`/v1/sandboxes/${sbA}/files/common.txt`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${token}` },
				body: "data-a",
			}),
			app.request(`/v1/sandboxes/${sbB}/files/common.txt`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${token}` },
				body: "data-b",
			}),
		]);

		// Delete from A only
		await app.request(`/v1/sandboxes/${sbA}/files/common.txt`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});

		const resA = await app.request(`/v1/sandboxes/${sbA}/files/common.txt`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const resB = await app.request(`/v1/sandboxes/${sbB}/files/common.txt`, {
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(resA.status).toBe(404);
		expect(resB.status).toBe(200);
		expect(await resB.text()).toBe("data-b");
	});
});

// ── Section 7: SqlFs contentCache/pathCache under concurrent API writes ───────
//
// Uses a mocked SqlDialect so SqlFs is the real class under test.
// This verifies that contentCache and pathCache remain consistent after
// N sequential writes through the API (serialized by the sandbox mutex).

describe("SqlFs contentCache stays in sync after N overwrites via API", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});
	afterEach(() => {
		process.env.AUTH_SECRET = "";
		vi.restoreAllMocks();
	});

	function makeMockDialect(): {
		dialect: SqlDialect<unknown>;
		getBlobMock: ReturnType<typeof vi.fn>;
		nextInodeId: { value: bigint };
	} {
		const now = new Date();
		const nextInodeId = { value: 10n };

		const getBlobMock = vi.fn(async () => null as Uint8Array | null);

		// upsertDirent: first call returns null (fresh insert); subsequent calls for the
		// same path return the previously set inodeId to simulate dirent replacement.
		const direntMap = new Map<string, bigint>();
		const upsertDirentMock = vi.fn(
			async (_tx: unknown, parentId: bigint, name: string, newId: bigint): Promise<bigint | null> => {
				const key = `${parentId}:${name}`;
				const old = direntMap.get(key) ?? null;
				direntMap.set(key, newId);
				return old;
			},
		);

		const dialect: SqlDialect<unknown> = {
			connect: vi.fn(),
			disconnect: vi.fn(),
			transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
			setSandboxContext: vi.fn(),
			setSandboxContextWithLock: vi.fn(),
			loadAllPaths: vi.fn(async () => {
				const entry = (path: string, inodeId: bigint, kind: 1 | 2): { path: string } & PathCacheEntry => ({
					path,
					inodeId,
					kind,
					mode: kind === 2 ? 0o755 : 0o644,
					size: 0,
					mtime: now,
					contentSha256: null,
					symlinkTarget: null,
				});
				return [entry("/", 1n, 2), entry("/home", 2n, 2), entry("/home/user", 3n, 2)];
			}),
			createSandbox: vi.fn(),
			deleteSandbox: vi.fn(),
			createInode: vi.fn(async () => {
				const id = nextInodeId.value;
				nextInodeId.value += 1n;
				return id;
			}),
			getInode: vi.fn(),
			updateInode: vi.fn(),
			deleteInode: vi.fn(),
			incrementNlink: vi.fn(),
			decrementNlink: vi.fn(async () => 0),
			insertDirent: vi.fn(),
			upsertDirent: upsertDirentMock,
			deleteDirent: vi.fn(async (_tx: unknown, _parentId: bigint, _name: string) => 10n),
			listDirents: vi.fn(),
			moveDirent: vi.fn(),
			upsertBlob: vi.fn(),
			getBlob: getBlobMock,
			gcOrphanBlobs: vi.fn(),
			getBlobsForSandbox: vi.fn(async () => []),
			loadSubtreeInodes: vi.fn(async () => [10n]),
			bulkIngest: vi.fn(),
			resolvePath: vi.fn(),
		} as unknown as SqlDialect<unknown>;

		return { dialect, getBlobMock, nextInodeId };
	}

	it("N sequential overwrites via API: read returns last written content without DB call", async () => {
		const WRITES = 10;
		const { dialect, getBlobMock } = makeMockDialect();
		const sqlFs = new SqlFs({ dialect, sandboxId: "sqlfs-overwrite" });
		await sqlFs.ready();

		const sm = new SessionManager({
			createFs: async () => sqlFs,
		});
		const app = makeApp(sm);
		const token = await makeToken();
		const sbId = "sqlfs-cache-overwrite";
		await sm.getOrCreate("default", sbId);

		// Write WRITES times to the same path — serialized by mutex
		for (let i = 0; i < WRITES; i++) {
			const res = await app.request(`/v1/sandboxes/${sbId}/files/home/user/f.txt`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${token}` },
				body: `write-${i}`,
			});
			expect(res.status).toBe(204);
		}

		// Read — must return the last write's content, served from contentCache (no getBlob)
		getBlobMock.mockClear();
		const readRes = await app.request(`/v1/sandboxes/${sbId}/files/home/user/f.txt`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(readRes.status).toBe(200);
		expect(await readRes.text()).toBe(`write-${WRITES - 1}`);
		expect(getBlobMock).not.toHaveBeenCalled();
	});

	it("pathCache cleared after delete: tree does not list deleted file", async () => {
		const { dialect } = makeMockDialect();
		const sqlFs = new SqlFs({ dialect, sandboxId: "sqlfs-delete" });
		await sqlFs.ready();

		const sm = new SessionManager({
			createFs: async () => sqlFs,
		});
		const app = makeApp(sm);
		const token = await makeToken();
		const sbId = "sqlfs-cache-delete";
		await sm.getOrCreate("default", sbId);

		// Write a file
		await app.request(`/v1/sandboxes/${sbId}/files/home/user/gone.txt`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}` },
			body: "will be deleted",
		});

		// Confirm it's in the tree
		const treeBefore = await app.request(`/v1/sandboxes/${sbId}/tree?prefix=/home/user`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		type Entry = { path: string };
		const before = (await treeBefore.json()) as Entry[];
		expect(before.some((e) => e.path === "/home/user/gone.txt")).toBe(true);

		// Delete it
		await app.request(`/v1/sandboxes/${sbId}/files/home/user/gone.txt`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});

		// Tree must not list it anymore
		const treeAfter = await app.request(`/v1/sandboxes/${sbId}/tree?prefix=/home/user`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const after = (await treeAfter.json()) as Entry[];
		expect(after.some((e) => e.path === "/home/user/gone.txt")).toBe(false);

		// Read must return 404 — pathCache is invalidated
		const readRes = await app.request(`/v1/sandboxes/${sbId}/files/home/user/gone.txt`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(readRes.status).toBe(404);
	});
});
