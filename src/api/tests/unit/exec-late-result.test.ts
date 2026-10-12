import { Hono } from "hono";
import { type BashExecResult, InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthVariables, createAuthMiddleware } from "../../auth.js";
import { signToken } from "../../lib/jwt.js";
import { registerTools } from "../../mcp/tools.js";
import { execRoutes } from "../../routes/exec.js";
import { SessionManager } from "../../session-manager.js";
import { captureToolHandlers, requireHandler } from "../helpers/mcp.js";
import { stubTenantConfig } from "../helpers/tenant.js";

const surfaces = ["sync", "sse", "mcp", "sequential batch", "parallel batch"] as const;
type Surface = (typeof surfaces)[number];
interface ExecutionResult {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	timedOut?: boolean;
	error?: string;
}
const sandboxId = "late-result";
const secret = "late-result-auth-secret-at-least-32-bytes";
let manager: SessionManager | undefined;

afterEach(async () => {
	vi.useRealTimers();
	await manager?.shutdown();
	manager = undefined;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function setup() {
	vi.stubEnv("AUTH_SECRET", secret);
	const fs = new InMemoryFs();
	const sessionManager = new SessionManager({ createFs: async () => fs });
	manager = sessionManager;
	await sessionManager.getOrCreate("default", sandboxId, undefined, "owner");
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", createAuthMiddleware(stubTenantConfig()));
	app.route("/v1/sandboxes", execRoutes(sessionManager));
	const token = await signToken({ sub: "owner", secret });
	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
	const { server, handlers } = captureToolHandlers();
	registerTools(server, sessionManager, "owner", "default");

	async function execute(surface: Surface, script: string) {
		if (surface === "mcp") {
			const result = (await requireHandler(handlers, "bash_exec")(
				{ id: sandboxId, script, timeout: 10 },
				{ signal: new AbortController().signal },
			)) as { content: Array<{ text: string }> };
			const body = JSON.parse(result.content[0]!.text) as {
				stdout: string;
				stderr: string;
				exitCode: number;
				timedOut: boolean;
			};
			expect(body).not.toHaveProperty("executionAborted");
			return body;
		}
		const batch = surface.endsWith("batch");
		const response = await app.request(
			`/v1/sandboxes/${sandboxId}/${batch ? "exec-sync-batch" : surface === "sse" ? "exec" : "exec-sync"}`,
			{
				method: "POST",
				headers,
				body: JSON.stringify(
					batch
						? { scripts: [{ id: "one", script }], timeoutMs: 10, readOnly: surface === "parallel batch" }
						: { script, timeoutMs: 10 },
				),
			},
		);
		if (surface === "sse") {
			const events = (await response.text()).split(/\r?\n\r?\n/).flatMap((frame) => {
				const data = frame.split(/\r?\n/).find((line) => line.startsWith("data: "));
				return data === undefined
					? []
					: [JSON.parse(data.slice(6)) as { t: string; data?: string; exitCode?: number; error?: string }];
			});
			for (const event of events) expect(event).not.toHaveProperty("executionAborted");
			const exits = events.filter((event) => event.t === "exit");
			expect(exits).toHaveLength(1);
			return {
				stdout: events
					.filter((event) => event.t === "stdout")
					.map((event) => event.data)
					.join(""),
				stderr: events
					.filter((event) => event.t === "stderr")
					.map((event) => event.data)
					.join(""),
				exitCode: exits[0]!.exitCode,
				timedOut: exits[0]!.error === "timeout",
			};
		}
		const body = (await response.json()) as ExecutionResult & { results: ExecutionResult[] };
		const result = batch ? body.results[0]! : body;
		expect(result).not.toHaveProperty("executionAborted");
		return {
			...result,
			exitCode: result.exitCode ?? -1,
			timedOut: batch ? result.error === "timeout" : result.timedOut,
		};
	}
	return { fs, sessionManager, execute };
}

describe.each(surfaces)("%s resolved execution after a late deadline", (surface) => {
	it.each([0, 7, 124])(
		"preserves completed exit %s, output, and writes when the result arrives after timeout",
		async (exitCode) => {
			const { fs, sessionManager, execute } = await setup();
			await fs.writeFile("/proof", "seed\n");
			const original = sessionManager.execWithRuntimeThrottle.bind(sessionManager);
			let executed!: () => void;
			const completed = new Promise<void>((resolve) => {
				executed = resolve;
			});
			let release!: () => void;
			const reply = new Promise<void>((resolve) => {
				release = resolve;
			});
			let signal: AbortSignal | undefined;
			let nativeResult: BashExecResult | undefined;
			const calls = vi
				.spyOn(sessionManager, "execWithRuntimeThrottle")
				.mockImplementation(async (session, script, options) => {
					signal = options?.signal;
					const result = await original(session, script, options);
					nativeResult = result;
					executed();
					await reply;
					return result;
				});
			vi.useFakeTimers();
			const script = `${surface === "parallel batch" ? "cat /proof" : "echo committed > /proof; cat /proof"}; echo diagnostic >&2; exit ${exitCode}`;
			const operation = execute(surface, script);
			await completed;
			const writtenBeforeTimeout = await fs.readFile("/proof");
			await vi.advanceTimersByTimeAsync(10);
			release();
			const result = await operation;
			expect(signal?.aborted).toBe(true);
			expect(nativeResult?.executionAborted).not.toBe(true);
			expect(result).toMatchObject({
				stdout: surface === "parallel batch" ? "seed\n" : "committed\n",
				stderr: "diagnostic\n",
				exitCode,
				timedOut: false,
			});
			expect(writtenBeforeTimeout).toBe(surface === "parallel batch" ? "seed\n" : "committed\n");
			expect(await fs.readFile("/proof")).toBe(writtenBeforeTimeout);
			expect(calls).toHaveBeenCalledTimes(1);
		},
	);

	it("preserves an explicit exit 124 before the deadline", async () => {
		const { sessionManager, execute } = await setup();
		const calls = vi.spyOn(sessionManager, "execWithRuntimeThrottle");
		vi.useFakeTimers();
		expect(await execute(surface, "echo completed; exit 124")).toMatchObject({
			stdout: "completed\n",
			exitCode: 124,
			timedOut: false,
		});
		expect(calls).toHaveBeenCalledTimes(1);
	});

	it.each(["native cancellation", "AbortError"])(
		"preserves a real deadline cancellation reported as %s",
		async (outcome) => {
			const { fs, sessionManager, execute } = await setup();
			await fs.writeFile("/proof", "seed\n");
			const original = sessionManager.execWithRuntimeThrottle.bind(sessionManager);
			let nativeResult: BashExecResult | undefined;
			let entered!: () => void;
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const calls = vi
				.spyOn(sessionManager, "execWithRuntimeThrottle")
				.mockImplementation((session, script, options) => {
					if (outcome === "native cancellation") {
						const operation = original(session, script, options).then((result) => {
							nativeResult = result;
							return result;
						});
						entered();
						return operation;
					}
					return new Promise<BashExecResult>((_resolve, reject) => {
						options?.signal?.addEventListener(
							"abort",
							() => {
								reject(new DOMException("Execution aborted", "AbortError"));
							},
							{ once: true },
						);
						entered();
					});
				});
			vi.useFakeTimers();
			const operation = execute(
				surface,
				`${surface === "parallel batch" ? "cat /proof" : "echo prefix > /proof"}; sleep 2; echo suffix`,
			);
			await started;
			await vi.advanceTimersByTimeAsync(10);
			expect(await operation).toMatchObject({ exitCode: -1, timedOut: true });
			if (outcome === "native cancellation") {
				expect(nativeResult).toMatchObject({ executionAborted: true });
				expect(nativeResult?.stdout).not.toContain("suffix");
				expect(await fs.readFile("/proof")).toBe(surface === "parallel batch" ? "seed\n" : "prefix\n");
			}
			expect(calls).toHaveBeenCalledTimes(1);
		},
	);
});
