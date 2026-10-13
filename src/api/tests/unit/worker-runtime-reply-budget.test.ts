import { once } from "node:events";
import { MessageChannel, Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionScriptScope } from "../../session-runtime/engine.js";
import { assertWorkerMessageBudget } from "../../worker-owner/message-budget.js";
import { mayApply } from "../../worker-owner/protocol.js";
import type { OwnerCommand, OwnerReply, OwnerRequest } from "../../worker-owner/protocol.js";

const channels: MessageChannel[] = [];
afterEach(() => {
	for (const channel of channels.splice(0)) {
		channel.port1.close();
		channel.port2.close();
	}
	vi.restoreAllMocks();
	vi.resetModules();
	vi.doUnmock("node:worker_threads");
	vi.doUnmock("../../session-runtime/engine.js");
	vi.doUnmock("../../../sql-fs/index.js");
});

async function runtimeFixture(maxBytes = 1024, scriptTx?: SessionScriptScope) {
	const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
	const channel = new MessageChannel();
	channels.push(channel);
	let receive!: (request: OwnerRequest) => void;
	let writes = 0;
	const runtime = {
		scriptTx,
		cwd: "/home/user",
		fs: {
			getAllPaths: () => [],
			wasDirty: () => writes > 0,
			poisoned: () => false,
			getPathCacheBytes: () => 32,
			beginReadOnlyScope: () => {},
			endReadOnlyScope: () => {},
		},
	};
	const execute = vi.fn<() => Promise<unknown>>(async () => {
		writes++;
		throw Object.assign(new Error("雪".repeat(4096)), { code: "ERUNTIME_BUSY" });
	});
	vi.doMock("node:worker_threads", () => ({
		workerData: { options: { executionLimits: { maxWorkerMessageBytes: maxBytes } } },
		parentPort: {
			on: (_event: string, listener: typeof receive) => {
				receive = listener;
			},
			postMessage: (reply: unknown) => channel.port1.postMessage(reply),
			close: () => channel.port1.close(),
		},
	}));
	vi.doMock("../../session-runtime/engine.js", () => ({
		createSessionRuntime: () => runtime,
		executeSessionRuntime: execute,
		closeSessionRuntime: vi.fn(),
	}));
	vi.doMock("../../../sql-fs/index.js", () => ({
		createPostgresSandboxFs: async () => ({ fs: runtime.fs, resolvedOwner: "owner", createdAt: "2026-01-01" }),
	}));
	const ready = new Promise((resolve) => channel.port2.once("message", resolve));
	await import("../../worker-owner/runtime.js");
	await ready;
	let sequence = 0;
	async function send(command: OwnerCommand, cancellation = new SharedArrayBuffer(8)): Promise<OwnerReply> {
		const reply = new Promise<OwnerReply>((resolve) => channel.port2.once("message", resolve));
		receive({ id: ++sequence, generation: 1, command, readOnly: false, cancellation });
		return reply;
	}
	await send({
		kind: "attach",
		identity: {
			tenantId: "reply-budget",
			sandboxId: "unit",
			connectionString: "postgres://unused",
			owner: "owner",
			cwd: "/home/user",
			runtimeOptions: { python: false, javascript: false, network: false },
		},
	});
	return { send, runtime, execute, exit, writes: () => writes };
}

describe("worker runtime reply budgets", () => {
	it("treats only initial sandbox-creating attachments as potentially applied", () => {
		const identity = {
			tenantId: "tenant",
			sandboxId: "sandbox",
			connectionString: "postgres://unused",
			owner: "owner",
			cwd: "/home/user",
			runtimeOptions: { python: false, javascript: false, network: false },
		};
		expect(mayApply({ kind: "attach", identity })).toBe(true);
		expect(mayApply({ kind: "attach", identity: { ...identity, openExisting: false } })).toBe(true);
		expect(mayApply({ kind: "attach", identity: { ...identity, openExisting: true } })).toBe(false);
	});

	it("bounds a failed execution after a write and forbids replay", async () => {
		const fixture = await runtimeFixture();
		const reply = await fixture.send({ kind: "exec", script: "write then fail", options: {} });
		expect(() => assertWorkerMessageBudget(reply, 1024)).not.toThrow();
		expect(reply).toMatchObject({ ok: false, error: { code: "EEXEC_OUTCOME_UNKNOWN" }, metadata: { dirty: true } });
		expect(fixture.writes()).toBe(1);
		expect(fixture.execute).toHaveBeenCalledTimes(1);
	});

	it("charges metadata as part of the reply envelope", async () => {
		const fixture = await runtimeFixture();
		fixture.runtime.cwd = "x".repeat(4096);
		const reply = await fixture.send({ kind: "paths" });
		expect(() => assertWorkerMessageBudget(reply, 1024)).not.toThrow();
		expect(reply).toMatchObject({ ok: false, error: { code: "EEXEC_OUTCOME_UNKNOWN" } });
		expect(reply.metadata).toBeUndefined();
		expect(fixture.exit).toHaveBeenCalledWith(1);
	});
	it("budgets a success together with its envelope and retains dirty metadata on failure", async () => {
		const fixture = await runtimeFixture();
		fixture.execute.mockResolvedValue("x".repeat(900));
		const reply = await fixture.send({ kind: "exec", script: "large output", options: {} });
		expect(() => assertWorkerMessageBudget(reply, 1024)).not.toThrow();
		expect(reply).toMatchObject({ ok: false, error: { code: "EEXEC_OUTCOME_UNKNOWN" }, metadata: { dirty: false } });
		expect(fixture.exit).not.toHaveBeenCalled();
	});

	it("preserves a small successful result and resident metadata", async () => {
		const fixture = await runtimeFixture();
		fixture.execute.mockResolvedValue({ stdout: "ok", exitCode: 0 });
		const reply = await fixture.send({ kind: "exec", script: "small output", options: {} });
		expect(reply).toMatchObject({ ok: true, value: { stdout: "ok", exitCode: 0 }, metadata: { cwd: "/home/user" } });
		expect(() => assertWorkerMessageBudget(reply, 1024)).not.toThrow();
		expect(fixture.exit).not.toHaveBeenCalled();
	});
	it("preserves the explicit scope completion error when abort also fails", async () => {
		const fixture = await runtimeFixture();
		fixture.runtime.scriptTx = {
			isActive: true,
			beginScope: () => {},
			endScope: async () => {
				throw Object.assign(new Error("commit failed"), { code: "ECOMMIT" });
			},
			abortScope: async () => {
				throw Object.assign(new Error("abort failed"), { code: "EABORT" });
			},
			run: (fn) => fn(),
		};

		const reply = await fixture.send({ kind: "endScope" });
		expect(reply).toMatchObject({ ok: false, error: { code: "ECOMMIT", message: "commit failed" } });
	});

	it("physically completes an already-active resident scope", async () => {
		let active = true;
		const fixture = await runtimeFixture();
		fixture.runtime.scriptTx = {
			get isActive() {
				return active;
			},
			beginScope: () => {},
			endScope: async () => {
				active = false;
			},
			abortScope: async () => {},
			run: (fn) => fn(),
		};

		expect(await fixture.send({ kind: "endScope" })).toMatchObject({ ok: true });
		expect(active).toBe(false);
	});

	it("preserves lease loss before explicit completion when abort also fails", async () => {
		const fixture = await runtimeFixture();
		const end = vi.fn(async () => {});
		fixture.runtime.scriptTx = {
			isActive: true,
			beginScope: () => {},
			endScope: end,
			abortScope: async () => {
				throw new Error("abort failed");
			},
			run: (fn) => fn(),
		};
		const cancellation = new SharedArrayBuffer(8);
		Atomics.store(new Int32Array(cancellation), 1, 1);

		const reply = await fixture.send({ kind: "endScope" }, cancellation);

		expect(reply).toMatchObject({
			ok: false,
			error: {
				code: "ELOCKLOST",
				message:
					"ELOCKLOST: lock worker owner lease lost was lost during operation (lease expired or heartbeat failed)",
			},
		});
		expect(end).not.toHaveBeenCalled();
	});

	it("retires a native worker when even a minimal failure cannot fit", async () => {
		const worker = new Worker(
			'const { workerData } = require("node:worker_threads"); import("tsx/esm/api").then(({ register }) => { register(); return import(workerData.runtime); });',
			{
				eval: true,
				execArgv: [],
				workerData: {
					runtime: new URL("../../worker-owner/runtime.ts", import.meta.url).href,
					options: { executionLimits: { maxWorkerMessageBytes: 64 } },
				},
			},
		);
		try {
			expect(await once(worker, "message")).toEqual([{ kind: "ready" }]);
			const replies: unknown[] = [];
			worker.on("message", (reply) => replies.push(reply));
			const exited = once(worker, "exit");
			worker.postMessage({
				id: 1,
				generation: 1,
				command: { kind: "shutdown" },
				readOnly: false,
				cancellation: new SharedArrayBuffer(8),
			} satisfies OwnerRequest);
			expect(await exited).toEqual([1]);
			expect(replies).toEqual([]);
		} finally {
			await worker.terminate();
		}
	});
});
