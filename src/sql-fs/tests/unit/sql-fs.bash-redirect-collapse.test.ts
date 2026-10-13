import { Bash } from "just-bash";
import { describe, expect, it } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import { BUFFER_ON, makeProbeDialect } from "../fixtures/buffered-dialect.js";

async function runScript(script: string, maxOps: number = BUFFER_ON.maxOps) {
	const probe = makeProbeDialect();
	const fs = new SqlFs({ dialect: probe.dialect, sandboxId: "s-collapse", scriptTxBuffer: { ...BUFFER_ON, maxOps } });
	await fs.ready();
	const bash = new Bash({ cwd: "/home/user", fs });
	probe.calls.length = 0;
	fs.beginScriptScope();
	let scriptError: string | undefined;
	let result = { exitCode: -1 };
	try {
		result = await bash.exec(script);
		await fs.endScriptScope();
	} catch (err) {
		scriptError = (err as Error & { code?: string }).code ?? "UNCODED";
		await fs.abortScriptScope();
	}
	return {
		fs,
		result,
		scriptError,
		composites: probe.calls.filter((c) => c === "writeFileComposite").length,
	};
}

describe("bash over SqlFs — `>` flushes one composite per redirect", () => {
	it("collapses the open-time truncate into the write that follows it", async () => {
		const { fs, result, composites } = await runScript("echo hi > /home/user/out");
		expect({ exitCode: result.exitCode, composites, content: await fs.readFile("/home/user/out") }).toEqual({
			exitCode: 0,
			composites: 1,
			content: "hi\n",
		});
	});

	it("keeps the truncate when the command writes nothing", async () => {
		const { fs, composites } = await runScript("false > /home/user/file.txt");
		expect({ composites, size: (await fs.stat("/home/user/file.txt")).size }).toEqual({ composites: 1, size: 0 });
	});

	it("keeps one composite per redirect when redirects alternate between files", async () => {
		const { fs, composites } = await runScript("echo 1 > /home/user/a; echo 2 > /home/user/b; echo 3 > /home/user/a");
		expect({
			composites,
			a: await fs.readFile("/home/user/a"),
			b: await fs.readFile("/home/user/b"),
		}).toEqual({ composites: 3, a: "3\n", b: "2\n" });
	});

	it("counts a collapsed redirect once against the op cap", async () => {
		const one = await runScript("echo hi > /home/user/out", 1);
		const two = await runScript("echo 1 > /home/user/a; echo 2 > /home/user/b", 1);
		expect({ one: one.scriptError, oneExit: one.result.exitCode, two: two.scriptError }).toEqual({
			one: undefined,
			oneExit: 0,
			two: "ESCRIPTBUFFER",
		});
	});
});
