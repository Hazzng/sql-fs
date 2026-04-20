/**
 * Execution routes.
 * US-068: POST /v1/sandboxes/:id/exec-sync — buffered execution
 * US-069: POST /v1/sandboxes/:id/exec — SSE streaming execution
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { AuthVariables } from "../auth.js";
import type { SessionManager } from "../session-manager.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

const execBodySchema = z.object({
	script: z.string(),
	cwd: z.string().optional(),
	env: z.record(z.string(), z.string()).optional(),
	timeoutMs: z.number().int().positive().optional(),
});

/** Returns 403 response if caller does not own the sandbox, undefined otherwise */
function checkOwnership(sessionManager: SessionManager, sandboxId: string, caller: string): Response | undefined {
	const session = sessionManager.getSession(sandboxId);
	if (session?.owner && session.owner !== caller) {
		return Response.json({ error: "forbidden", code: "FORBIDDEN" }, { status: 403 });
	}
	return undefined;
}

export function execRoutes(sessionManager: SessionManager): Hono<{ Variables: AuthVariables }> {
	const router = new Hono<{ Variables: AuthVariables }>();

	// POST /v1/sandboxes/:id/exec-sync — buffered (non-streaming) bash execution
	router.post("/:id/exec-sync", async (c) => {
		const sandboxId = c.req.param("id");
		const ownershipErr = checkOwnership(sessionManager, sandboxId, c.get("owner"));
		if (ownershipErr) return ownershipErr;

		let body: z.infer<typeof execBodySchema>;
		try {
			const raw = await c.req.json();
			const result = execBodySchema.safeParse(raw);
			if (!result.success) {
				const details = result.error.issues.map((i) => i.message);
				return c.json({ error: "validation_error", code: "INVALID_INPUT", details }, 400 as ContentfulStatusCode);
			}
			body = result.data;
		} catch {
			return c.json(
				{ error: "validation_error", code: "INVALID_INPUT", details: ["Invalid JSON body"] },
				400 as ContentfulStatusCode,
			);
		}

		const timeoutMs = Math.min(body.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

		// Convert user-controlled env keys to null-prototype object to prevent prototype pollution
		const env = body.env ? Object.assign(Object.create(null) as Record<string, string>, body.env) : undefined;

		type ExecSyncResult = { kind: "ok"; stdout: string; stderr: string; exitCode: number } | { kind: "timeout" };

		const execResult = await sessionManager.withExistingSession<ExecSyncResult>(sandboxId, async (session) => {
			const controller = new AbortController();
			let timedOut = false;

			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, timeoutMs);

			try {
				const result = await sessionManager.execWithRuntimeThrottle(session, body.script, {
					signal: controller.signal,
					cwd: body.cwd,
					env,
				});
				clearTimeout(timer);

				if (timedOut) {
					return { kind: "timeout" };
				}

				return {
					kind: "ok",
					stdout: result.stdout,
					stderr: result.stderr,
					exitCode: result.exitCode,
				};
			} catch (e) {
				clearTimeout(timer);
				if (timedOut) {
					return { kind: "timeout" };
				}
				throw e;
			}
		});

		if (execResult.kind === "timeout") {
			return c.json({ error: "timeout", code: "EXEC_TIMEOUT" }, 408 as ContentfulStatusCode);
		}

		return c.json({ stdout: execResult.stdout, stderr: execResult.stderr, exitCode: execResult.exitCode });
	});

	// POST /v1/sandboxes/:id/exec — SSE streaming bash execution
	router.post("/:id/exec", async (c) => {
		const sandboxId = c.req.param("id");
		const ownershipErr = checkOwnership(sessionManager, sandboxId, c.get("owner"));
		if (ownershipErr) return ownershipErr;

		let body: z.infer<typeof execBodySchema>;
		try {
			const raw = await c.req.json();
			const result = execBodySchema.safeParse(raw);
			if (!result.success) {
				const details = result.error.issues.map((i) => i.message);
				return c.json({ error: "validation_error", code: "INVALID_INPUT", details }, 400 as ContentfulStatusCode);
			}
			body = result.data;
		} catch {
			return c.json(
				{ error: "validation_error", code: "INVALID_INPUT", details: ["Invalid JSON body"] },
				400 as ContentfulStatusCode,
			);
		}

		const timeoutMs = Math.min(body.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
		const env = body.env ? Object.assign(Object.create(null) as Record<string, string>, body.env) : undefined;

		return streamSSE(c, async (stream) => {
			const controller = new AbortController();
			let timedOut = false;
			const startMs = Date.now();

			// Cancel on client disconnect
			c.req.raw.signal.addEventListener("abort", () => {
				controller.abort();
			});

			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, timeoutMs);

			await sessionManager.withExistingSession(sandboxId, async (session) => {
				try {
					const result = await sessionManager.execWithRuntimeThrottle(session, body.script, {
						signal: controller.signal,
						cwd: body.cwd,
						env,
					});
					clearTimeout(timer);

					if (timedOut) {
						await stream.writeSSE({
							event: "exit",
							data: JSON.stringify({ t: "exit", exitCode: -1, durationMs: Date.now() - startMs, error: "timeout" }),
						});
						return;
					}

					if (result.stdout) {
						await stream.writeSSE({
							event: "stdout",
							data: JSON.stringify({ t: "stdout", data: result.stdout }),
						});
					}
					if (result.stderr) {
						await stream.writeSSE({
							event: "stderr",
							data: JSON.stringify({ t: "stderr", data: result.stderr }),
						});
					}
					await stream.writeSSE({
						event: "exit",
						data: JSON.stringify({ t: "exit", exitCode: result.exitCode, durationMs: Date.now() - startMs }),
					});
				} catch (e) {
					clearTimeout(timer);
					if (timedOut) {
						await stream.writeSSE({
							event: "exit",
							data: JSON.stringify({ t: "exit", exitCode: -1, durationMs: Date.now() - startMs, error: "timeout" }),
						});
						return;
					}
					throw e;
				}
			});
		});
	});

	return router;
}
