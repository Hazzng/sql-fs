import { Bash, InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { parsePythonInvocation, pythonPackageCommands, toWorkerPath } from "../../commands/pip-command.js";

/** A sandbox with the overrides, and a bare one for built-in `python` parity. */
function shells(): { overridden: Bash; builtin: Bash } {
	return {
		overridden: new Bash({ fs: new InMemoryFs(), python: true, customCommands: pythonPackageCommands }),
		builtin: new Bash({ fs: new InMemoryFs(), python: true }),
	};
}

describe("python invocation parsing", () => {
	it("reads -c as the program", () => {
		expect(parsePythonInvocation(["-c", "print(1)", "a"])).toEqual({
			kind: "code",
			target: "print(1)",
			rest: ["a"],
		});
	});

	it("reads -m as a module", () => {
		expect(parsePythonInvocation(["-m", "json.tool", "x"])).toEqual({
			kind: "module",
			target: "json.tool",
			rest: ["x"],
		});
	});

	it("stops reading interpreter options at the first positional", () => {
		expect(parsePythonInvocation(["-u", "script.py", "--version"])).toEqual({
			kind: "script",
			target: "script.py",
			rest: ["--version"],
		});
	});

	it("treats --version before the first positional as an interpreter flag", () => {
		expect(parsePythonInvocation(["--version"])).toEqual({ kind: "interpreter" });
		expect(parsePythonInvocation(["-V"])).toEqual({ kind: "interpreter" });
		expect(parsePythonInvocation(["--help"])).toEqual({ kind: "interpreter" });
	});

	it("does not mistake a script argument named -c for the program flag", () => {
		expect(parsePythonInvocation(["script.py", "-c", "value"])).toEqual({
			kind: "script",
			target: "script.py",
			rest: ["-c", "value"],
		});
	});

	it("consumes the value of an option that takes one", () => {
		expect(parsePythonInvocation(["-W", "ignore", "script.py"])).toEqual({
			kind: "script",
			target: "script.py",
			rest: [],
		});
		expect(parsePythonInvocation(["-X", "dev", "-c", "print(1)"])).toEqual({
			kind: "code",
			target: "print(1)",
			rest: [],
		});
	});

	it("reads a short-option cluster", () => {
		expect(parsePythonInvocation(["-uc", "print(1)"])).toEqual({ kind: "code", target: "print(1)", rest: [] });
		expect(parsePythonInvocation(["-Bu", "script.py"])).toEqual({ kind: "script", target: "script.py", rest: [] });
	});

	it("reads a bare dash as the stdin program", () => {
		expect(parsePythonInvocation(["-", "arg"])).toEqual({ kind: "stdin", rest: ["arg"] });
	});

	it("returns undefined when a program flag has no value", () => {
		expect(parsePythonInvocation(["-c"])).toBeUndefined();
		expect(parsePythonInvocation(["-m"])).toBeUndefined();
	});
});

describe("worker path translation", () => {
	it("prefixes an absolute sandbox path with the worker mount", () => {
		expect(toWorkerPath("/home/user", "/hello.py")).toBe("/host/hello.py");
	});

	it("joins a relative path to the cwd first", () => {
		expect(toWorkerPath("/home/user", "sub/hello.py")).toBe("/host/home/user/sub/hello.py");
		expect(toWorkerPath("/home/user", "./hello.py")).toBe("/host/home/user/hello.py");
		expect(toWorkerPath("/home/user/sub", "../hello.py")).toBe("/host/home/user/hello.py");
	});

	it("is idempotent for a path already under the mount", () => {
		expect(toWorkerPath("/home/user", "/host/hello.py")).toBe("/host/hello.py");
	});
});

describe("python3 override end to end", () => {
	it("runs a script given by absolute path", async () => {
		const { overridden } = shells();
		await overridden.fs.writeFile("/hello.py", "print('hello')\n");
		const result = await overridden.exec("python3 /hello.py");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toBe("hello\n");
	});

	it("runs a script given by a relative path from a non-root cwd", async () => {
		const { overridden } = shells();
		await overridden.fs.mkdir("/work", { recursive: true });
		await overridden.fs.writeFile("/work/rel.py", "print('relative')\n");
		const result = await overridden.exec("cd /work && python3 rel.py");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toBe("relative\n");
	});

	it("passes script arguments through, including --version", async () => {
		const { overridden } = shells();
		await overridden.fs.writeFile("/argv.py", "import sys\nprint(sys.argv[1])\n");
		const result = await overridden.exec("python3 /argv.py --version");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toBe("--version\n");
	});

	it("runs a script under an interpreter option", async () => {
		const { overridden } = shells();
		await overridden.fs.writeFile("/buffered.py", "print('unbuffered')\n");
		const result = await overridden.exec("python3 -u /buffered.py");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toBe("unbuffered\n");
	});

	it("reads a program from stdin", async () => {
		const { overridden } = shells();
		const result = await overridden.exec("echo \"print('piped')\" | python3 -");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toBe("piped\n");
	});

	it("runs -c code", async () => {
		const { overridden } = shells();
		const result = await overridden.exec(`python3 -c "print('inline')"`);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toBe("inline\n");
	});

	it("behaves identically under the python name", async () => {
		const { overridden } = shells();
		await overridden.fs.writeFile("/hello.py", "print('hello')\n");
		const viaPython = await overridden.exec("python /hello.py");
		const viaPython3 = await overridden.exec("python3 /hello.py");
		expect(viaPython.exitCode, viaPython.stderr).toBe(0);
		expect(viaPython.stdout).toBe(viaPython3.stdout);
	});

	it("matches the built-in python for --version", async () => {
		const { overridden, builtin } = shells();
		const overriddenResult = await overridden.exec("python3 --version");
		const builtinResult = await builtin.exec("python --version");
		expect(overriddenResult.exitCode).toBe(builtinResult.exitCode);
		expect(overriddenResult.stdout).toBe(builtinResult.stdout);
	});

	it("matches the built-in python for -c code", async () => {
		const { overridden, builtin } = shells();
		const overriddenResult = await overridden.exec(`python3 -c "print(2 + 2)"`);
		const builtinResult = await builtin.exec(`python -c "print(2 + 2)"`);
		expect(overriddenResult.stdout).toBe(builtinResult.stdout);
		expect(overriddenResult.stdout).toBe("4\n");
	});
});
