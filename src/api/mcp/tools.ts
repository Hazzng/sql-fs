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
import type { ICoherentFs } from "../../sql-fs/sql-fs.js";
import { clientSafeErrorMessage } from "../errors.js";
import { buildBulkIngestPayload } from "../ingest-manifest.js";
import { executeBatch } from "../lib/batch-exec.js";
import { positiveIntEnv } from "../lib/env.js";
import { withOwnedSessionOrRehydrate, withOwnedSessionRead } from "../ownership.js";
import type { SessionManager } from "../session-manager.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

// Audit H11 (#39, #44): bound fs_export so a large sandbox can't be materialized
// unboundedly into one in-memory JSON map / opened all at once.
const MAX_EXPORT_FILES = Number(process.env.MAX_EXPORT_FILES ?? "10000");
const MAX_EXPORT_BYTES = Number(process.env.MAX_EXPORT_BYTES ?? `${256 * 1024 * 1024}`);
/** Steps the export read loop, so it must be a positive integer (0/NaN would hang or no-op). */
const MAX_EXPORT_CONCURRENCY = positiveIntEnv(process.env.MAX_EXPORT_CONCURRENCY, 16);

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
				network: false,
			};
			try {
				const session = await sessionManager.getOrCreate(tenant, id, runtimeOptions, owner);
				session.name = name;
				await sessionManager.persistSandboxMeta(tenant, id, {
					owner,
					name,
					python: runtimeOptions.python,
					javascript: runtimeOptions.javascript,
					network: runtimeOptions.network,
				});
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ id, name, python: runtimeOptions.python, javascript: runtimeOptions.javascript }),
						},
					],
				};
			} catch (err) {
				// Sanitize: getOrCreate/persistSandboxMeta can surface raw SQL/driver
				// errors (audit H5) — never echo them to the MCP client.
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ ok: false, error: clientSafeErrorMessage(err, "internal error") }),
						},
					],
				};
			}
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
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ ok: false, error: clientSafeErrorMessage(err, "internal error") }),
						},
					],
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
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ ok: false, error: clientSafeErrorMessage(err, "internal error") }),
					},
				],
			};
		}
	});

	const bashExecDescription = [
		"Execute a bash script in a sandbox. Returns stdout, stderr, and exitCode.",
		"",
		"ATOMICITY: the sandbox lock is held for the entire duration of this call.",
		"All reads, computes, and writes that must be atomic MUST be in one script.",
		"Two separate bash_exec calls are two separate lock acquisitions — another",
		"caller can slip in between them. Example of the race:",
		"  call 1: cat balance.txt  → returns 100",
		"  [another agent writes 0 here]",
		"  call 2: echo 50 > balance.txt  → silently overwrites the other agent's write",
		"Fix: bundle read + compute + write into one script string.",
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
			readOnly: z
				.boolean()
				.optional()
				.describe(
					"When true, runs the script in read-only mode: parallel reads are unblocked across calls (no exclusive lock) and any mutating filesystem op is rejected with EREADONLY at the offending command.",
				),
		},
		async (args, extra) => {
			const timeoutMs = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
			const scriptToRun = args.debug ? `set -x\n${args.script}` : args.script;
			const runner = args.readOnly ? withOwnedSessionRead : withOwnedSessionOrRehydrate;

			try {
				const result = await runner(sessionManager, tenant, args.id, owner, async (session) => {
					const controller = new AbortController();
					let timedOut = false;
					const startMs = Date.now();

					const timer = setTimeout(() => {
						timedOut = true;
						controller.abort();
					}, timeoutMs);

					// Audit L4: abort the in-flight exec on MCP client disconnect rather
					// than running to the full timeout.
					const onDisconnect = (): void => controller.abort();
					extra.signal.addEventListener("abort", onDisconnect, { once: true });
					if (extra.signal.aborted) controller.abort();

					try {
						const execResult = await sessionManager.execWithRuntimeThrottle(session, scriptToRun, {
							signal: controller.signal,
						});
						clearTimeout(timer);
						extra.signal.removeEventListener("abort", onDisconnect);
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
						extra.signal.removeEventListener("abort", onDisconnect);
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
				if (code === "EREADONLY_VIOLATION") {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									stdout: "",
									stderr: "EREADONLY_VIOLATION: readOnly script attempted to mutate the filesystem",
									exitCode: 1,
									code: "EREADONLY_VIOLATION",
								}),
							},
						],
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ stdout: "", stderr: clientSafeErrorMessage(err, "internal error"), exitCode: 1 }),
						},
					],
				};
			}
		},
	);

	server.tool(
		"bash_exec_batch",
		[
			"Execute multiple bash scripts in a sandbox within a single request.",
			"Collapses N round-trips into 1 — ideal for exploration (find, grep, cat).",
			"",
			"When readOnly:true → scripts run IN PARALLEL (bounded fan-out, ordered results).",
			"When readOnly:false or omitted → scripts run SEQUENTIALLY and share shell state.",
			"",
			"Each result includes stdout, stderr, exitCode. A single timeout (ms) budget covers all scripts;",
			"set `timeout` to override the default. Remaining scripts get error: 'timeout' if the budget is exceeded.",
			"Max 50 scripts per batch.",
			"",
			"ATOMICITY (write path): the lock is acquired once for the entire batch — all scripts are atomic",
			"relative to other callers. If your logic requires reading state in one script and",
			"writing based on it in another, that is safe within a single batch call.",
			"It is NOT safe across two separate bash_exec or bash_exec_batch calls.",
		].join("\n"),
		{
			id: z.string(),
			scripts: z
				.array(z.object({ id: z.string(), script: z.string() }))
				.min(1)
				.max(50),
			timeout: z.number().int().positive().optional(),
			readOnly: z
				.boolean()
				.optional()
				.describe(
					"When true, runs all scripts in the batch in read-only mode: parallel reads are unblocked across calls and any mutating filesystem op is rejected with EREADONLY at the offending command.",
				),
		},
		async (args, extra) => {
			const totalTimeoutMs = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
			const runner = args.readOnly ? withOwnedSessionRead : withOwnedSessionOrRehydrate;

			const disconnectController = new AbortController();
			const onDisconnect = () => disconnectController.abort();
			extra.signal.addEventListener("abort", onDisconnect, { once: true });
			if (extra.signal.aborted) disconnectController.abort();

			try {
				const results = await runner(sessionManager, tenant, args.id, owner, async (session) =>
					executeBatch(sessionManager, session, args.scripts, totalTimeoutMs, disconnectController.signal),
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
				if (code === "EREADONLY_VIOLATION") {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									ok: false,
									code: "EREADONLY_VIOLATION",
									error: "readOnly script attempted to mutate the filesystem",
								}),
							},
						],
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
			} finally {
				extra.signal.removeEventListener("abort", onDisconnect);
			}
		},
	);

	server.tool(
		"fs_ingest",
		[
			"Seed files into a sandbox in a single bulk database insert.",
			"",
			"DEFAULT: use `paths` for any file that already exists on disk.",
			"EXCEPTION: use `files` only for small, dynamically generated content",
			"(e.g. a config snippet you just constructed) that has no host path.",
			"",
			"`paths` — HOST FILESYSTEM PATHS (default, fast, zero token cost):",
			"   { relativePath: absoluteHostPath }",
			"   The server reads the bytes directly from the host filesystem.",
			"   You emit only path strings — no file content ever appears in your output.",
			"   Use this for every file that exists on disk. There is no size limit.",
			'   Example: { "src/app.ts": "/Users/me/project/src/app.ts" }',
			"",
			"`files` — INLINE BASE64 (small generated content only):",
			"   { relativePath: base64EncodedBytes }",
			"   Every byte of file content becomes output tokens — extremely slow for",
			"   anything larger than a few KB. Only use this when the content does not",
			"   exist on disk and you are generating it on the fly.",
			'   For text: Buffer.from(text, "utf-8").toString("base64").',
			"",
			"Both params can be combined in one call. At least one must be non-empty.",
			"",
			"Keys MUST be relative paths (no leading `/`, no `..`, no null bytes).",
			"The server joins each key onto `basePath` to form the sandbox path.",
			"Missing parent directories are created automatically.",
			"",
			"`basePath`: absolute root inside the sandbox (default `/home/user`).",
			"Returns `{ ok: true, count: N }` on success, `{ ok: false, error }` on failure.",
		].join("\n"),
		{
			id: z.string().describe("Sandbox id returned by sandbox_create."),
			basePath: z
				.string()
				.optional()
				.describe("Absolute root path inside the sandbox to anchor relative file keys. Default: /home/user"),
			paths: z
				.record(z.string(), z.string())
				.optional()
				.describe(
					"DEFAULT. Map of relativePath → absolute host path. Server reads bytes directly — use for all files that exist on disk.",
				),
			files: z
				.record(z.string(), z.string())
				.optional()
				.describe(
					"EXCEPTION: small generated content only. Map of relativePath → base64 bytes. Avoid for anything >a few KB — every byte costs output tokens.",
				),
		},
		async (args) => {
			try {
				const result = await withOwnedSessionOrRehydrate(sessionManager, tenant, args.id, owner, async (session) => {
					// Authorization has passed — only now is it safe to touch the host
					// filesystem. `buildBulkIngestPayload` in `paths` mode reads arbitrary
					// host files off disk, so it MUST run AFTER the ownership check, never
					// before (audit H3 — pre-authz host-read + readability oracle).
					const built = await buildBulkIngestPayload({
						basePath: args.basePath ?? "/home/user",
						files: args.files,
						paths: args.paths,
					});
					if (!built.ok) {
						return { ok: false as const, error: built.errors.join("; ") };
					}
					const fs = session.fs as ICoherentFs;
					if (typeof fs.bulkIngest !== "function") {
						throw Object.assign(new Error("bulkIngest not supported by this fs backend"), { code: "ENOTSUP" });
					}
					await fs.bulkIngest(built.bulkFiles);
					return { ok: true as const, count: built.bulkFiles.length };
				});

				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
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
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ ok: false, error: clientSafeErrorMessage(err, "internal error") }),
						},
					],
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
						if (candidates.length > MAX_EXPORT_FILES) {
							throw Object.assign(new Error(`export exceeds file limit (${MAX_EXPORT_FILES})`), {
								code: "EEXPORT_TOO_LARGE",
							});
						}
						let totalBytes = 0;
						// Read in bounded-concurrency batches with a running byte cap so a large
						// sandbox can't open every file at once or blow up memory (audit H11).
						for (let i = 0; i < candidates.length; i += MAX_EXPORT_CONCURRENCY) {
							const batch = candidates.slice(i, i + MAX_EXPORT_CONCURRENCY);
							await Promise.all(
								batch.map(async (absPath) => {
									try {
										const buf = await session.fs.readFileBuffer(absPath);
										totalBytes += buf.byteLength;
										if (totalBytes > MAX_EXPORT_BYTES) {
											throw Object.assign(new Error(`export exceeds byte limit (${MAX_EXPORT_BYTES})`), {
												code: "EEXPORT_TOO_LARGE",
											});
										}
										const relativePath = absPath.slice(prefix.length);
										try {
											result[relativePath] = utf8Decoder.decode(buf);
										} catch {
											result[relativePath] =
												`data:application/octet-stream;base64,${Buffer.from(buf).toString("base64")}`;
										}
									} catch (e) {
										const code = (e as Error & { code?: string }).code;
										if (code === "EEXPORT_TOO_LARGE") throw e;
										// EISDIR is expected — directories cannot be read as files
										if (code !== "EISDIR") {
											readErrors.push(absPath);
										}
									}
								}),
							);
						}

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
				if (code === "EEXPORT_TOO_LARGE") {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									ok: false,
									code: "EEXPORT_TOO_LARGE",
									error: "export too large; narrow with basePath",
								}),
							},
						],
					};
				}
				const message = code === "ENOENT" ? "sandbox not found" : clientSafeErrorMessage(err, "internal error");
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
				};
			}
		},
	);
}
