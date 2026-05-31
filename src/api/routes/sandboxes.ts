/**
 * Sandbox CRUD routes.
 * US-059: POST /v1/sandboxes — create sandbox
 * US-060: GET /v1/sandboxes/:id — get sandbox info
 * US-061: DELETE /v1/sandboxes/:id — delete sandbox
 */

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { AuthVariables } from "../auth.js";
import { forbiddenResponse, isForbiddenError, isOwnedBy, withOwnedSessionOrRehydrate } from "../ownership.js";
import type { SessionManager } from "../session-manager.js";

const createBodySchema = z.object({
	name: z.string().max(255).optional(),
	env: z.record(z.string()).optional(),
	files: z.record(z.string()).optional(),
	python: z.boolean().optional(),
	javascript: z.boolean().optional(),
	/** When true, js-exec fetch() is granted unrestricted outbound HTTPS access. */
	network: z.boolean().optional(),
});

// Audit H11 (#2): bound the optional initial-files map so a single create can't
// buffer an unbounded number of files / bytes. Shares the bulk-write env knobs.
const MAX_INITIAL_FILES = Number(process.env.MAX_BULK_WRITE_FILES ?? "1000");
const MAX_INITIAL_FILE_BYTES = Number(process.env.MAX_BULK_WRITE_BYTES ?? `${128 * 1024 * 1024}`);

export function sandboxRoutes(sessionManager: SessionManager): Hono<{ Variables: AuthVariables }> {
	const router = new Hono<{ Variables: AuthVariables }>();

	router.post("/", async (c) => {
		let name: string | null = null;
		let files: Record<string, string> | undefined;
		let python = false;
		let javascript = false;
		let network = false;

		// Body is optional — parse if present, ignore if missing/empty
		try {
			const raw = await c.req.json();
			const result = createBodySchema.safeParse(raw);
			if (!result.success) {
				const details = result.error.issues.map((i) => i.message);
				return c.json({ error: "validation_error", code: "INVALID_INPUT", details }, 400 as ContentfulStatusCode);
			}
			name = result.data.name ?? null;
			files = result.data.files;
			python = result.data.python ?? false;
			javascript = result.data.javascript ?? false;
			network = result.data.network ?? false;
		} catch {
			// No body provided — that's fine
		}

		if (files !== undefined) {
			const entries = Object.entries(files);
			if (entries.length > MAX_INITIAL_FILES) {
				return c.json(
					{
						error: "payload_too_large",
						code: "PAYLOAD_TOO_LARGE",
						details: [`Initial files exceed count limit (${MAX_INITIAL_FILES})`],
					},
					413 as ContentfulStatusCode,
				);
			}
			let totalBytes = 0;
			for (const [, content] of entries) {
				totalBytes += Buffer.byteLength(content, "utf8");
				if (totalBytes > MAX_INITIAL_FILE_BYTES) {
					return c.json(
						{
							error: "payload_too_large",
							code: "PAYLOAD_TOO_LARGE",
							details: [`Initial files exceed total byte limit (${MAX_INITIAL_FILE_BYTES})`],
						},
						413 as ContentfulStatusCode,
					);
				}
			}
		}

		const owner = c.get("owner");
		const tenant = c.get("tenant");
		const sandboxId = crypto.randomUUID();

		// createdAt is captured from the session after buildFs runs, so it reflects
		// the DB-generated created_at timestamp rather than a JS clock reading.
		let createdAt = new Date().toISOString();

		await sessionManager.withSession(
			tenant,
			sandboxId,
			async (session) => {
				if (!session.owner) session.owner = owner;
				session.name = name;
				// session.createdAt is set by getOrCreate from the DB RETURNING clause.
				createdAt = session.createdAt;
				// Forward createdAt so KV/Redis-backed metadata stores (whose getSandboxMetaFn
				// reads only what persistSandboxMetaFn wrote) can also serve the DB timestamp
				// without falling back to a fabricated clock reading on the GET fallback path.
				await sessionManager.persistSandboxMeta(tenant, sandboxId, {
					owner,
					name,
					python,
					javascript,
					network,
					createdAt,
				});
				if (files !== undefined) {
					for (const [path, content] of Object.entries(files)) {
						// Audit M6: create missing parent dirs so nested initial files
						// (e.g. "src/app.ts") don't fail with ENOENT.
						const slash = path.lastIndexOf("/");
						const parent = slash > 0 ? path.slice(0, slash) : "/";
						if (parent !== "/") {
							try {
								await session.fs.mkdir(parent, { recursive: true });
							} catch (e) {
								const code = (e as Error & { code?: string }).code;
								if (code !== "EEXIST") throw e;
							}
						}
						await session.fs.writeFile(path, content);
					}
				}
			},
			{ python, javascript, network },
			owner,
		);

		return c.json({ id: sandboxId, name, owner, createdAt, python, javascript, network }, 201 as ContentfulStatusCode);
	});

	router.get("/", async (c) => {
		const tenant = c.get("tenant");
		const caller = c.get("owner");
		try {
			const sandboxes = await sessionManager.listSandboxes(tenant, caller);
			return c.json({
				sandboxes: sandboxes.map((s) => ({
					id: s.id,
					name: s.name,
					owner: s.owner,
					createdAt: s.createdAt.toISOString(),
					python: s.python,
					javascript: s.javascript,
					network: s.network,
				})),
			});
		} catch (err) {
			const code = (err as Error & { code?: string }).code;
			if (code === "ENOTSUP") {
				return c.json({ error: "listing not supported", code: "ENOTSUP" }, 501 as ContentfulStatusCode);
			}
			throw err;
		}
	});

	router.get("/:id", async (c) => {
		const id = c.req.param("id");
		const tenant = c.get("tenant");
		const caller = c.get("owner");
		const session = sessionManager.getSession(tenant, id);
		if (session === undefined) {
			// Session evicted or on a cold replica — fall back to DB.
			const meta = await sessionManager.getSandboxMeta(tenant, id);
			if (meta === null) {
				return c.json({ error: "not_found", code: "SANDBOX_NOT_FOUND" }, 404 as ContentfulStatusCode);
			}
			if (!isOwnedBy(meta.owner, caller)) {
				return c.json({ error: "forbidden", code: "FORBIDDEN" }, 403 as ContentfulStatusCode);
			}
			// If a future dialect/metadata store doesn't populate createdAt, return null
			// rather than fabricating a fresh timestamp — that would re-introduce the
			// clock-drift bug this PR fixes. The Postgres path always supplies a value.
			return c.json({
				id,
				name: meta.name,
				owner: meta.owner,
				createdAt: meta.createdAt ?? null,
				lastUsedAt: null,
			});
		}
		if (!isOwnedBy(session.owner, caller)) {
			return c.json({ error: "forbidden", code: "FORBIDDEN" }, 403 as ContentfulStatusCode);
		}
		return c.json({
			id,
			name: session.name,
			owner: session.owner,
			createdAt: session.createdAt,
			lastUsedAt: new Date(session.lastUsed).toISOString(),
		});
	});

	router.delete("/:id", async (c) => {
		const id = c.req.param("id");
		const tenant = c.get("tenant");
		try {
			await withOwnedSessionOrRehydrate(sessionManager, tenant, id, c.get("owner"), async () => undefined);
		} catch (err) {
			const code = (err as Error & { code?: string }).code;
			if (isForbiddenError(err)) {
				return forbiddenResponse();
			}
			if (code === "ENOENT") {
				return c.json({ error: "not_found", code: "SANDBOX_NOT_FOUND" }, 404 as ContentfulStatusCode);
			}
			throw err;
		}
		const found = await sessionManager.destroy(tenant, id);
		if (!found) {
			return c.json({ error: "not_found", code: "SANDBOX_NOT_FOUND" }, 404 as ContentfulStatusCode);
		}
		return c.body(null, 204);
	});

	return router;
}
