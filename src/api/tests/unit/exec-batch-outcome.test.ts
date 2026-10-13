import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import type { BashExecResult } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { apiErrorHandler } from "../../errors.js";
import { executeBatch } from "../../lib/batch-exec.js";
import { readOnlyContext } from "../../read-only-context.js";
import { execRoutes } from "../../routes/exec.js";
import { SessionManager } from "../../session-manager.js";

const scripts = [{ id: "write", script: "echo hello" }];

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

const parallelScripts = Array.from({ length: 32 }, (_, index) => ({ id: String(index), script: String(index) }));

const successfulResult = (stdout: string, exitCode = 0): BashExecResult => ({
	stdout,
	stderr: "",
	exitCode,
	env: {},
});

describe("batch terminal outcomes", () => {
	it.each(["EWORKER_UNAVAILABLE", "EWORKER_BUSY", "EEXEC_OUTCOME_UNKNOWN", "ELOCKLOST_APPLIED"])(
		"stops undispatched read-only scripts after %s and settles started executions",
		async (code) => {
			const manager = new SessionManager({ createFs: async () => new InMemoryFs() });
			const session = await manager.getOrCreate("default", `parallel-terminal-${code}`, undefined, "owner");
			const pending = parallelScripts.map(() => deferred<BashExecResult>());
			const signals: (AbortSignal | undefined)[] = [];
			const completed: string[] = [];
			const execute = vi
				.spyOn(manager, "execWithRuntimeThrottle")
				.mockImplementation(async (_session, script, opts) => {
					signals.push(opts?.signal);
					const result = await pending[Number(script)]!.promise;
					completed.push(script);
					return result;
				});
			const error = Object.assign(new Error("terminal batch failure"), { code });
			let settled = false;
			const result = readOnlyContext
				.run({ violated: false }, () => executeBatch(manager, session, parallelScripts, 10_000))
				.then(
					(value) => ({ results: value }),
					(error: unknown) => ({ error }),
				)
				.finally(() => {
					settled = true;
				});
			try {
				expect(execute).toHaveBeenCalledTimes(16);
				pending[7]!.reject(error);
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(settled).toBe(false);
				pending[8]!.resolve(successfulResult("8"));
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(completed).toEqual(["8"]);
				expect(execute).toHaveBeenCalledTimes(16);
				expect(settled).toBe(false);
				expect(signals.map((signal) => signal?.aborted)).toEqual(Array(16).fill(false));
				for (let index = 0; index < 16; index++) pending[index]!.resolve(successfulResult(String(index)));
				const outcome = await result;
				expect("error" in outcome ? outcome.error : undefined).toBe(error);
				expect(execute).toHaveBeenCalledTimes(16);
				expect(completed.sort((a, b) => Number(a) - Number(b))).toEqual(
					Array.from({ length: 16 }, (_, index) => String(index)).filter((index) => index !== "7"),
				);
				expect(signals.map((signal) => signal?.aborted)).toEqual(Array(16).fill(false));
			} finally {
				for (const execution of pending) execution.resolve(successfulResult("cleanup"));
				await result;
				await manager.shutdown();
			}
		},
	);

	it.each([0, 7, 124])("dispatches every read-only script after a definitive exit %i", async (exitCode) => {
		const manager = new SessionManager({ createFs: async () => new InMemoryFs() });
		const session = await manager.getOrCreate("default", `parallel-exit-${exitCode}`, undefined, "owner");
		const execute = vi
			.spyOn(manager, "execWithRuntimeThrottle")
			.mockImplementation(async (_session, script) => successfulResult(script, script === "7" ? exitCode : 0));
		try {
			const results = await readOnlyContext.run({ violated: false }, () =>
				executeBatch(manager, session, parallelScripts, 10_000),
			);
			expect(execute).toHaveBeenCalledTimes(32);
			expect(results.map(({ id, stdout, exitCode, error }) => ({ id, stdout, exitCode, error }))).toEqual(
				parallelScripts.map(({ id }) => ({ id, stdout: id, exitCode: id === "7" ? exitCode : 0, error: undefined })),
			);
		} finally {
			await manager.shutdown();
		}
	});

	it.each(["EEXEC_OUTCOME_UNKNOWN", "ECOHERENCE", "ELOCKLOST_APPLIED", "EDRIVERFAULT", "08006"])(
		"preserves %s over a lower-index capacity failure after all executions settle",
		async (code) => {
			const manager = new SessionManager({ createFs: async () => new InMemoryFs() });
			const session = await manager.getOrCreate("default", `parallel-ambiguous-${code}`, undefined, "owner");
			const pending = parallelScripts.map(() => deferred<BashExecResult>());
			const execute = vi
				.spyOn(manager, "execWithRuntimeThrottle")
				.mockImplementation(async (_session, script) => pending[Number(script)]!.promise);
			const capacityError = Object.assign(new Error("capacity unavailable"), { code: "EWORKER_BUSY" });
			const ambiguousError = Object.assign(new Error("execution outcome uncertain"), { code });
			let settled = false;
			const result = readOnlyContext
				.run({ violated: false }, () => executeBatch(manager, session, parallelScripts, 10_000))
				.then(
					(value) => ({ results: value }),
					(error: unknown) => ({ error }),
				)
				.finally(() => {
					settled = true;
				});
			try {
				pending[0]!.reject(capacityError);
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(settled).toBe(false);
				pending[7]!.reject(ambiguousError);
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(settled).toBe(false);
				for (let index = 0; index < 16; index++) pending[index]!.resolve(successfulResult(String(index)));
				const outcome = await result;
				expect("error" in outcome ? outcome.error : undefined).toBe(ambiguousError);
				expect(execute).toHaveBeenCalledTimes(16);
			} finally {
				for (const execution of pending) execution.resolve(successfulResult("cleanup"));
				await result;
				await manager.shutdown();
			}
		},
	);

	it.each(["EWORKER_BUSY", "ERUNTIME_BUSY", "EREADONLY"])(
		"keeps a mixed unknown read-only HTTP batch nonretryable despite %s",
		async (code) => {
			const secret = "mixed-batch-unknown-secret-at-least-32-bytes";
			vi.stubEnv("AUTH_SECRET", secret);
			const manager = new SessionManager({ createFs: async () => new InMemoryFs() });
			await manager.getOrCreate("default", "mixed-unknown", undefined, "owner");
			const unknown = deferred<BashExecResult>();
			const execute = vi.spyOn(manager, "execWithRuntimeThrottle").mockImplementation(async (_session, script) => {
				if (script === "0") throw Object.assign(new Error("execution refused"), { code });
				return unknown.promise;
			});
			const app = new Hono<{ Variables: AuthVariables }>();
			app.use("/v1/*", authMiddleware);
			app.route("/v1/sandboxes", execRoutes(manager));
			app.onError(apiErrorHandler);
			const token = await new SignJWT({ sub: "owner" })
				.setProtectedHeader({ alg: "HS256" })
				.sign(new TextEncoder().encode(secret));
			const response = app.request("/v1/sandboxes/mixed-unknown/exec-sync-batch", {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ scripts: parallelScripts.slice(0, 2), readOnly: true }),
			});
			try {
				await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
				unknown.reject(Object.assign(new Error("execution outcome unknown"), { code: "EEXEC_OUTCOME_UNKNOWN" }));
				const result = await response;
				expect(result.status).toBe(503);
				expect(await result.json()).toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN", retryable: false });
				expect(execute).toHaveBeenCalledTimes(2);
			} finally {
				unknown.resolve(successfulResult("cleanup"));
				await response;
				await manager.shutdown();
				vi.unstubAllEnvs();
			}
		},
	);

	it.each([
		["EWORKER_BUSY", "EWORKER_UNAVAILABLE"],
		["EDRIVERFAULT", "EEXEC_OUTCOME_UNKNOWN"],
	])("preserves worker order between %s and %s", async (firstCode, secondCode) => {
		const manager = new SessionManager({ createFs: async () => new InMemoryFs() });
		const session = await manager.getOrCreate("default", `parallel-order-${firstCode}`, undefined, "owner");
		const first = deferred<BashExecResult>();
		const firstError = Object.assign(new Error("first worker failed"), { code: firstCode });
		vi.spyOn(manager, "execWithRuntimeThrottle").mockImplementation(async (_session, script) => {
			if (script === "0") return first.promise;
			throw Object.assign(new Error("second worker failed"), { code: secondCode });
		});
		const result = readOnlyContext
			.run({ violated: false }, () => executeBatch(manager, session, parallelScripts.slice(0, 2), 10_000))
			.catch((error: unknown) => error);
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			first.reject(firstError);
			await expect(result).resolves.toBe(firstError);
		} finally {
			first.resolve(successfulResult("cleanup"));
			await result;
			await manager.shutdown();
		}
	});

	it.each([
		new Error("uncoded execution failure"),
		Object.assign(new Error("execution cancelled"), { code: "ABORTED" }),
		new DOMException("execution cancelled", "AbortError"),
	])("continues read-only dispatch after a nonterminal failure $name", async (error) => {
		const manager = new SessionManager({ createFs: async () => new InMemoryFs() });
		const session = await manager.getOrCreate("default", `parallel-nonterminal-${error.name}`, undefined, "owner");
		const execute = vi.spyOn(manager, "execWithRuntimeThrottle").mockImplementation(async (_session, script) => {
			if (script === "7") throw error;
			return successfulResult(script);
		});
		try {
			const results = await readOnlyContext.run({ violated: false }, () =>
				executeBatch(manager, session, parallelScripts, 10_000),
			);
			expect(execute).toHaveBeenCalledTimes(32);
			expect(results.map(({ id, stdout, exitCode, error }) => ({ id, stdout, exitCode, error }))).toEqual(
				parallelScripts.map(({ id }) => ({
					id,
					stdout: id === "7" ? "" : id,
					exitCode: id === "7" ? -1 : 0,
					error: id === "7" ? "internal error" : undefined,
				})),
			);
		} finally {
			await manager.shutdown();
		}
	});

	it("preserves an unknown outcome when the deadline has also expired", async () => {
		const manager = new SessionManager({ createFs: async () => new InMemoryFs() });
		const session = await manager.getOrCreate("default", "deadline-unknown", undefined, "owner");
		const execute = vi.spyOn(manager, "execWithRuntimeThrottle").mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			throw Object.assign(new Error("write outcome is unknown"), { code: "EEXEC_OUTCOME_UNKNOWN" });
		});
		try {
			await expect(
				executeBatch(manager, session, [...scripts, { id: "next", script: "echo next" }], 10),
			).rejects.toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN" });
			expect(execute).toHaveBeenCalledTimes(1);
		} finally {
			await manager.shutdown();
		}
	});
	it("preserves an unknown write outcome and does not execute the next script", async () => {
		const manager = new SessionManager({ createFs: async () => new InMemoryFs() });
		const session = await manager.getOrCreate("default", "unknown-batch", undefined, "owner");
		const execute = vi
			.spyOn(manager, "execWithRuntimeThrottle")
			.mockRejectedValue(Object.assign(new Error("write outcome is unknown"), { code: "EEXEC_OUTCOME_UNKNOWN" }));
		await expect(
			executeBatch(manager, session, [...scripts, { id: "next", script: "echo next" }], 1000),
		).rejects.toMatchObject({
			code: "EEXEC_OUTCOME_UNKNOWN",
		});
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("drains parallel scripts before surfacing a terminal worker failure", async () => {
		const manager = new SessionManager({ createFs: async () => new InMemoryFs() });
		const session = await manager.getOrCreate("default", "parallel-failure", undefined, "owner");
		let release: (() => void) | undefined;
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		let drained = false;
		vi.spyOn(manager, "execWithRuntimeThrottle").mockImplementation(async (_session, script) => {
			if (script === "fail") throw Object.assign(new Error("worker unavailable"), { code: "EWORKER_UNAVAILABLE" });
			await slow;
			drained = true;
			return { stdout: "done", stderr: "", exitCode: 0, env: {} };
		});
		let settled = false;
		const result = readOnlyContext.run({ violated: false }, () =>
			executeBatch(
				manager,
				session,
				[
					{ id: "fail", script: "fail" },
					{ id: "slow", script: "slow" },
				],
				1000,
			),
		);
		const checked = expect(result).rejects.toMatchObject({ code: "EWORKER_UNAVAILABLE" });
		void result.catch(() => {
			settled = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		release!();
		await checked;
		expect(drained).toBe(true);
	});
});
