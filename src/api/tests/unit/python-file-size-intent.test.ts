import { InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { SqlFs } from "../../../sql-fs/sql-fs.js";
import type { SqlDialect } from "../../../sql-fs/types.js";
import { type ExecContext, execContext } from "../../exec-context.js";
import { readOnlyContext } from "../../read-only-context.js";
import { createSessionRuntime, executeSessionRuntime } from "../../session-runtime/engine.js";

class GuardedMemoryFs extends InMemoryFs {
	readonly validator = new SqlFs({ dialect: Object.create(null) as SqlDialect<unknown>, sandboxId: "memory-intent" });
	readonly intents: { path: string; bytes: number; op: "read" | "write" }[] = [];
	inputReads = 0;

	assertFileAccess(path: string, bytes: number, op: "read" | "write"): void {
		this.intents.push({ path, bytes, op });
		this.validator.assertFileAccess(path, bytes, op);
	}

	override async readFileBuffer(path: string): Promise<Uint8Array> {
		if (path === "/input") this.inputReads++;
		const stat = await super.stat(path);
		this.validator.assertFileAccess(path, stat.size, "read");
		return await super.readFileBuffer(path);
	}

	override async writeFile(path: string, content: Parameters<InMemoryFs["writeFile"]>[1]): Promise<void> {
		const bytes = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
		this.validator.assertFileAccess(path, bytes, "write");
		await super.writeFile(path, content);
	}
}

function fixture(inputBytes = 1025, fileCap: number | null = 1024, nativeCap = 8192, defense = false) {
	const fs = new GuardedMemoryFs({ "/input": new Uint8Array(inputBytes).fill(97) });
	let active = false;
	const counts = { commits: 0, rollbacks: 0 };
	const scriptTx = {
		get isActive() {
			return active;
		},
		beginScope() {
			active = true;
		},
		async endScope() {
			active = false;
			counts.commits++;
		},
		async abortScope() {
			active = false;
			counts.rollbacks++;
			await fs.rm("/prefix", { force: true });
			await fs.rm("/output", { force: true });
		},
		async run<T>(fn: () => Promise<T>) {
			return await fn();
		},
	};
	const runtime = {
		...createSessionRuntime(
			fs,
			{
				tenantId: "memory",
				sandboxId: "memory-intent",
				runtimeOptions: { python: true, javascript: false, network: false },
			},
			{
				defenseInDepth: defense,
				defenseAuditMode: false,
				execFileLimitBytes: fileCap,
				executionLimits: {
					maxPythonBridgeBytes: nativeCap,
					maxWorkerMessageBytes: 12288,
					maxStringLength: 8192,
					maxInputBytes: 16384,
				},
				baseEnv: Object.create(null),
				gitIdentity: { name: "unit", email: "unit@example.invalid" },
			},
		),
		scriptTx,
	};
	return { fs, runtime, counts };
}

describe("Python domain file-size intent", () => {
	it.each(['open("/input","rb").read()', 'try:\n open("/input","rb").read()\nexcept OSError:\n pass'])(
		"rolls back a prefix when Python reads an oversized domain file (%s)",
		async (code) => {
			const { fs, runtime, counts } = fixture();
			await expect(
				executeSessionRuntime(runtime, `printf seed > /prefix; python3 -c '${code}'; printf after`),
			).rejects.toMatchObject({ code: "EFBIG" });
			expect(fs.inputReads).toBe(0);
			expect(fs.intents).toContainEqual({ path: "/input", bytes: 1025, op: "read" });
			expect(counts).toEqual({ commits: 0, rollbacks: 1 });
			expect(await fs.exists("/prefix")).toBe(false);
		},
	);

	it.each(['open("/output","wb").write(b"a"*1025)', 'with open("/output","wb") as f:\n f.truncate(1025)'])(
		"records oversized write/truncate intent even when Python ignores the error (%s)",
		async (code) => {
			const { fs, runtime, counts } = fixture();
			await expect(
				executeSessionRuntime(runtime, `printf seed > /prefix; python3 -c '${code}'; printf after`),
			).rejects.toMatchObject({ code: "EFBIG" });
			expect(fs.intents).toContainEqual({ path: "/output", bytes: 1025, op: "write" });
			expect(counts).toEqual({ commits: 0, rollbacks: 1 });
			expect(await fs.exists("/prefix")).toBe(false);
			expect(await fs.exists("/output")).toBe(false);
		},
	);

	it("checks append extent against the produced size", async () => {
		const { fs, runtime } = fixture(1024);
		await expect(
			executeSessionRuntime(runtime, 'python3 -c \'open("/input","ab").write(b"x")\''),
		).rejects.toMatchObject({ code: "EFBIG" });
		expect(fs.intents).toContainEqual({ path: "/input", bytes: 1025, op: "write" });
	});

	it("checks a supported positioned write before allocating at its offset", async () => {
		const { fs, runtime, counts } = fixture();
		await expect(
			executeSessionRuntime(
				runtime,
				'printf seed > /prefix; python3 -c \'import os; fd=os.open("/host/output",os.O_WRONLY|os.O_CREAT);\ntry:\n os.pwrite(fd,b"x",2**31-1)\nexcept OSError:\n pass\nfinally:\n os.close(fd)\'; printf after',
			),
		).rejects.toMatchObject({ code: "EFBIG" });
		expect(fs.intents).toContainEqual({ path: "/output", bytes: 2 ** 31, op: "write" });
		expect(counts).toEqual({ commits: 0, rollbacks: 1 });
		expect(await fs.exists("/output")).toBe(false);
	});

	it("forwards the intent hook through defense context wrappers", async () => {
		const { fs, runtime } = fixture(1025, 1024, 8192, true);
		await expect(executeSessionRuntime(runtime, 'python3 -c \'open("/input","rb").read()\'')).rejects.toMatchObject({
			code: "EFBIG",
		});
		expect(fs.intents).toContainEqual({ path: "/input", bytes: 1025, op: "read" });
	});

	it("keeps metadata stat and cursor-only seeks outside the domain size guard", async () => {
		const { fs, runtime, counts } = fixture();
		const result = await executeSessionRuntime(
			runtime,
			'python3 -c \'import os; print(os.stat("/input").st_size); f=open("/output","wb");\ntry:\n f.seek(1025)\nexcept OSError:\n pass\nf.close()\'',
		);
		expect(result).toMatchObject({ exitCode: 0, stdout: "1025\n", stderr: "" });
		expect(fs.intents).toEqual([]);
		expect(counts).toEqual({ commits: 1, rollbacks: 0 });
	});

	it("preserves independent native capacity rejection below a larger domain cap", async () => {
		const { fs, runtime, counts } = fixture(1025, 2048, 1024);
		const result = await executeSessionRuntime(
			runtime,
			'printf seed > /prefix; python3 -c \'open("/input","rb").read()\'',
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("File too large");
		expect(fs.inputReads).toBe(0);
		expect(counts).toEqual({ commits: 1, rollbacks: 0 });
	});

	it("lets the actual whole-read guard cover file caps smaller than the 24-byte transport floor", async () => {
		const { runtime } = fixture(2, 1);
		await expect(executeSessionRuntime(runtime, 'python3 -c \'open("/input","rb").read()\'')).rejects.toMatchObject({
			code: "EFBIG",
		});
	});

	it("preserves ordinary nonzero shell results and successful within-cap reads", async () => {
		const { fs, runtime, counts } = fixture(1024);
		expect(
			await executeSessionRuntime(
				runtime,
				'printf seed > /prefix; python3 -c \'print(len(open("/input","rb").read()))\'; exit 7',
			),
		).toMatchObject({ exitCode: 7, stdout: "1024\n", stderr: "" });
		expect(fs.intents).toEqual([]);
		expect(fs.inputReads).toBe(1);
		expect(counts).toEqual({ commits: 1, rollbacks: 0 });
	});

	it("keeps successful within-cap writes free of intent RPCs", async () => {
		const { fs, runtime } = fixture();
		expect(
			await executeSessionRuntime(runtime, 'python3 -c \'with open("/output","wb") as f:\n f.write(b"a"*1024)\''),
		).toMatchObject({ exitCode: 0, stderr: "" });
		expect(fs.intents).toEqual([]);
		expect((await fs.stat("/output")).size).toBe(1024);
	});

	it("preserves read-only precedence before write size failure", () => {
		const { fs } = fixture();
		fs.validator.beginReadOnlyScope();
		const context: ExecContext = { maxFileBytes: 1024 };
		const readOnly = { violated: false };
		expect(() =>
			execContext.run(context, () =>
				readOnlyContext.run(readOnly, () => fs.validator.assertFileAccess("/output", 1025, "write")),
			),
		).toThrow("read-only");
		expect(readOnly.violated).toBe(true);
		expect(context.exceeded).toBeUndefined();
		fs.validator.endReadOnlyScope();
	});

	it("validates paths and preserves the null-device exemption", () => {
		const { fs } = fixture();
		const context: ExecContext = { maxFileBytes: 1 };
		expect(() => execContext.run(context, () => fs.validator.assertFileAccess("/bad\0path", 2, "read"))).toThrow();
		expect(() => execContext.run(context, () => fs.validator.assertFileAccess("/dev/null", 2, "write"))).not.toThrow();
		expect(context.exceeded).toBeUndefined();
	});
});
