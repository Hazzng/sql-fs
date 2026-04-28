/**
 * MCP tool definitions and handlers.
 * US-078: MCP tool — sandbox_create
 * US-079: MCP tool — sandbox_delete
 * US-080: MCP tool — bash_exec
 * US-086: MCP tool — fs_ingest
 * US-087: MCP tool — fs_export
 */

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ICoherentFs } from "../../fs/sql-fs/sql-fs.js";
import type { BulkIngestFile } from "../../fs/sql-fs/types.js";
import { isValidBase64, isValidBasePath, isValidRelativePath } from "../ingest-validation.js";
import { executeBatch } from "../lib/batch-exec.js";
import { withOwnedSessionOrRehydrate } from "../ownership.js";
import type { SessionManager } from "../session-manager.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

export function registerTools(server: McpServer, sessionManager: SessionManager, owner: string, tenant: string): void {
	server.tool(
		"sandbox_create",
		"Create an isolated bash sandbox with a virtual filesystem. Optional runtime flags opt in to python3/python (CPython WASM, stdlib only) and js-exec/node (QuickJS WASM) commands. Optional name for human-readable identification.",
		{
			name: z.string().max(255).optional().describe("Human-readable name for the sandbox"),
			python: z.boolean().optional(),
			javascript: z.boolean().optional(),
		},
		async (args) => {
			const id = randomUUID();
			const name = args.name ?? null;
			const runtimeOptions = {
				python: args.python ?? false,
				javascript: args.javascript ?? false,
			};
			const session = await sessionManager.getOrCreate(tenant, id, runtimeOptions, owner);
			session.name = name;
			await sessionManager.persistSandboxMeta(tenant, id, {
				owner,
				name,
				python: runtimeOptions.python,
				javascript: runtimeOptions.javascript,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ id, name, python: runtimeOptions.python, javascript: runtimeOptions.javascript }),
					},
				],
			};
		},
	);

	server.tool(
		"sandbox_list",
		"List all sandboxes owned by the current user. Returns id, name, owner, createdAt, and runtime flags for each sandbox.",
		{},
		async () => {
			try {
				const sandboxes = await sessionManager.listSandboxes(tenant, owner);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								sandboxes: sandboxes.map((s) => ({
									id: s.id,
									name: s.name,
									owner: s.owner,
									createdAt: s.createdAt.toISOString(),
									python: s.python,
									javascript: s.javascript,
								})),
							}),
						},
					],
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
				};
			}
		},
	);

	server.tool("sandbox_delete", "Delete a sandbox and all its files", { id: z.string() }, async (args) => {
		try {
			await withOwnedSessionOrRehydrate(sessionManager, tenant, args.id, owner, async () => undefined);
			const existed = await sessionManager.destroy(tenant, args.id);
			if (!existed) {
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "sandbox not found" }) }],
				};
			}
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
			};
		} catch (err) {
			const code = (err as Error & { code?: string }).code;
			if (code === "FORBIDDEN") {
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "forbidden" }) }],
				};
			}
			if (code === "ENOENT") {
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "sandbox not found" }) }],
				};
			}
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
			};
		}
	});

	const bashExecDescription = [
		"Execute a bash script in a sandbox. Returns stdout, stderr, and exitCode.",
		"",
		"Supported: cat, echo, ls, find, mkdir, rm, mv, cp, touch, chmod, stat, grep, sed, awk,",
		"sort, wc, head, tail, cut, tr, uniq, diff, pipes (|), redirects (>, >>, <),",
		"environment variables, conditionals (if/else), loops (for/while), functions, arithmetic,",
		"base64, md5sum, sha256sum, tar, gzip, jq, yq, xan, sqlite3.",
		"",
		"NOT supported: curl/wget (no network), apt/pip/npm (no package managers),",
		"vi/vim/nano (no interactive), background jobs (&), kill/ps/top (no process control),",
		"/proc /sys /dev (no special filesystems), ln -s (symlinks off by default),",
		"gcc/make/rustc (no compilers), network access of any kind.",
		"",
		"Optional runtimes (only if sandbox was created with python:true or javascript:true):",
		"- python3 / python — CPython WASM, stdlib only (no pip, no network, no os.system).",
		"  Concurrent python3 executions across the server are capped to prevent OOM; excess",
		"  scripts queue until a slot frees.",
		"- js-exec / node — QuickJS WASM. TypeScript supported. No npm, no network.",
	].join("\n");

	server.tool(
		"bash_exec",
		bashExecDescription,
		{
			id: z.string(),
			script: z.string(),
			timeout: z.number().int().positive().optional(),
			debug: z.boolean().optional().describe("When true, prepends 'set -x' for command-level tracing in stderr"),
		},
		async (args) => {
			const timeoutMs = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
			const scriptToRun = args.debug ? `set -x\n${args.script}` : args.script;

			try {
				const result = await withOwnedSessionOrRehydrate(sessionManager, tenant, args.id, owner, async (session) => {
					const controller = new AbortController();
					let timedOut = false;
					const startMs = Date.now();

					const timer = setTimeout(() => {
						timedOut = true;
						controller.abort();
					}, timeoutMs);

					try {
						const execResult = await sessionManager.execWithRuntimeThrottle(session, scriptToRun, {
							signal: controller.signal,
						});
						clearTimeout(timer);
						if (timedOut) {
							return {
								stdout: "",
								stderr: "timeout",
								exitCode: -1,
								exitSignal: null as string | null,
								timedOut: true,
								durationMs: Date.now() - startMs,
							};
						}
						return {
							stdout: execResult.stdout,
							stderr: execResult.stderr,
							exitCode: execResult.exitCode,
							exitSignal: null as string | null,
							timedOut: false,
							durationMs: Date.now() - startMs,
						};
					} catch (e) {
						clearTimeout(timer);
						if (timedOut) {
							return {
								stdout: "",
								stderr: "timeout",
								exitCode: -1,
								exitSignal: null as string | null,
								timedOut: true,
								durationMs: Date.now() - startMs,
							};
						}
						throw e;
					}
				});

				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (err) {
				const code = (err as Error & { code?: string }).code;
				if (code === "FORBIDDEN") {
					return {
						content: [
							{ type: "text" as const, text: JSON.stringify({ stdout: "", stderr: "forbidden", exitCode: 1 }) },
						],
					};
				}
				if (code === "ENOENT") {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ stdout: "", stderr: "sandbox not found", exitCode: 1 }),
							},
						],
					};
				}
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ stdout: "", stderr: message, exitCode: 1 }) }],
				};
			}
		},
	);

	server.tool(
		"bash_exec_batch",
		[
			"Execute multiple bash scripts in a sandbox sequentially within a single request.",
			"Collapses N round-trips into 1 — ideal for exploration (find, grep, cat).",
			"Scripts share shell state and run in order. Each result includes stdout, stderr, exitCode.",
			"A single timeout (ms) budget covers all scripts; set `timeout` to override the default. Remaining scripts get error: 'timeout' if the budget is exceeded.",
			"Max 50 scripts per batch.",
		].join("\n"),
		{
			id: z.string(),
			scripts: z
				.array(z.object({ id: z.string(), script: z.string() }))
				.min(1)
				.max(50),
			timeout: z.number().int().positive().optional(),
		},
		async (args) => {
			const totalTimeoutMs = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

			try {
				const results = await withOwnedSessionOrRehydrate(sessionManager, tenant, args.id, owner, async (session) =>
					executeBatch(sessionManager, session, args.scripts, totalTimeoutMs),
				);

				return {
					content: [{ type: "text" as const, text: JSON.stringify({ results }) }],
				};
			} catch (err) {
				const code = (err as Error & { code?: string }).code;
				if (code === "FORBIDDEN") {
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "forbidden" }) }],
					};
				}
				if (code === "ENOENT") {
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "sandbox not found" }) }],
					};
				}
				console.error(
					JSON.stringify({
						event: "bash_exec_batch_failed",
						sandboxId: args.id,
						tenant,
						error: err instanceof Error ? err.message : String(err),
					}),
				);
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "internal error" }) }],
				};
			}
		},
	);

	server.tool(
		"fs_ingest",
		[
			"Upload one or more files into a sandbox in a single bulk database insert.",
			"Use this before `bash_exec` to seed project files. This is the only ingest path",
			"(the previous tar.gz route was removed). Internally the server commits the entire",
			"batch with one multi-row INSERT — uploading 100+ files typically completes in",
			"under a second.",
			"",
			"INPUT PREPARATION (important):",
			"• Each value in `files` MUST be the file's bytes encoded as base64 — not raw text.",
			'  For text files: `Buffer.from(textContent, "utf-8").toString("base64")`.',
			"  For binary files: read the bytes and base64-encode them.",
			"• Each key in `files` MUST be a relative path — no leading `/`, no `..` segments,",
			"  no null bytes. The server joins it onto `basePath` to form the absolute path.",
			"• `basePath` is the absolute root inside the sandbox (default `/home/user`).",
			"  Missing parent directories under `basePath` are created automatically.",
			"",
			"Returns `{ ok: true, count: N }` on success. On failure returns `{ ok: false, error }`.",
		].join("\n"),
		{
			id: z.string().describe("Sandbox id returned by sandbox_create."),
			basePath: z
				.string()
				.optional()
				.describe("Absolute root path inside the sandbox to anchor relative file keys. Default: /home/user"),
			files: z
				.record(z.string(), z.string())
				.describe(
					"Map of relativePath → base64-encoded file bytes. Keys are relative paths under basePath; values must be base64 (use Buffer.from(content).toString('base64')).",
				),
		},
		async (args) => {
			const basePath = args.basePath ?? "/home/user";

			// Reuse the same basePath guard the HTTP /ingest-files route uses
			// so the two ingest surfaces share one contract. Inputs like
			// "tmp", "./proj", "/home/user/../tmp" must not silently normalize
			// to a different destination than the caller supplied.
			if (!isValidBasePath(basePath)) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ ok: false, error: "basePath must be a safe absolute path" }),
						},
					],
				};
			}

			// Validate paths and base64 in one pass before any DB work.
			// `Buffer.from(_, "base64")` silently decodes garbage to corrupt bytes,
			// so we reject malformed values up front rather than persist them.
			const bulkFiles: BulkIngestFile[] = [];
			const invalidPaths: string[] = [];
			const invalidBase64: string[] = [];
			for (const [rel, b64] of Object.entries(args.files)) {
				if (!isValidRelativePath(rel)) {
					invalidPaths.push(rel);
					continue;
				}
				if (!isValidBase64(b64)) {
					invalidBase64.push(rel);
					continue;
				}
				bulkFiles.push({
					path: `${basePath}/${rel}`,
					content: new Uint8Array(Buffer.from(b64, "base64")),
					mode: 0o644,
				});
			}
			if (invalidPaths.length > 0 || invalidBase64.length > 0) {
				const parts: string[] = [];
				if (invalidPaths.length > 0) parts.push(`invalid paths: ${invalidPaths.join(", ")}`);
				if (invalidBase64.length > 0) parts.push(`invalid base64: ${invalidBase64.join(", ")}`);
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: parts.join("; ") }) }],
				};
			}

			try {
				await withOwnedSessionOrRehydrate(sessionManager, tenant, args.id, owner, async (session) => {
					const fs = session.fs as ICoherentFs;
					if (typeof fs.bulkIngest !== "function") {
						throw Object.assign(new Error("bulkIngest not supported by this fs backend"), { code: "ENOTSUP" });
					}
					await fs.bulkIngest(bulkFiles);
				});

				return {
					content: [{ type: "text" as const, text: JSON.stringify({ ok: true, count: bulkFiles.length }) }],
				};
			} catch (err) {
				const code = (err as Error & { code?: string }).code;
				if (code === "FORBIDDEN") {
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "forbidden" }) }],
					};
				}
				if (code === "ENOENT") {
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "sandbox not found" }) }],
					};
				}
				// `ENOTSUP` here means the FS backend has no `bulkIngest` — only reachable
				// from a misconfigured replica. Don't echo the internal "bulkIngest not
				// supported by this fs backend" message back to the MCP client; log and
				// return a generic internal error, mirroring the HTTP route.
				if (code === "ENOTSUP") {
					console.error(
						JSON.stringify({
							event: "fs_ingest_backend_unsupported",
							sandboxId: args.id,
							tenant,
						}),
					);
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "internal error" }) }],
					};
				}
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
				};
			}
		},
	);

	server.tool(
		"fs_export",
		"Download files from sandbox as JSON map",
		{
			id: z.string(),
			basePath: z.string().optional(),
		},
		async (args) => {
			const basePath = args.basePath ?? "/home/user";
			const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

			try {
				const { files, errors } = await withOwnedSessionOrRehydrate(
					sessionManager,
					tenant,
					args.id,
					owner,
					async (session) => {
						const allPaths = session.fs.getAllPaths();
						const prefix = basePath.endsWith("/") ? basePath : `${basePath}/`;
						const result: Record<string, string> = Object.create(null);
						const readErrors: string[] = [];

						const candidates = allPaths.filter((p) => p.startsWith(prefix));
						await Promise.all(
							candidates.map(async (absPath) => {
								try {
									const buf = await session.fs.readFileBuffer(absPath);
									const relativePath = absPath.slice(prefix.length);
									try {
										result[relativePath] = utf8Decoder.decode(buf);
									} catch {
										result[relativePath] =
											`data:application/octet-stream;base64,${Buffer.from(buf).toString("base64")}`;
									}
								} catch (e) {
									const code = (e as Error & { code?: string }).code;
									// EISDIR is expected — directories cannot be read as files
									if (code !== "EISDIR") {
										readErrors.push(absPath);
									}
								}
							}),
						);

						return { files: result, errors: readErrors };
					},
				);

				if (errors.length > 0) {
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ files, errors }) }],
					};
				}

				return {
					content: [{ type: "text" as const, text: JSON.stringify({ files }) }],
				};
			} catch (err) {
				const code = (err as Error & { code?: string }).code;
				if (code === "FORBIDDEN") {
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "forbidden" }) }],
					};
				}
				const message = code === "ENOENT" ? "sandbox not found" : err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
				};
			}
		},
	);
}
