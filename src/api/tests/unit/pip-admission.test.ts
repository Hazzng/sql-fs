import { Bash, InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { type SlotAcquire, createPythonPackageCommands } from "../../commands/pip-command.js";
import { pythonSlotContext } from "../../python-slot-context.js";
import { fixtureFetch, wheel } from "./pip-fixtures.js";

interface SlotCounter {
	readonly acquire: SlotAcquire;
	acquired: number;
	inFlight: number;
	peak: number;
}

function counter(): SlotCounter {
	const state: SlotCounter = {
		acquired: 0,
		inFlight: 0,
		peak: 0,
		acquire: () => Promise.resolve(() => undefined),
	};
	(state as { acquire: SlotAcquire }).acquire = () => {
		state.acquired++;
		state.inFlight++;
		state.peak = Math.max(state.peak, state.inFlight);
		return Promise.resolve(() => {
			state.inFlight--;
		});
	};
	return state;
}

function makeBash(packages: Parameters<typeof fixtureFetch>[0], install: SlotCounter, python: SlotCounter): Bash {
	return new Bash({
		fs: new InMemoryFs(),
		python: true,
		fetch: fixtureFetch(packages),
		customCommands: createPythonPackageCommands({
			acquireInstall: install.acquire,
			acquirePython: python.acquire,
		}),
	});
}

const cliFixture = {
	"databricks-cli": {
		version: "0.18.0",
		body: wheel(
			"databricks-cli",
			"0.18.0",
			{ "databricks_cli/__init__.py": "", "databricks_cli/cli.py": "def main():\n    print('cli')\n" },
			[],
			"databricks_cli.cli:main",
		),
		entryPoint: "databricks_cli.cli:main",
	},
};

describe("pip and python admission slots", () => {
	it("takes one install slot for the whole pip install and releases it", async () => {
		const install = counter();
		const python = counter();
		const bash = makeBash({ demo: { version: "1.0", body: wheel("demo", "1.0", { "demo.py": "" }) } }, install, python);
		const result = await bash.exec("pip install demo");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(install.acquired).toBe(1);
		expect(install.inFlight).toBe(0);
	});

	it("takes no install slot for a python3 run and no python slot for pip install", async () => {
		const install = counter();
		const python = counter();
		const bash = makeBash({ demo: { version: "1.0", body: wheel("demo", "1.0", { "demo.py": "" }) } }, install, python);
		expect((await bash.exec("pip install demo")).exitCode).toBe(0);
		// pip's WASM extractor is transitional and deliberately takes no Python
		// slot; only python3 / databricks do.
		expect(python.acquired).toBe(0);
		const run = await bash.exec(`python3 -c "print(1)"`);
		expect(run.exitCode, run.stderr).toBe(0);
		expect(install.acquired).toBe(1);
		expect(python.acquired).toBe(1);
	});

	it("holds exactly one python slot at a time across `python3 x.py; databricks y`", async () => {
		const install = counter();
		const python = counter();
		const bash = makeBash(cliFixture, install, python);
		expect((await bash.exec("pip install databricks-cli")).exitCode).toBe(0);
		await bash.fs.writeFile("/x.py", "print('script')\n");
		const result = await bash.exec("python3 /x.py; databricks y");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toBe("script\ncli\n");
		expect(python.acquired).toBe(2);
		expect(python.peak).toBe(1);
		expect(python.inFlight).toBe(0);
	});

	it("skips the python acquire when an enclosing exec already holds a slot", async () => {
		const install = counter();
		const python = counter();
		const bash = makeBash(cliFixture, install, python);
		const result = await pythonSlotContext.run({ held: true }, () => bash.exec(`python3 -c "print(1)"`));
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toBe("1\n");
		expect(python.acquired).toBe(0);
	});

	it("reports backpressure instead of throwing when the install slot is refused", async () => {
		const python = counter();
		const install: SlotCounter = {
			...counter(),
			acquire: () => Promise.reject(new Error("ERUNTIME_BUSY: queue full")),
		};
		const bash = makeBash({ demo: { version: "1.0", body: wheel("demo", "1.0", { "demo.py": "" }) } }, install, python);
		const result = await bash.exec("pip install demo");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("pip: too many concurrent installs; try again shortly\n");
	});
});
