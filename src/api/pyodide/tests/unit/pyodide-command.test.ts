/**
 * Unit tests for the pyodide `python3`/`python` commands + cwd-scoped drain
 * (`src/api/commands/pyodide-command.ts`). Driven by a fake sandbox (returns a
 * canned RunResponse) over an InMemoryFs — no real Deno/Pyodide. Covers arg
 * parsing, staging, and the security-critical drain path validation + caps.
 */

import { Buffer } from "node:buffer";
import { type ByteString, EMPTY_BYTES, InMemoryFs, encodeUtf8ToBytes } from "just-bash";
import type { CommandContext, CustomCommand, ExecResult, IFileSystem } from "just-bash";
import { describe, expect, it } from "vitest";
import type { FsEntry, RunResponse } from "../../../../pyodide-runner/protocol.js";
import { PyodideDrainError, createPyodideCommands, drain } from "../../../commands/pyodide-command.js";
import { type ReadOnlyContext, readOnlyContext } from "../../../read-only-context.js";
import type { PyodideSandbox, RunRequestInput } from "../../manager.js";

function makeResponse(over: Partial<RunResponse> = {}): RunResponse {
	return {
		type: "result",
		requestId: "r",
		seq: 1,
		generation: 1,
		stdout: "",
		stderr: "",
		exitCode: 0,
		created: [],
		modified: [],
		deleted: [],
		...over,
	};
}

function fileEntry(path: string, text: string, mode = 0o644): FsEntry {
	return { path, kind: "file", mode, data: Buffer.from(text, "utf8").toString("base64") };
}

/** A sandbox stub: records the run input, returns `respond(input)`. */
function fakeSandbox(respond: (input: RunRequestInput) => RunResponse): {
	sandbox: PyodideSandbox;
	calls: RunRequestInput[];
} {
	const calls: RunRequestInput[] = [];
	const sandbox = {
		run: (input: RunRequestInput): Promise<RunResponse> => {
			calls.push(input);
			return Promise.resolve(respond(input));
		},
	} as unknown as PyodideSandbox;
	return { sandbox, calls };
}

function makeCtx(
	fs: IFileSystem,
	opts: { cwd?: string; stdin?: ByteString; signal?: AbortSignal; exportedEnv?: Record<string, string> } = {},
): CommandContext {
	return {
		fs,
		cwd: opts.cwd ?? "/home/user",
		env: new Map<string, string>(),
		exportedEnv: opts.exportedEnv,
		stdin: opts.stdin ?? EMPTY_BYTES,
		signal: opts.signal,
	} as CommandContext;
}

function run(cmd: CustomCommand, args: string[], ctx: CommandContext): Promise<ExecResult> {
	return (cmd as { execute: (a: string[], c: CommandContext) => Promise<ExecResult> }).execute(args, ctx);
}

async function freshFs(): Promise<IFileSystem> {
	const fs = new InMemoryFs();
	await fs.mkdir("/home/user", { recursive: true });
	return fs;
}

describe("pyodide command — argument surface", () => {
	it("--version prints the Pyodide CPython version without running the sandbox", async () => {
		const { sandbox, calls } = fakeSandbox(() => makeResponse());
		const [python3] = createPyodideCommands(sandbox);
		const res = await run(python3 as CustomCommand, ["--version"], makeCtx(await freshFs()));
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toBe("Python 3.13.2 (Pyodide)\n");
		expect(calls).toHaveLength(0);
	});

	it("registers both python3 and python aliases", () => {
		const { sandbox } = fakeSandbox(() => makeResponse());
		const cmds = createPyodideCommands(sandbox);
		expect(cmds.map((c) => c.name).sort()).toEqual(["python", "python3"]);
	});

	it("-m MODULE is rejected with a clear message, exit 2, no run", async () => {
		const { sandbox, calls } = fakeSandbox(() => makeResponse());
		const [python3] = createPyodideCommands(sandbox);
		const res = await run(python3 as CustomCommand, ["-m", "http.server"], makeCtx(await freshFs()));
		expect(res.exitCode).toBe(2);
		expect(res.stderr).toContain("-m option is not supported");
		expect(calls).toHaveLength(0);
	});

	it("a missing script file reports can't-open, exit 2, no run", async () => {
		const { sandbox, calls } = fakeSandbox(() => makeResponse());
		const [python3] = createPyodideCommands(sandbox);
		const res = await run(python3 as CustomCommand, ["nope.py"], makeCtx(await freshFs()));
		expect(res.exitCode).toBe(2);
		expect(res.stderr).toContain("can't open file 'nope.py'");
		expect(calls).toHaveLength(0);
	});

	it("-c CODE passes the code + argv and stages the cwd subtree", async () => {
		const fs = await freshFs();
		await fs.writeFile("/home/user/data.csv", "a,b\n1,2\n");
		const { sandbox, calls } = fakeSandbox(() => makeResponse({ stdout: Buffer.from("hi").toString("base64") }));
		const [python3] = createPyodideCommands(sandbox);
		const res = await run(python3 as CustomCommand, ["-c", "print('hi')", "x"], makeCtx(fs));
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toBe("hi");
		expect(calls).toHaveLength(1);
		const input = calls[0]!;
		expect(input.code).toBe("print('hi')");
		expect(input.argv).toEqual(["-c", "x"]);
		expect(input.cwd).toBe("/home/user");
		// data.csv staged (base64 of the file bytes).
		const staged = input.files.find((f) => f.path === "/home/user/data.csv");
		expect(staged?.kind).toBe("file");
		expect(Buffer.from(staged?.data ?? "", "base64").toString()).toBe("a,b\n1,2\n");
	});

	it("reads the program from stdin for the `-` form (and consumes stdin)", async () => {
		const { sandbox, calls } = fakeSandbox(() => makeResponse());
		const [python3] = createPyodideCommands(sandbox);
		await run(python3 as CustomCommand, ["-"], makeCtx(await freshFs(), { stdin: encodeUtf8ToBytes("print(1)") }));
		const input = calls[0]!;
		expect(input.code).toBe("print(1)");
		expect(input.argv).toEqual(["-"]);
		expect(input.stdin).toBe(""); // stdin was consumed as the program
	});
});

describe("pyodide command — drain into the filesystem", () => {
	it("drains a created file back into ctx.fs", async () => {
		const fs = await freshFs();
		const { sandbox } = fakeSandbox(() => makeResponse({ created: [fileEntry("/home/user/out.txt", "result")] }));
		const [python3] = createPyodideCommands(sandbox);
		const res = await run(python3 as CustomCommand, ["-c", "..."], makeCtx(fs));
		expect(res.exitCode).toBe(0);
		expect(await fs.readFile("/home/user/out.txt")).toBe("result");
	});

	it("creates dirs before files and applies deletions", async () => {
		const fs = await freshFs();
		await fs.writeFile("/home/user/old.txt", "gone soon");
		const { sandbox } = fakeSandbox(() =>
			makeResponse({
				created: [
					{ path: "/home/user/sub", kind: "dir", mode: 0o755, data: "" },
					fileEntry("/home/user/sub/inner.txt", "nested"),
				],
				deleted: ["/home/user/old.txt"],
			}),
		);
		const [python3] = createPyodideCommands(sandbox);
		await run(python3 as CustomCommand, ["-c", "..."], makeCtx(fs));
		expect((await fs.stat("/home/user/sub")).isDirectory).toBe(true);
		expect(await fs.readFile("/home/user/sub/inner.txt")).toBe("nested");
		expect(await fs.exists("/home/user/old.txt")).toBe(false);
	});

	it("drains nothing when the signal is aborted after the response, before the drain", async () => {
		const fs = await freshFs();
		const ac = new AbortController();
		ac.abort();
		const { sandbox } = fakeSandbox(() => makeResponse({ created: [fileEntry("/home/user/out.txt", "x")] }));
		const [python3] = createPyodideCommands(sandbox);
		await expect(
			run(python3 as CustomCommand, ["-c", "..."], makeCtx(fs, { signal: ac.signal })),
		).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(await fs.exists("/home/user/out.txt")).toBe(false); // nothing drained
	});

	it("preserves a non-default mode (exec bit) via chmod", async () => {
		const fs = await freshFs();
		const { sandbox } = fakeSandbox(() =>
			makeResponse({ created: [fileEntry("/home/user/run.sh", "#!/bin/sh\n", 0o755)] }),
		);
		const [python3] = createPyodideCommands(sandbox);
		await run(python3 as CustomCommand, ["-c", "..."], makeCtx(fs));
		expect((await fs.stat("/home/user/run.sh")).mode & 0o777).toBe(0o755);
	});
});

describe("pyodide command — drain rejects escaping / invalid paths (fail closed)", () => {
	async function expectRejectedDrain(resp: RunResponse): Promise<void> {
		const fs = await freshFs();
		const { sandbox } = fakeSandbox(() => resp);
		const [python3] = createPyodideCommands(sandbox);
		await expect(run(python3 as CustomCommand, ["-c", "..."], makeCtx(fs))).rejects.toBeInstanceOf(PyodideDrainError);
	}

	it("rejects an absolute path outside cwd", async () => {
		await expectRejectedDrain(makeResponse({ created: [fileEntry("/etc/passwd", "x")] }));
	});

	it("rejects a path that escapes cwd via ..", async () => {
		await expectRejectedDrain(makeResponse({ created: [fileEntry("/home/user/../etc/evil", "x")] }));
	});

	it("rejects a null byte in a created path", async () => {
		await expectRejectedDrain(makeResponse({ created: [fileEntry("/home/user/a b", "x")] }));
	});

	it("rejects a deleted path outside cwd", async () => {
		await expectRejectedDrain(makeResponse({ deleted: ["/etc/passwd"] }));
	});

	it("does not write any file when a later drain entry is rejected (fail closed)", async () => {
		const fs = await freshFs();
		const { sandbox } = fakeSandbox(() =>
			makeResponse({ created: [fileEntry("/home/user/ok.txt", "ok"), fileEntry("/etc/evil", "bad")] }),
		);
		const [python3] = createPyodideCommands(sandbox);
		await expect(run(python3 as CustomCommand, ["-c", "..."], makeCtx(fs))).rejects.toBeInstanceOf(PyodideDrainError);
		// Validation happens before any write, so the valid sibling is NOT written.
		expect(await fs.exists("/home/user/ok.txt")).toBe(false);
	});
});

describe("pyodide command — byte caps", () => {
	it("rejects staging a file over the per-file cap", async () => {
		const fs = await freshFs();
		await fs.writeFile("/home/user/big.bin", "x".repeat(2048));
		const { sandbox, calls } = fakeSandbox(() => makeResponse());
		const [python3] = createPyodideCommands(sandbox, { maxFileBytes: 1024, maxTotalBytes: 1_000_000 });
		const res = await run(python3 as CustomCommand, ["-c", "..."], makeCtx(fs));
		expect(res.exitCode).toBe(1);
		expect(res.stderr).toContain("per-file stage cap");
		expect(calls).toHaveLength(0); // never reached the sandbox
	});

	it("rejects draining a file over the per-file cap", async () => {
		const fs = await freshFs();
		const { sandbox } = fakeSandbox(() =>
			makeResponse({ created: [fileEntry("/home/user/big.out", "y".repeat(2048))] }),
		);
		const [python3] = createPyodideCommands(sandbox, { maxFileBytes: 1024, maxTotalBytes: 1_000_000 });
		await expect(run(python3 as CustomCommand, ["-c", "..."], makeCtx(fs))).rejects.toBeInstanceOf(PyodideDrainError);
		expect(await fs.exists("/home/user/big.out")).toBe(false);
	});

	it("enforces the per-file cap on a script resolved outside cwd", async () => {
		const fs = await freshFs();
		await fs.mkdir("/outside", { recursive: true });
		await fs.writeFile("/outside/big.py", `x = '${"a".repeat(2048)}'`);
		const { sandbox, calls } = fakeSandbox(() => makeResponse());
		const [python3] = createPyodideCommands(sandbox, { maxFileBytes: 1024, maxTotalBytes: 1_000_000 });
		const res = await run(python3 as CustomCommand, ["/outside/big.py"], makeCtx(fs));
		expect(res.exitCode).toBe(1);
		expect(res.stderr).toContain("per-file stage cap");
		expect(calls).toHaveLength(0); // never reached the sandbox
	});
});

describe("pyodide command — script resolved outside cwd (FILE parity)", () => {
	it("stages an out-of-cwd script at a reserved non-drainable path with its real mode", async () => {
		const fs = await freshFs();
		await fs.mkdir("/outside", { recursive: true });
		await fs.writeFile("/outside/tool.py", "print('hi')");
		await fs.chmod("/outside/tool.py", 0o755);
		const { sandbox, calls } = fakeSandbox(() => makeResponse());
		const [python3] = createPyodideCommands(sandbox);
		await run(python3 as CustomCommand, ["/outside/tool.py", "arg"], makeCtx(fs));
		const input = calls[0]!;
		// The out-of-cwd script is re-homed at the reserved staging path and argv[0]
		// (→ __file__) points there, so it can't collide with Pyodide MEMFS internals
		// and is excluded from the cwd-scoped drain.
		expect(input.argv).toEqual(["/__sqlfs_ext__/tool.py", "arg"]);
		const staged = input.files.find((f) => f.path === "/__sqlfs_ext__/tool.py");
		expect(staged?.kind).toBe("file");
		expect(staged?.mode).toBe(0o755); // real mode captured (was hardcoded 0o644 before the fix)
		// The original absolute path is NOT staged (no MEMFS collision risk).
		expect(input.files.find((f) => f.path === "/outside/tool.py")).toBeUndefined();
	});

	it("refuses to run a symlinked script (symlink-refused on the capped script read, review #1)", async () => {
		const fs = await freshFs();
		await fs.writeFile("/home/user/real.py", "print('hi')");
		await fs.symlink("/home/user/real.py", "/home/user/link.py");
		const { sandbox, calls } = fakeSandbox(() => makeResponse());
		const [python3] = createPyodideCommands(sandbox);
		const res = await run(python3 as CustomCommand, ["link.py"], makeCtx(fs));
		expect(res.exitCode).toBe(1);
		expect(res.stderr).toContain("symlink");
		expect(calls).toHaveLength(0); // refused before reaching the sandbox
	});
});

describe("pyodide command — exec env forwarding (review #6)", () => {
	it("forwards exported bash env vars to the run request (→ os.environ)", async () => {
		const { sandbox, calls } = fakeSandbox(() => makeResponse());
		const [python3] = createPyodideCommands(sandbox);
		const ctx = makeCtx(await freshFs(), { exportedEnv: { FOO: "bar", API_BASE: "http://x" } });
		await run(python3 as CustomCommand, ["-c", "print(1)"], ctx);
		expect(calls[0]?.env).toEqual({ FOO: "bar", API_BASE: "http://x" });
	});

	it("omits env when nothing is exported", async () => {
		const { sandbox, calls } = fakeSandbox(() => makeResponse());
		const [python3] = createPyodideCommands(sandbox);
		await run(python3 as CustomCommand, ["-c", "print(1)"], makeCtx(await freshFs()));
		expect(calls[0]?.env).toBeUndefined();
	});
});

describe("pyodide command — explicit read-only enforcement (review #3)", () => {
	it("rejects a readOnly run that reported any mutation, before touching ctx.fs", async () => {
		const fs = await freshFs();
		// The run reports a created file → a persistent mutation.
		const { sandbox, calls } = fakeSandbox(() => makeResponse({ created: [fileEntry("/home/user/out.txt", "x")] }));
		const [python3] = createPyodideCommands(sandbox);
		const roCtx: ReadOnlyContext = { violated: false };
		const res = await readOnlyContext.run(roCtx, () =>
			run(python3 as CustomCommand, ["-c", "open('out.txt','w').write('x')"], makeCtx(fs)),
		);
		expect(res.exitCode).toBe(1);
		expect(roCtx.violated).toBe(true); // the session layer maps this to EREADONLY_VIOLATION
		expect(calls).toHaveLength(1); // the run happened…
		expect(await fs.exists("/home/user/out.txt")).toBe(false); // …but nothing drained
	});

	it("allows a readOnly run that reported no mutation", async () => {
		const fs = await freshFs();
		const { sandbox } = fakeSandbox(() => makeResponse({ stdout: Buffer.from("ok").toString("base64") }));
		const [python3] = createPyodideCommands(sandbox);
		const roCtx: ReadOnlyContext = { violated: false };
		const res = await readOnlyContext.run(roCtx, () =>
			run(python3 as CustomCommand, ["-c", "print('ok')"], makeCtx(fs)),
		);
		expect(res.exitCode).toBe(0);
		expect(roCtx.violated).toBe(false);
	});
});

describe("pyodide drain — manifest validation (review #7)", () => {
	const caps = { maxFileBytes: 1 << 20, maxTotalBytes: 1 << 20 };
	async function fsAt(cwd: string): Promise<IFileSystem> {
		const fs = new InMemoryFs();
		await fs.mkdir(cwd, { recursive: true });
		return fs;
	}

	it("rejects a duplicate drain path", async () => {
		const fs = await fsAt("/home/user");
		const resp = makeResponse({
			created: [fileEntry("/home/user/a.txt", "1"), fileEntry("/home/user/a.txt", "2")],
		});
		await expect(drain(fs, "/home/user", resp, caps)).rejects.toBeInstanceOf(PyodideDrainError);
	});

	it("rejects a path that is both written and deleted", async () => {
		const fs = await fsAt("/home/user");
		const resp = makeResponse({
			created: [fileEntry("/home/user/a.txt", "1")],
			deleted: ["/home/user/a.txt"],
		});
		await expect(drain(fs, "/home/user", resp, caps)).rejects.toBeInstanceOf(PyodideDrainError);
	});

	it("rejects a delete that is an ancestor of a written path (would erase the write)", async () => {
		const fs = await fsAt("/home/user");
		const resp = makeResponse({
			created: [fileEntry("/home/user/d/x.txt", "child")],
			deleted: ["/home/user/d"],
		});
		await expect(drain(fs, "/home/user", resp, caps)).rejects.toBeInstanceOf(PyodideDrainError);
		expect(await fs.exists("/home/user/d/x.txt")).toBe(false); // nothing applied
	});

	it("rejects duplicate deleted paths (not silently collapsed)", async () => {
		const fs = await fsAt("/home/user");
		await fs.writeFile("/home/user/gone.txt", "x");
		const resp = makeResponse({ deleted: ["/home/user/gone.txt", "/home/user/gone.txt"] });
		await expect(drain(fs, "/home/user", resp, caps)).rejects.toBeInstanceOf(PyodideDrainError);
		expect(await fs.exists("/home/user/gone.txt")).toBe(true); // not deleted (rejected pre-mutation)
	});

	it("rejects a written file used as a directory ancestor", async () => {
		const fs = await fsAt("/home/user");
		const resp = makeResponse({
			created: [fileEntry("/home/user/a", "file"), fileEntry("/home/user/a/b.txt", "child")],
		});
		await expect(drain(fs, "/home/user", resp, caps)).rejects.toBeInstanceOf(PyodideDrainError);
	});

	it("rejects a drain path targeting the reserved staging area (cwd = root)", async () => {
		const fs = new InMemoryFs();
		const resp = makeResponse({ created: [fileEntry("/__sqlfs_ext__/evil.py", "x")] });
		await expect(drain(fs, "/", resp, caps)).rejects.toBeInstanceOf(PyodideDrainError);
		expect(await fs.exists("/__sqlfs_ext__/evil.py")).toBe(false);
	});

	it("applies a valid (dirs-before-files) manifest", async () => {
		const fs = await fsAt("/home/user");
		const resp = makeResponse({
			created: [{ path: "/home/user/d", kind: "dir", mode: 0o755, data: "" }, fileEntry("/home/user/d/x.txt", "hi")],
		});
		await drain(fs, "/home/user", resp, caps);
		expect(await fs.readFile("/home/user/d/x.txt", "utf8")).toBe("hi");
	});

	it("replaces an existing file with a directory at the same path (file→dir, review #2)", async () => {
		const fs = await fsAt("/home/user");
		await fs.writeFile("/home/user/x", "i was a file");
		const resp = makeResponse({ created: [{ path: "/home/user/x", kind: "dir", mode: 0o755, data: "" }] });
		await drain(fs, "/home/user", resp, caps);
		expect((await fs.stat("/home/user/x")).isDirectory).toBe(true);
	});

	it("replaces an existing directory with a file at the same path (dir→file, review #2)", async () => {
		const fs = await fsAt("/home/user");
		await fs.mkdir("/home/user/x", { recursive: true });
		const resp = makeResponse({ created: [fileEntry("/home/user/x", "now a file")] });
		await drain(fs, "/home/user", resp, caps);
		expect((await fs.stat("/home/user/x")).isFile).toBe(true);
		expect(await fs.readFile("/home/user/x", "utf8")).toBe("now a file");
	});

	it("rejects a drain through a symlinked ancestor directory (review #7)", async () => {
		const fs = await fsAt("/home/user");
		await fs.mkdir("/home/user/real", { recursive: true });
		await fs.symlink("/home/user/real", "/home/user/link");
		const resp = makeResponse({ created: [fileEntry("/home/user/link/evil.txt", "x")] });
		await expect(drain(fs, "/home/user", resp, caps)).rejects.toBeInstanceOf(PyodideDrainError);
		expect(await fs.exists("/home/user/real/evil.txt")).toBe(false);
	});
});
