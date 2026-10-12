import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BulkIngestFile } from "../../../sql-fs/types.js";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { registerTools } from "../../mcp/tools.js";
import { execRoutes } from "../../routes/exec.js";
import { fileRoutes } from "../../routes/files.js";
import { ingestRoutes } from "../../routes/ingest.js";
import { type RuntimeOptions, type Session, SessionManager } from "../../session-manager.js";
import { FairAdmission } from "../../worker-owner/admission.js";
import { workerRequestContext } from "../../worker-owner/request-context.js";
import { captureToolHandlers, requireHandler } from "../helpers/mcp.js";

const secret = "test-secret-request-admission-at-least-32bytes";
const id = "request-admission";

class AdmittedSessions extends SessionManager {
	constructor(
		readonly admission: FairAdmission,
		fs: InMemoryFs,
	) {
		super({ createFs: async () => fs });
	}

	override async withSessionOrRehydrate<T>(
		tenant: string,
		id: string,
		callback: (session: Session) => Promise<T>,
		options?: RuntimeOptions,
	): Promise<T> {
		const context = workerRequestContext.getStore();
		const release = await this.admission.acquire(tenant, id, context?.bytes ?? 0, context?.signal);
		try {
			return await super.withSessionOrRehydrate(tenant, id, callback, options);
		} finally {
			release();
		}
	}
}

async function setup(maxQueuedBytes = 64) {
	process.env.AUTH_SECRET = secret;
	const fs = new InMemoryFs();
	Object.assign(fs, {
		async bulkIngest(files: BulkIngestFile[]) {
			for (const file of files) await fs.writeFile(file.path, file.content);
		},
	});
	const admission = new FairAdmission({
		capacity: 1,
		maxActivePerTenant: 1,
		maxQueued: 4,
		maxQueuedPerTenant: 4,
		maxQueuedBytes,
		maxQueuedBytesPerTenant: Math.max(1, maxQueuedBytes - 1),
		waitMs: 1000,
	});
	const manager = new AdmittedSessions(admission, fs);
	await manager.getOrCreate("default", id, undefined, "owner");
	const release = await admission.acquire("blocking-tenant", "blocking-sandbox", 0);
	const app = new Hono<{ Variables: AuthVariables }>();
	app.onError((error, c) => c.json({ code: (error as Error & { code?: string }).code }, 503));
	app.use("/v1/*", authMiddleware);
	app.route("/v1/sandboxes", fileRoutes(manager));
	app.route("/v1/sandboxes", execRoutes(manager));
	app.route("/v1/sandboxes", ingestRoutes(manager));
	const token = await new SignJWT({ sub: "owner" })
		.setProtectedHeader({ alg: "HS256" })
		.sign(new TextEncoder().encode(secret));
	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
	return { fs, app, headers, manager, admission, release };
}

afterEach(() => {
	process.env.AUTH_SECRET = "";
	vi.restoreAllMocks();
});

describe("decoded request admission", () => {
	it("charges every streamed PUT byte even with an underdeclared Content-Length", async () => {
		const { fs, app, headers, admission, release } = await setup();
		try {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(50));
					controller.enqueue(new Uint8Array(50));
					controller.close();
				},
			});
			const request = new Request(`http://localhost/v1/sandboxes/${id}/files/upload`, {
				method: "PUT",
				headers: { ...headers, "Content-Length": "1" },
				body,
				duplex: "half",
			} as RequestInit);
			const responsePromise = app.request(request);
			await expect.poll(() => admission.metrics.offered).toBe(2);
			release();
			const response = await responsePromise;
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ code: "EWORKER_BUSY" });
			expect(await fs.exists("/upload")).toBe(false);
		} finally {
			release();
		}
	});

	it("charges script and environment bytes before executing a queued script", async () => {
		const { fs, app, headers, admission, release } = await setup();
		try {
			const responsePromise = app.request(`/v1/sandboxes/${id}/exec-sync`, {
				method: "POST",
				headers,
				body: JSON.stringify({ script: "echo hello > /script-output", env: { VALUE: "漢".repeat(40) } }),
			});
			await expect.poll(() => admission.metrics.offered).toBe(2);
			release();
			const response = await responsePromise;
			expect(await response.json()).toEqual({ code: "EWORKER_BUSY" });
			expect(await fs.exists("/script-output")).toBe(false);
		} finally {
			release();
		}
	});

	it("charges the aggregate bulk upload instead of each entry separately", async () => {
		const { fs, app, headers, admission, release } = await setup(30);
		try {
			const responsePromise = app.request(`/v1/sandboxes/${id}/writeFiles`, {
				method: "POST",
				headers,
				body: JSON.stringify({ files: { "/a": "a".repeat(20), "/b": "b".repeat(20) } }),
			});
			await expect.poll(() => admission.metrics.offered).toBe(2);
			release();
			const response = await responsePromise;
			expect(await response.json()).toEqual({ code: "EWORKER_BUSY" });
			expect(await fs.exists("/a")).toBe(false);
			expect(await fs.exists("/b")).toBe(false);
		} finally {
			release();
		}
	});

	it("charges decoded ingest buffers alongside the retained base64 manifest", async () => {
		const { fs, app, headers, admission, release } = await setup(100);
		try {
			const responsePromise = app.request(`/v1/sandboxes/${id}/ingest-files`, {
				method: "POST",
				headers,
				body: JSON.stringify({ basePath: "/", files: { one: Buffer.alloc(30, 97).toString("base64") } }),
			});
			await expect.poll(() => admission.metrics.offered).toBe(2);
			release();
			const response = await responsePromise;
			expect(await response.json()).toEqual({ code: "EWORKER_BUSY" });
			expect(await fs.exists("/one")).toBe(false);
		} finally {
			release();
		}
	});

	it("removes disconnected queued uploads and releases their retained byte charge", async () => {
		const { fs, app, headers, admission, release } = await setup();
		try {
			const controller = new AbortController();
			const response = app.request(`/v1/sandboxes/${id}/files/cancelled`, {
				method: "PUT",
				headers,
				body: "payload",
				signal: controller.signal,
			});
			await expect.poll(() => admission.metrics.queued).toBe(1);
			expect(admission.metrics.queuedBytes).toBeGreaterThanOrEqual(7);
			controller.abort();
			expect(await (await response).json()).toEqual({ code: "ABORTED" });
			expect(admission.metrics.queuedBytes).toBe(0);
			expect(admission.metrics.queued).toBe(0);
			expect(await fs.exists("/cancelled")).toBe(false);
		} finally {
			release();
		}
	});

	it("charges MCP host file bytes before entering worker admission", async () => {
		const { fs, manager, admission, release } = await setup();
		const directory = await mkdtemp(join(tmpdir(), "sql-fs-admission-"));
		try {
			const path = join(directory, "host.txt");
			await writeFile(path, "x".repeat(200));
			const { server, handlers } = captureToolHandlers();
			registerTools(server, manager, "owner", "default");
			const resultPromise = requireHandler(handlers, "fs_ingest")(
				{ id, basePath: "/", paths: { host: path } },
				{ signal: new AbortController().signal },
			);
			await expect.poll(() => admission.metrics.offered).toBe(2);
			release();
			const result = await resultPromise;
			expect(result).toMatchObject({ isError: true, structuredContent: { code: "EWORKER_BUSY", retryAfterMs: 1000 } });
			expect(await fs.exists("/host")).toBe(false);
		} finally {
			release();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
