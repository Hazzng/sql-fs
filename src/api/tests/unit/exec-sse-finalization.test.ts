import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { execRoutes } from "../../routes/exec.js";
import { SessionManager } from "../../session-manager.js";
import { asRedis, FakeRedis } from "./helpers/session-manager-fakes.js";

class CoherentMemoryFs extends InMemoryFs {
	dirty = false;

	override async writeFile(...args: Parameters<InMemoryFs["writeFile"]>): Promise<void> {
		await super.writeFile(...args);
		this.dirty = true;
	}

	wasDirty(): boolean {
		return this.dirty;
	}

	async ensureFresh(): Promise<void> {}

	async clearDirty(): Promise<void> {
		this.dirty = false;
	}

	poisoned(): boolean {
		return false;
	}

	async reload(): Promise<void> {
		this.dirty = false;
	}
}

const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.shutdown();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function setup() {
	const secret = "sse-finalization-test-secret-at-least-32bytes";
	vi.stubEnv("AUTH_SECRET", secret);
	const fs = new CoherentMemoryFs();
	const redis = new FakeRedis();
	const manager = new SessionManager({ createFs: async () => fs, redis: asRedis(redis) });
	managers.push(manager);
	await manager.withSession("default", "finalization", async () => {}, undefined, "owner");
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", authMiddleware);
	app.route("/v1/sandboxes", execRoutes(manager));
	const token = await new SignJWT({ sub: "owner" })
		.setProtectedHeader({ alg: "HS256" })
		.sign(new TextEncoder().encode(secret));
	const request = (script: string, timeoutMs = 5000) =>
		app.request("/v1/sandboxes/finalization/exec", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ script, timeoutMs }),
		});
	return { fs, redis, request };
}

function events(
	text: string,
): Array<{ t: string; code?: string; exitCode?: number; error?: string; retryable?: boolean }> {
	return text
		.split("\n\n")
		.filter((frame) => frame.includes("data: "))
		.map((frame) =>
			JSON.parse(
				frame
					.split("\n")
					.find((line) => line.startsWith("data: "))!
					.slice(6),
			),
		);
}

describe("SSE execution finalization", () => {
	it.each([false, true])(
		"does not hide a post-write finalization failure behind success or timeout=%s",
		async (timeout) => {
			const { fs, request } = await setup();
			vi.spyOn(fs, "clearDirty").mockRejectedValueOnce(
				Object.assign(new Error("Cache finalization failed after write"), { code: "ECOHERENCE" }),
			);
			const response = await request(
				`echo applied > /prefix; ${timeout ? "sleep 2" : "echo streamed"}`,
				timeout ? 50 : 5000,
			);
			const frames = events(await response.text());
			expect(await fs.readFile("/prefix")).toBe("applied\n");
			expect(frames.filter((frame) => frame.t === "error")).toEqual([
				{
					t: "error",
					code: "ECOHERENCE",
					error: "Cache finalization failed after write",
					retryable: false,
				},
			]);
			expect(frames.filter((frame) => frame.t === "exit")).toEqual([
				expect.objectContaining({ exitCode: -1, error: "error" }),
			]);
			if (!timeout) expect(frames[0]).toEqual({ t: "stdout", data: "streamed\n" });
		},
	);

	it("delivers output while finalization is held and sends the terminal only after it completes", async () => {
		const { fs, request } = await setup();
		let reached: () => void = () => {};
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const clearDirty = fs.clearDirty.bind(fs);
		vi.spyOn(fs, "clearDirty").mockImplementationOnce(async () => {
			await clearDirty();
			reached();
			await gate;
		});
		const response = await request("echo applied > /prefix; echo streamed");
		const reader = response.body!.getReader();
		try {
			const output = await reader.read();
			const decoder = new TextDecoder();
			const first = decoder.decode(output.value);
			expect(first).toContain('"data":"streamed\\n"');
			expect(first).not.toContain("event: exit");
			const terminal = reader.read();
			await held;
			expect(await Promise.race([terminal, new Promise((resolve) => setTimeout(() => resolve("held"), 10))])).toBe(
				"held",
			);
			release();
			const next = await terminal;
			expect(events(decoder.decode(next.value))).toEqual([expect.objectContaining({ t: "exit", exitCode: 0 })]);
			expect((await reader.read()).done).toBe(true);
		} finally {
			release();
			await reader.cancel();
		}
	});
});
