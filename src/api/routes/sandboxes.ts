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
import { forbiddenResponse, isForbiddenError, withOwnedSessionOrRehydrate } from "../ownership.js";
import type { SessionManager } from "../session-manager.js";

const createBodySchema = z.object({
	env: z.record(z.string()).optional(),
	files: z.record(z.string()).optional(),
	python: z.boolean().optional(),
	javascript: z.boolean().optional(),
});

export function sandboxRoutes(sessionManager: SessionManager): Hono<{ Variables: AuthVariables }> {
	const router = new Hono<{ Variables: AuthVariables }>();

	router.post("/", async (c) => {
		let files: Record<string, string> | undefined;
		let python = false;
		let javascript = false;

		// Body is optional — parse if present, ignore if missing/empty
		try {
			const raw = await c.req.json();
			const result = createBodySchema.safeParse(raw);
			if (!result.success) {
				const details = result.error.issues.map((i) => i.message);
				return c.json({ error: "validation_error", code: "INVALID_INPUT", details }, 400 as ContentfulStatusCode);
			}
			files = result.data.files;
			python = result.data.python ?? false;
			javascript = result.data.javascript ?? false;
		} catch {
			// No body provided — that's fine
		}

		const owner = c.get("owner");
		const tenant = c.get("tenant");
		const sandboxId = crypto.randomUUID();
		const createdAt = new Date().toISOString();

		await sessionManager.withSession(
			tenant,
			sandboxId,
			async (session) => {
				if (!session.owner) session.owner = owner;
				session.createdAt = createdAt;
				await sessionManager.persistSandboxMeta(tenant, sandboxId, { owner, python, javascript });
				if (files !== undefined) {
					for (const [path, content] of Object.entries(files)) {
						await session.fs.writeFile(path, content);
					}
				}
			},
			{ python, javascript },
			owner,
		);

		return c.json({ id: sandboxId, owner, createdAt, python, javascript }, 201 as ContentfulStatusCode);
	});

	router.get("/:id", (c) => {
		const id = c.req.param("id");
		const tenant = c.get("tenant");
		const session = sessionManager.getSession(tenant, id);
		if (session === undefined) {
			return c.json({ error: "not_found", code: "SANDBOX_NOT_FOUND" }, 404 as ContentfulStatusCode);
		}
		const caller = c.get("owner");
		if (session.owner && session.owner !== caller) {
			return c.json({ error: "forbidden", code: "FORBIDDEN" }, 403 as ContentfulStatusCode);
		}
		return c.json({
			id,
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
