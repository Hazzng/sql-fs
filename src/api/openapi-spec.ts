/**
 * OpenAPI 3.0 specification for the VirtualFS API.
 * Served at GET /openapi.json; Swagger UI at GET /docs.
 */

const errorSchema = {
	type: "object",
	properties: {
		error: { type: "string", example: "not_found" },
		code: { type: "string", example: "ENOENT" },
		details: { type: "array", items: { type: "string" } },
	},
	required: ["error", "code"],
} as const;

const sandboxSchema = {
	type: "object",
	properties: {
		id: { type: "string", format: "uuid", example: "550e8400-e29b-41d4-a716-446655440000" },
		name: { type: "string", nullable: true, example: "my-project-sandbox" },
		owner: { type: "string", example: "alice" },
		createdAt: { type: "string", format: "date-time" },
		python: { type: "boolean", example: false },
		javascript: { type: "boolean", example: false },
	},
	required: ["id", "name", "owner", "createdAt", "python", "javascript"],
} as const;

const sandboxInfoSchema = {
	type: "object",
	properties: {
		id: { type: "string", format: "uuid" },
		name: { type: "string", nullable: true },
		owner: { type: "string" },
		createdAt: { type: "string", format: "date-time" },
		lastUsedAt: { type: "string", format: "date-time" },
	},
	required: ["id", "name", "owner", "createdAt", "lastUsedAt"],
} as const;

const treeEntrySchema = {
	type: "object",
	properties: {
		path: { type: "string", example: "/home/user/main.py" },
		kind: { type: "string", enum: ["file", "dir", "symlink"] },
		size: { type: "integer", example: 1024 },
		mtime: { type: "string", format: "date-time" },
	},
	required: ["path", "kind", "size", "mtime"],
} as const;

const execBodySchema = {
	type: "object",
	properties: {
		script: { type: "string", example: "echo hello" },
		cwd: { type: "string", example: "/home/user" },
		env: { type: "object", additionalProperties: { type: "string" }, example: { MY_VAR: "value" } },
		timeoutMs: { type: "integer", example: 30000, minimum: 1, maximum: 300000 },
		debug: {
			type: "boolean",
			description: "When true, prepends 'set -x' for command-level tracing in stderr.",
		},
		readOnly: {
			type: "boolean",
			description:
				"When true, runs the script in read-only mode: parallel reads against the same sandbox are unblocked (no exclusive lock), and any mutating filesystem op is rejected with EREADONLY at the offending command. If the script attempts a write, the request fails with HTTP 422 EREADONLY_VIOLATION after the script returns. Single-replica only: cross-replica writers are still serialized via the distributed exec lock.",
		},
		retryOn5xx: {
			type: "boolean",
			description:
				"Caller hint that the script is idempotent and safe to retry on transient 5xx (network blip, ERUNTIME_BUSY, ESESSIONCLOSING). Currently accepted and ignored server-side; client SDKs use it to enable client-side retry. Reserved for future server-side retry of worker-crash exceptions. Never causes retry on 503 ECOHERENCE for write execs (the write committed; only the cache invalidation publish failed).",
		},
	},
	required: ["script"],
} as const;

const sandboxIdParam = {
	name: "id",
	in: "path",
	required: true,
	description: "Sandbox UUID",
	schema: { type: "string", format: "uuid" },
} as const;

const bearerAuth = { bearerAuth: [] };

export const openapiSpec = {
	openapi: "3.0.0",
	info: {
		title: "VirtualFS API",
		version: "0.4.1",
		description: "Persistent filesystem backend + HTTP/MCP API for just-bash sandboxes. Backed by Postgres.",
	},
	servers: [{ url: "/v1", description: "API v1" }],
	security: [bearerAuth],
	components: {
		securitySchemes: {
			bearerAuth: {
				type: "http",
				scheme: "bearer",
				bearerFormat: "JWT",
				description: "JWT issued via POST /v1/auth/bootstrap or POST /v1/auth/admin",
			},
		},
		schemas: {
			Error: errorSchema,
			Sandbox: sandboxSchema,
			SandboxInfo: sandboxInfoSchema,
			TreeEntry: treeEntrySchema,
		},
	},
	paths: {
		// ── Auth (bootstrap, unauthenticated) ─────────────────────────────────────
		"/auth/bootstrap": {
			post: {
				tags: ["Auth"],
				summary: "Bootstrap JWT from AUTH_SECRET",
				description:
					"Exchange the server's `AUTH_SECRET` (sent in `X-Auth-Secret`) for a signed JWT. Unauthenticated — no Bearer token required. Use this when an external client only has `AUTH_SECRET` and cannot reach the CLI (`pnpm token:create`) or the admin endpoint (which itself requires a JWT).",
				security: [],
				parameters: [
					{
						name: "X-Auth-Secret",
						in: "header",
						required: true,
						schema: { type: "string" },
						description: "Must match the server-side AUTH_SECRET env var (constant-time compared).",
					},
				],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									sub: { type: "string", example: "agent-001", description: "Token subject (owner identity)" },
									tenant: {
										type: "string",
										description: "Optional tenant id; omitted = default tenant",
									},
									expiresIn: {
										type: "string",
										enum: ["24h", "30d", "1y", "never"],
										default: "30d",
										description: "Token lifetime",
									},
								},
								required: ["sub"],
							},
						},
					},
				},
				responses: {
					"201": {
						description: "Token created",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										token: { type: "string" },
										sub: { type: "string" },
										tenant: { type: "string", nullable: true },
										expiresAt: { type: "string", format: "date-time", nullable: true },
									},
									required: ["token", "sub"],
								},
							},
						},
					},
					"400": {
						description: "Invalid body or unknown tenant",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"403": {
						description: "Wrong or missing X-Auth-Secret",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"429": {
						description:
							"Rate limited. The bootstrap endpoint is per-IP rate limited (defaults: 5 requests / 60s). The `Retry-After` response header gives seconds until the next request is allowed.",
						headers: {
							"Retry-After": { schema: { type: "integer" }, description: "Seconds until the next request is allowed" },
						},
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"500": {
						description: "AUTH_SECRET not configured on the server",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
				},
			},
		},

		// ── Admin ─────────────────────────────────────────────────────────────────
		"/auth/admin": {
			post: {
				tags: ["Auth"],
				summary: "Create JWT (admin)",
				description: "Mint a signed JWT for a given subject. Requires `X-Admin-Secret` header.",
				security: [bearerAuth],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									sub: { type: "string", example: "alice", description: "Token subject (owner identity)" },
									expiresIn: {
										type: "string",
										enum: ["24h", "30d", "1y", "never"],
										default: "30d",
										description: "Token lifetime",
									},
								},
								required: ["sub"],
							},
						},
					},
				},
				parameters: [
					{
						name: "X-Admin-Secret",
						in: "header",
						required: true,
						schema: { type: "string" },
						description: "Must match the server-side ADMIN_SECRET env var",
					},
				],
				responses: {
					"201": {
						description: "Token created",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										token: { type: "string" },
										sub: { type: "string" },
										expiresAt: { type: "string", format: "date-time", nullable: true },
									},
									required: ["token", "sub"],
								},
							},
						},
					},
					"403": {
						description: "Wrong or missing X-Admin-Secret",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"429": {
						description:
							"Rate limited. The admin endpoint is per-IP and per-Bearer-`sub` rate limited (defaults: 5 requests / 60s). Either key tripping returns 429; the `Retry-After` response header gives seconds until the next request is allowed.",
						headers: {
							"Retry-After": { schema: { type: "integer" }, description: "Seconds until the next request is allowed" },
						},
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"500": {
						description: "ADMIN_SECRET or AUTH_SECRET not configured",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
				},
			},
		},

		// ── Sandboxes ─────────────────────────────────────────────────────────────
		"/sandboxes": {
			get: {
				tags: ["Sandboxes"],
				summary: "List sandboxes",
				description: "List all sandboxes owned by the authenticated user.",
				responses: {
					"200": {
						description: "Sandbox list",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										sandboxes: {
											type: "array",
											items: { $ref: "#/components/schemas/Sandbox" },
										},
									},
									required: ["sandboxes"],
								},
							},
						},
					},
				},
			},
			post: {
				tags: ["Sandboxes"],
				summary: "Create sandbox",
				description: "Create a new isolated bash sandbox. Optionally seed with files and enable Python/JS runtimes.",
				requestBody: {
					required: false,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									name: {
										type: "string",
										maxLength: 255,
										description: "Human-readable name for the sandbox",
									},
									env: {
										type: "object",
										additionalProperties: { type: "string" },
										description: "Environment variables available in the sandbox",
									},
									files: {
										type: "object",
										additionalProperties: { type: "string" },
										description: "Initial files to write (path → content)",
									},
									python: { type: "boolean", default: false, description: "Enable CPython WASM runtime" },
									javascript: { type: "boolean", default: false, description: "Enable QuickJS runtime" },
								},
							},
						},
					},
				},
				responses: {
					"201": {
						description: "Sandbox created",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Sandbox" } } },
					},
					"400": {
						description: "Validation error",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
				},
			},
		},

		"/sandboxes/{id}": {
			get: {
				tags: ["Sandboxes"],
				summary: "Get sandbox",
				parameters: [sandboxIdParam],
				responses: {
					"200": {
						description: "Sandbox info",
						content: { "application/json": { schema: { $ref: "#/components/schemas/SandboxInfo" } } },
					},
					"403": {
						description: "Caller does not own sandbox",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"404": {
						description: "Sandbox not found",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
				},
			},
			delete: {
				tags: ["Sandboxes"],
				summary: "Delete sandbox",
				parameters: [sandboxIdParam],
				responses: {
					"204": { description: "Deleted" },
					"403": {
						description: "Forbidden",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"404": {
						description: "Not found",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
				},
			},
		},

		// ── Files ─────────────────────────────────────────────────────────────────
		"/sandboxes/{id}/files/{path}": {
			get: {
				tags: ["Files"],
				summary: "Read file",
				description:
					"`path` is a slash-separated filesystem path (e.g. `home/user/main.py`). The leading `/` is prepended server-side. Returns raw file bytes with a `Content-Type` inferred from the extension and an `X-FS-Stat` header (JSON: `{ kind, mode, size, mtime }`).",
				parameters: [
					sandboxIdParam,
					{
						name: "path",
						in: "path",
						required: true,
						description: "File path inside the sandbox (without leading slash)",
						schema: { type: "string", example: "home/user/main.py" },
					},
				],
				responses: {
					"200": {
						description: "File content",
						headers: {
							"X-FS-Stat": {
								description: "JSON: { kind, mode, size, mtime }",
								schema: { type: "string" },
							},
						},
						content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
					},
					"400": {
						description: "Path is a directory",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"403": {
						description: "Forbidden",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"404": {
						description: "File not found",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
				},
			},
			put: {
				tags: ["Files"],
				summary: "Write file",
				description: "Write raw bytes to `path`. Parent directories are created automatically.",
				parameters: [
					sandboxIdParam,
					{
						name: "path",
						in: "path",
						required: true,
						description: "Destination path inside the sandbox (without leading slash)",
						schema: { type: "string" },
					},
				],
				requestBody: {
					required: true,
					content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
				},
				responses: {
					"204": { description: "Written" },
					"403": {
						description: "Forbidden",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"404": {
						description: "Sandbox not found",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
				},
			},
			delete: {
				tags: ["Files"],
				summary: "Delete file or directory",
				parameters: [
					sandboxIdParam,
					{
						name: "path",
						in: "path",
						required: true,
						description: "Path to delete (without leading slash)",
						schema: { type: "string" },
					},
					{
						name: "recursive",
						in: "query",
						required: false,
						description: "Delete directory contents recursively",
						schema: { type: "boolean", default: false },
					},
				],
				responses: {
					"204": { description: "Deleted" },
					"403": {
						description: "Forbidden",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"404": {
						description: "Not found",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"409": {
						description: "Directory not empty (and recursive not set)",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
				},
			},
		},

		"/sandboxes/{id}/writeFiles": {
			post: {
				tags: ["Files"],
				summary: "Bulk write files",
				description: "Write multiple files in one request. Parent directories are created automatically.",
				parameters: [sandboxIdParam],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									files: {
										type: "object",
										additionalProperties: { type: "string" },
										example: { "/home/user/a.txt": "hello", "/home/user/b.txt": "world" },
									},
								},
								required: ["files"],
							},
						},
					},
				},
				responses: {
					"204": { description: "All files written" },
					"400": {
						description: "Validation error",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"403": {
						description: "Forbidden",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"404": {
						description: "Sandbox not found",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
				},
			},
		},

		"/sandboxes/{id}/mkdir": {
			post: {
				tags: ["Files"],
				summary: "Create directory",
				parameters: [sandboxIdParam],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									path: { type: "string", example: "/home/user/project" },
									recursive: { type: "boolean", default: false },
								},
								required: ["path"],
							},
						},
					},
				},
				responses: {
					"204": { description: "Created" },
					"400": {
						description: "Validation error",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"403": {
						description: "Forbidden",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"404": {
						description: "Sandbox not found",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"409": {
						description: "Already exists",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
				},
			},
		},

		"/sandboxes/{id}/tree": {
			get: {
				tags: ["Files"],
				summary: "List file tree",
				description: "Returns all entries under `prefix` up to `depth` levels deep.",
				parameters: [
					sandboxIdParam,
					{
						name: "prefix",
						in: "query",
						required: false,
						description: "Path prefix to filter (default `/`)",
						schema: { type: "string", default: "/" },
					},
					{
						name: "depth",
						in: "query",
						required: false,
						description: "Max depth relative to prefix (omit for unlimited)",
						schema: { type: "integer", minimum: 1 },
					},
				],
				responses: {
					"200": {
						description: "List of entries",
						content: {
							"application/json": {
								schema: { type: "array", items: { $ref: "#/components/schemas/TreeEntry" } },
							},
						},
					},
					"400": {
						description: "Validation error",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"403": {
						description: "Forbidden",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"404": {
						description: "Sandbox not found",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
				},
			},
		},

		// ── Exec ──────────────────────────────────────────────────────────────────
		"/sandboxes/{id}/exec-sync": {
			post: {
				tags: ["Exec"],
				summary: "Execute script (buffered)",
				description:
					"Run a bash script and return stdout/stderr/exitCode once complete. Accepts JSON (`application/json`) with `{ script, cwd?, env?, timeoutMs? }`, or a raw script body with `text/plain` or `text/x-shellscript` (no JSON encoding needed). When using plaintext, `timeoutMs` can be set via query parameter.",
				parameters: [
					sandboxIdParam,
					{
						name: "timeoutMs",
						in: "query",
						required: false,
						description: "Execution timeout in ms (only used with text/plain or text/x-shellscript content types)",
						schema: { type: "integer", minimum: 1, maximum: 300000 },
					},
				],
				requestBody: {
					required: true,
					content: {
						"application/json": { schema: execBodySchema },
						"text/x-shellscript": {
							schema: { type: "string", example: "find /home/user -type f | sort" },
						},
						"text/plain": {
							schema: { type: "string", example: "echo hello" },
						},
					},
				},
				responses: {
					"200": {
						description: "Execution result",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										stdout: { type: "string" },
										stderr: { type: "string" },
										exitCode: { type: "integer" },
										exitSignal: { type: "string", nullable: true },
										timedOut: { type: "boolean" },
										durationMs: { type: "integer" },
									},
									required: ["stdout", "stderr", "exitCode", "exitSignal", "timedOut", "durationMs"],
								},
							},
						},
					},
					"400": {
						description: "Validation error",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"403": {
						description: "Forbidden",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"404": {
						description: "Sandbox not found",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"408": {
						description: "Execution timed out",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										error: { type: "string" },
										code: { type: "string" },
										timedOut: { type: "boolean" },
										durationMs: { type: "integer" },
									},
									required: ["error", "code", "timedOut", "durationMs"],
								},
							},
						},
					},
					"422": {
						description: "readOnly script attempted to mutate the filesystem",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
				},
			},
		},

		"/sandboxes/{id}/exec-sync-batch": {
			post: {
				tags: ["Exec"],
				summary: "Execute scripts in batch (sequential)",
				description:
					"Run multiple bash scripts sequentially in a single HTTP round-trip. Eliminates N-1 round-trips for independent exploration work (find, grep, cat). A single timeoutMs budget covers all scripts; if exhausted, remaining scripts receive exitCode -1 with error 'timeout'. Max 50 scripts per batch.",
				parameters: [sandboxIdParam],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									scripts: {
										type: "array",
										items: {
											type: "object",
											properties: {
												id: { type: "string", example: "tree" },
												script: { type: "string", example: "find /home/user -type f | sort" },
											},
											required: ["id", "script"],
										},
										minItems: 1,
										maxItems: 50,
									},
									timeoutMs: { type: "integer", example: 30000, minimum: 1, maximum: 300000 },
									readOnly: {
										type: "boolean",
										description:
											"When true, runs all scripts in the batch in read-only mode: parallel reads are unblocked across calls and any mutating filesystem op is rejected with EREADONLY at the offending command. Returns HTTP 422 EREADONLY_VIOLATION if any script attempts a write.",
									},
									retryOn5xx: {
										type: "boolean",
										description:
											"Caller hint that every script in the batch is idempotent and safe to retry. Currently accepted and ignored server-side; client SDKs use it to enable client-side retry of the whole batch.",
									},
								},
								required: ["scripts"],
							},
						},
					},
				},
				responses: {
					"200": {
						description: "Batch execution results",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										results: {
											type: "array",
											items: {
												type: "object",
												properties: {
													id: { type: "string" },
													stdout: { type: "string" },
													stderr: { type: "string" },
													exitCode: { type: "integer" },
													durationMs: { type: "integer" },
													error: { type: "string" },
												},
												required: ["id", "stdout", "stderr", "exitCode", "durationMs"],
											},
										},
									},
									required: ["results"],
								},
							},
						},
					},
					"400": {
						description: "Validation error",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"403": {
						description: "Forbidden",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"404": {
						description: "Sandbox not found",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"422": {
						description: "readOnly batch attempted to mutate the filesystem",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
				},
			},
		},

		"/sandboxes/{id}/exec": {
			post: {
				tags: ["Exec"],
				summary: "Execute script (streaming SSE)",
				description:
					"Run a bash script and stream output as Server-Sent Events. Events: `stdout` `{ t, data }`, `stderr` `{ t, data }`, `exit` `{ t, exitCode, durationMs, error? }`. Accepts JSON (`application/json`) or raw script body (`text/plain`, `text/x-shellscript`).",
				parameters: [
					sandboxIdParam,
					{
						name: "timeoutMs",
						in: "query",
						required: false,
						description: "Execution timeout in ms (only used with text/plain or text/x-shellscript content types)",
						schema: { type: "integer", minimum: 1, maximum: 300000 },
					},
				],
				requestBody: {
					required: true,
					content: {
						"application/json": { schema: execBodySchema },
						"text/x-shellscript": {
							schema: { type: "string", example: "find /home/user -type f | sort" },
						},
						"text/plain": {
							schema: { type: "string", example: "echo hello" },
						},
					},
				},
				responses: {
					"200": {
						description: "SSE stream",
						content: {
							"text/event-stream": {
								schema: { type: "string", description: "Server-Sent Events" },
							},
						},
					},
					"400": {
						description: "Validation error",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"403": {
						description: "Forbidden",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"404": {
						description: "Sandbox not found",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
				},
			},
		},

		// ── Ingest ────────────────────────────────────────────────────────────────
		"/sandboxes/{id}/ingest-files": {
			post: {
				tags: ["Ingest"],
				summary: "Ingest JSON file manifest",
				description: "Write files from a JSON manifest. File contents must be base64-encoded.",
				parameters: [sandboxIdParam],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									basePath: { type: "string", example: "/home/user/project", description: "Destination directory" },
									files: {
										type: "object",
										additionalProperties: { type: "string" },
										description: "Relative path → base64-encoded content",
									},
								},
								required: ["basePath", "files"],
							},
						},
					},
				},
				responses: {
					"200": {
						description: "Files written",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: { status: { type: "string" }, fileCount: { type: "integer" } },
									required: ["status", "fileCount"],
								},
							},
						},
					},
					"400": {
						description: "Validation error",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"403": {
						description: "Forbidden",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
					"404": {
						description: "Sandbox not found",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
					},
				},
			},
		},
	},
};
