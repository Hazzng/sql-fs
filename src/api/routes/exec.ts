/**
 * Execution routes.
 * US-068: POST /v1/sandboxes/:id/exec-sync — buffered execution
 * US-069: POST /v1/sandboxes/:id/exec — SSE streaming execution
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { AuthVariables } from "../auth.js";
import { type BatchScriptResult, executeBatch } from "../lib/batch-exec.js";
import { forbiddenResponse, isForbiddenError, withOwnedSessionOrRehydrate } from "../ownership.js";
import type { SessionManager } from "../session-manager.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_BATCH_SCRIPTS = 50;

const PLAINTEXT_TYPES = ["text/x-shellscript", "text/plain"];

const execBodySchema = z.object({
	script: z.string(),
	cwd: z.string().optional(),
	env: z.record(z.string(), z.string()).optional(),
	timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
	debug: z.boolean().optional(),
});

const batchExecBodySchema = z.object({
	scripts: z
		.array(
			z.object({
				id: z.string(),
				script: z.string(),
			}),
		)
		.min(1)
		.max(MAX_BATCH_SCRIPTS),
	timeoutMs: z.number().int().positive().optional(),
});

type ExecBody = z.infer<typeof execBodySchema>;

type ParseResult = { ok: true; body: ExecBody } | { ok: false; response: Response };

function contentTypeBase(header: string | undefined): string {
	return (header ?? "application/json").split(";")[0]!.trim().toLowerCase();
}

function wrapDebugScript(script: string): string {
	return `set -x\n${script}`;
}

async function parseExecBody(c: Context): Promise<ParseResult> {
	const ct = contentTypeBase(c.req.header("content-type"));

	if (PLAINTEXT_TYPES.includes(ct)) {
		const script = await c.req.text();
		if (script.length === 0) {
			return {
				ok: false,
				response: c.json(
					{ error: "validation_error", code: "INVALID_INPUT", details: ["Empty script body"] },
					400 as ContentfulStatusCode,
				),
			};
		}
		const rawTimeout = c.req.query("timeoutMs");
		let timeoutMs: number | undefined;
		if (rawTimeout !== undefined) {
			const n = Number(rawTimeout);
			if (!Number.isInteger(n) || n <= 0 || n > MAX_TIMEOUT_MS) {
				return {
					ok: false,
					response: c.json(
						{
							error: "validation_error",
							code: "INVALID_INPUT",
							details: [`timeoutMs must be a positive integer <= ${MAX_TIMEOUT_MS}`],
						},
						400 as ContentfulStatusCode,
					),
				};
			}
			timeoutMs = n;
		}
		return { ok: true, body: { script, timeoutMs } };
	}

	if (ct === "application/json") {
		try {
			const raw = await c.req.json();
			const result = execBodySchema.safeParse(raw);
			if (!result.success) {
				const details = result.error.issues.map((i) => i.message);
				return {
					ok: false,
					response: c.json({ error: "validation_error", code: "INVALID_INPUT", details }, 400 as ContentfulStatusCode),
				};
			}
			return { ok: true, body: result.data };
		} catch {
			return {
				ok: false,
				response: c.json(
					{ error: "validation_error", code: "INVALID_INPUT", details: ["Invalid JSON body"] },
					400 as ContentfulStatusCode,
				),
			};
		}
	}

	return {
		ok: false,
		response: c.json(
			{
				error: "unsupported_media_type",
				code: "UNSUPPORTED_MEDIA_TYPE",
				details: ["Content-Type must be application/json, text/plain, or text/x-shellscript"],
			},
			415 as ContentfulStatusCode,
		),
	};
}

export function execRoutes(sessionManager: SessionManager): Hono<{ Variables: AuthVariables }> {
	const router = new Hono<{ Variables: AuthVariables }>();

	// POST /v1/sandboxes/:id/exec-sync — buffered (non-streaming) bash execution
	router.post("/:id/exec-sync", async (c) => {
		const sandboxId = c.req.param("id");
		const tenant = c.get("tenant");
		const parsed = await parseExecBody(c);
		if (!parsed.ok) return parsed.response;
		const body = parsed.body;

		const timeoutMs = body.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const scriptToRun = body.debug ? wrapDebugScript(body.script) : body.script;

		const env = body.env ? Object.assign(Object.create(null) as Record<string, string>, body.env) : undefined;

		type ExecSyncResult =
			| { kind: "ok"; stdout: string; stderr: string; exitCode: number; durationMs: number }
			| { kind: "timeout"; durationMs: number };

		let execResult: ExecSyncResult;
		try {
			execResult = await withOwnedSessionOrRehydrate<ExecSyncResult>(
				sessionManager,
				tenant,
				sandboxId,
				c.get("owner"),
				async (session) => {
					const controller = new AbortController();
					let timedOut = false;
					const startMs = Date.now();

					const timer = setTimeout(() => {
						timedOut = true;
						controller.abort();
					}, timeoutMs);

					try {
						const result = await sessionManager.execWithRuntimeThrottle(session, scriptToRun, {
							signal: controller.signal,
							cwd: body.cwd,
							env,
						});
						clearTimeout(timer);

						if (timedOut) {
							return { kind: "timeout", durationMs: Date.now() - startMs };
						}

						return {
							kind: "ok",
							stdout: result.stdout,
							stderr: result.stderr,
							exitCode: result.exitCode,
							durationMs: Date.now() - startMs,
						};
					} catch (e) {
						clearTimeout(timer);
						if (timedOut) {
							return { kind: "timeout", durationMs: Date.now() - startMs };
						}
						throw e;
					}
				},
			);
		} catch (err) {
			if (isForbiddenError(err)) return forbiddenResponse();
			throw err;
		}

		if (execResult.kind === "timeout") {
			return c.json(
				{
					error: "timeout",
					code: "EXEC_TIMEOUT",
					timedOut: true,
					durationMs: execResult.durationMs,
				},
				408 as ContentfulStatusCode,
			);
		}

		return c.json({
			stdout: execResult.stdout,
			stderr: execResult.stderr,
			exitCode: execResult.exitCode,
			exitSignal: null,
			timedOut: false,
			durationMs: execResult.durationMs,
		});
	});

	// POST /v1/sandboxes/:id/exec — SSE streaming bash execution
	router.post("/:id/exec", async (c) => {
		const sandboxId = c.req.param("id");
		const tenant = c.get("tenant");
		const parsed = await parseExecBody(c);
		if (!parsed.ok) return parsed.response;
		const body = parsed.body;

		const timeoutMs = body.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const scriptToRun = body.debug ? wrapDebugScript(body.script) : body.script;
		const env = body.env ? Object.assign(Object.create(null) as Record<string, string>, body.env) : undefined;
		try {
			await withOwnedSessionOrRehydrate(sessionManager, tenant, sandboxId, c.get("owner"), async () => undefined);
		} catch (err) {
			if (isForbiddenError(err)) return forbiddenResponse();
			throw err;
		}

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

			await sessionManager.withExistingSession(tenant, sandboxId, async (session) => {
				try {
					const result = await sessionManager.execWithRuntimeThrottle(session, scriptToRun, {
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

	router.post("/:id/exec-sync-batch", async (c) => {
		const sandboxId = c.req.param("id");
		const tenant = c.get("tenant");
		let body: z.infer<typeof batchExecBodySchema>;
		try {
			const raw = await c.req.json();
			const result = batchExecBodySchema.safeParse(raw);
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

		const totalTimeoutMs = Math.min(body.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

		const disconnectController = new AbortController();
		if (c.req.raw.signal.aborted) {
			disconnectController.abort();
		} else {
			c.req.raw.signal.addEventListener("abort", () => disconnectController.abort(), { once: true });
		}

		let results: BatchScriptResult[];
		try {
			results = await withOwnedSessionOrRehydrate<BatchScriptResult[]>(
				sessionManager,
				tenant,
				sandboxId,
				c.get("owner"),
				async (session) =>
					executeBatch(sessionManager, session, body.scripts, totalTimeoutMs, disconnectController.signal),
			);
		} catch (err) {
			if (isForbiddenError(err)) return forbiddenResponse();
			throw err;
		}

		return c.json({ results });
	});

	return router;
}
