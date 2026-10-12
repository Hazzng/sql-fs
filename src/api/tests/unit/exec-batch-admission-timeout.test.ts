import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { execRoutes } from "../../routes/exec.js";
import { SessionManager } from "../../session-manager.js";

describe("batch deadlines during runtime admission", () => {
	it.each([false, true])("keeps per-script timeout results with readOnly=%s", async (readOnly) => {
		const secret = "batch-admission-timeout-secret-at-least-32-bytes";
		vi.stubEnv("AUTH_SECRET", secret);
		const manager = new SessionManager({ createFs: async () => new InMemoryFs(), maxConcurrentPython: 1 });
		const options = { python: true, javascript: false, network: false };
		const holder = await manager.getOrCreate("default", "runtime-holder", options, "owner");
		const waiting = await manager.getOrCreate("default", "runtime-waiting", options, "owner");
		const occupied = manager.execWithRuntimeThrottle(
			holder,
			"echo entered > /entered; sleep .3; python3 -c 'print(1)'",
		);
		try {
			await vi.waitFor(async () => expect(await holder.fs.exists("/entered")).toBe(true));
			const app = new Hono<{ Variables: AuthVariables }>();
			app.use("/v1/*", authMiddleware);
			app.route("/v1/sandboxes", execRoutes(manager));
			const token = await new SignJWT({ sub: "owner" })
				.setProtectedHeader({ alg: "HS256" })
				.sign(new TextEncoder().encode(secret));
			const response = await app.request("/v1/sandboxes/runtime-waiting/exec-sync-batch", {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					scripts: [
						{ id: "first", script: "python3 -c 'print(2)'" },
						{ id: "second", script: "python3 -c 'print(3)'" },
					],
					timeoutMs: 10,
					readOnly,
				}),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				results: [
					{ id: "first", exitCode: -1, stdout: "", error: "timeout" },
					{ id: "second", exitCode: -1, stdout: "", error: "timeout" },
				],
			});
			expect(await occupied).toMatchObject({ exitCode: 0, stdout: "1\n" });
			expect(await manager.execWithRuntimeThrottle(waiting, "python3 -c 'print(4)'")).toMatchObject({
				exitCode: 0,
				stdout: "4\n",
			});
		} finally {
			await occupied;
			await manager.shutdown();
			vi.unstubAllEnvs();
		}
	});
});
