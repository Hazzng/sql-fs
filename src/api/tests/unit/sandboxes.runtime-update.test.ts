/**
 * PATCH /v1/sandboxes/:id changes runtime flags on a sandbox that already exists.
 *
 * The store contract the Postgres dialect implements is mirrored here: the update rewrites the
 * flags and advances the sandbox epoch. Two SessionManagers over one probe dialect stand in for
 * two replicas, so the test covers a warm session that never saw the PATCH.
 */

import { Hono } from "hono";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../../sql-fs/sql-fs.js";
import { type DialectProbe, makeProbeDialect } from "../../../sql-fs/tests/fixtures/buffered-dialect.js";
import type { SandboxMeta } from "../../../sql-fs/types.js";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { apiErrorHandler } from "../../errors.js";
import { registerTools } from "../../mcp/tools.js";
import { sandboxRoutes } from "../../routes/sandboxes.js";
import { type RuntimeOptions, SessionManager } from "../../session-manager.js";
import { captureToolHandlers, requireHandler } from "../helpers/mcp.js";

const AUTH_SECRET = "test-secret-for-sandbox-tests-at-least-32b";
const T = "default";
const ID = "sb-runtime-update";
const CREATED_AT = "2026-01-01T00:00:00.000Z";

interface Replicas {
	readonly a: SessionManager;
	readonly b: SessionManager;
	readonly probe: DialectProbe;
	readonly meta: Map<string, SandboxMeta>;
	readonly metaReads: () => number;
}

function replicas(): Replicas {
	const probe = makeProbeDialect();
	const meta = new Map<string, SandboxMeta>([
		[ID, { owner: "agent-1", name: null, python: false, javascript: false, network: false, createdAt: CREATED_AT }],
	]);
	const getSandboxMetaFn = vi.fn(async (_t: string, id: string) => meta.get(id) ?? null);
	const options = {
		createFs: async (_t: string, sandboxId: string) => {
			const fs = new SqlFs({ dialect: probe.dialect, sandboxId });
			await fs.ready();
			return fs;
		},
		getSandboxMetaFn,
		updateSandboxRuntimeFn: async (_t: string, id: string, runtime: Partial<RuntimeOptions>) => {
			const current = meta.get(id);
			if (current === undefined) return null;
			const next = { ...current, ...runtime };
			meta.set(id, next);
			probe.version += 1n;
			return next;
		},
	};
	return {
		a: new SessionManager(options),
		b: new SessionManager(options),
		probe,
		meta,
		metaReads: () => getSandboxMetaFn.mock.calls.length,
	};
}

function app(sm: SessionManager): Hono<{ Variables: AuthVariables }> {
	const hono = new Hono<{ Variables: AuthVariables }>();
	hono.use("/v1/*", authMiddleware);
	hono.route("/v1/sandboxes", sandboxRoutes(sm));
	hono.onError(apiErrorHandler);
	return hono;
}

async function patch(sm: SessionManager, id: string, body: unknown, sub = "agent-1"): Promise<Response> {
	const token = await new SignJWT({ sub })
		.setProtectedHeader({ alg: "HS256" })
		.sign(new TextEncoder().encode(AUTH_SECRET));
	return app(sm).request(`/v1/sandboxes/${id}`, {
		method: "PATCH",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function curlPath(sm: SessionManager, readOnly = false): Promise<string> {
	const run = readOnly ? sm.withSessionRead.bind(sm) : sm.withSessionOrRehydrate.bind(sm);
	const result = await run(T, ID, (session) => sm.execWithRuntimeThrottle(session, "command -v curl"));
	return result.stdout;
}

describe("PATCH /v1/sandboxes/:id", () => {
	let r: Replicas;

	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
		vi.spyOn(console, "log").mockImplementation(() => {});
		r = replicas();
	});

	afterEach(async () => {
		await Promise.all([r.a.shutdown(), r.b.shutdown()]);
		vi.restoreAllMocks();
		process.env.AUTH_SECRET = "";
	});

	it("returns the sandbox with the new flags and keeps the omitted ones", async () => {
		r.meta.set(ID, { ...r.meta.get(ID)!, python: true });

		const res = await patch(r.a, ID, { network: true });

		expect({ status: res.status, body: await res.json() }).toEqual({
			status: 200,
			body: {
				id: ID,
				name: null,
				owner: "agent-1",
				createdAt: CREATED_AT,
				python: true,
				javascript: false,
				network: true,
			},
		});
	});

	it("gives curl to the next exec on a replica that was already warm", async () => {
		expect(await curlPath(r.b)).toBe("");

		await patch(r.a, ID, { network: true });

		expect(await curlPath(r.b)).toBe("/usr/bin/curl\n");
	});

	it("takes curl away from a warm read-only exec on another replica", async () => {
		await patch(r.a, ID, { network: true });
		expect(await curlPath(r.b, true)).toBe("/usr/bin/curl\n");

		await patch(r.a, ID, { network: false });

		expect(await curlPath(r.b, true)).toBe("");
	});

	it("reads no metadata on an exec when the sandbox epoch has not moved", async () => {
		await curlPath(r.b);
		const before = r.metaReads();

		await curlPath(r.b);
		await curlPath(r.b, true);

		expect(r.metaReads()).toBe(before);
	});

	it("answers 403 to a caller who does not own the sandbox", async () => {
		const res = await patch(r.a, ID, { network: true }, "agent-2");

		expect({ status: res.status, network: r.meta.get(ID)?.network }).toEqual({ status: 403, network: false });
	});

	it("answers 404 for a sandbox that does not exist", async () => {
		const res = await patch(r.a, "sb-missing", { network: true });

		expect({ status: res.status, body: await res.json() }).toEqual({
			status: 404,
			body: { error: "not_found", code: "SANDBOX_NOT_FOUND" },
		});
	});

	it("rejects a body that sets no flag", async () => {
		const res = await patch(r.a, ID, {});

		expect({ status: res.status, body: await res.json() }).toEqual({
			status: 400,
			body: {
				error: "validation_error",
				code: "INVALID_INPUT",
				details: ["Set at least one of python, javascript, network"],
			},
		});
	});

	it("rejects a field that is not a runtime flag", async () => {
		const res = await patch(r.a, ID, { owner: "agent-2" });

		expect({ status: res.status, owner: r.meta.get(ID)?.owner }).toEqual({ status: 400, owner: "agent-1" });
	});
});

describe("MCP sandbox_update", () => {
	let r: Replicas;

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		r = replicas();
	});

	afterEach(async () => {
		await Promise.all([r.a.shutdown(), r.b.shutdown()]);
		vi.restoreAllMocks();
	});

	async function callUpdate(owner: string, args: Record<string, unknown>): Promise<unknown> {
		const { server, handlers } = captureToolHandlers();
		registerTools(server, r.a, owner, T);
		const result = (await requireHandler(handlers, "sandbox_update")(args, {})) as { content: Array<{ text: string }> };
		return JSON.parse(result.content[0]!.text);
	}

	it("changes the flag for the owner", async () => {
		expect(await callUpdate("agent-1", { id: ID, network: true })).toEqual({
			id: ID,
			python: false,
			javascript: false,
			network: true,
		});
		expect(await curlPath(r.b)).toBe("/usr/bin/curl\n");
	});

	it("refuses a caller who does not own the sandbox", async () => {
		expect(await callUpdate("agent-2", { id: ID, network: true })).toEqual({ ok: false, error: "forbidden" });
		expect(r.meta.get(ID)?.network).toBe(false);
	});
});
