/**
 * The ledger-backed commands end to end through a shell: install, list, freeze,
 * uninstall, plus the two cross-sandbox behaviours the ledger makes possible.
 */

import { Bash, InMemoryFs } from "just-bash";
import type { SecureFetch } from "just-bash";
import { describe, expect, it } from "vitest";
import { pythonPackageCommands } from "../../commands/pip-command.js";
import { createPackageState } from "./package-store-fake.js";
import { fixtureFetch, makeBash, makeBashWithFetch, wheel } from "./pip-fixtures.js";

const demoWheel = wheel("demo", "1.0", { "demo/__init__.py": "VALUE = 1\n", "demo/extra/leaf.py": "LEAF = 1\n" });
const demoPackages = { demo: { version: "1.0", body: demoWheel } };

/** A fixture fetch that counts every wheel download. */
function countingFetch(packages: Parameters<typeof fixtureFetch>[0], counter: { wheels: number }): SecureFetch {
	const inner = fixtureFetch(packages);
	return (url, options) => {
		if (new URL(url).hostname === "files.pythonhosted.org") counter.wheels += 1;
		return inner(url, options);
	};
}

describe("pip list and freeze", () => {
	it("prints nothing when no package is installed", async () => {
		const bash = makeBash(demoPackages);
		const result = await bash.exec("pip list");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toBe("");
	});

	it("prints the installed packages as a padded table", async () => {
		const bash = makeBash(demoPackages);
		expect((await bash.exec("pip install demo")).exitCode).toBe(0);
		const result = await bash.exec("pip list");
		expect(result.stdout).toBe("Package Version\n------- -------\ndemo    1.0\n");
	});

	it("prints name==version lines for freeze", async () => {
		const bash = makeBash(demoPackages);
		expect((await bash.exec("pip install demo")).exitCode).toBe(0);
		const result = await bash.exec("pip freeze");
		expect(result.stdout).toBe("demo==1.0\n");
	});

	it("names the supported subcommands for anything else", async () => {
		const bash = makeBash(demoPackages);
		const result = await bash.exec("pip show demo");
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toBe(
			"pip: only 'install', 'uninstall', 'list' and 'freeze' are supported by this experiment\n",
		);
	});
});

describe("pip uninstall", () => {
	it("removes the files, the emptied directories and the ledger row", async () => {
		const bash = makeBash(demoPackages);
		expect((await bash.exec("pip install demo")).exitCode).toBe(0);

		const result = await bash.exec("pip uninstall -y demo");

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toBe("Successfully uninstalled demo-1.0\n");
		expect(await bash.fs.exists("/site-packages/demo/__init__.py")).toBe(false);
		expect(await bash.fs.exists("/site-packages/demo/extra")).toBe(false);
		expect(await bash.fs.exists("/site-packages/demo")).toBe(false);
		expect((await bash.exec("pip freeze")).stdout).toBe("");
	});

	it("keeps and reports a file the sandbox modified", async () => {
		const bash = makeBash(demoPackages);
		expect((await bash.exec("pip install demo")).exitCode).toBe(0);
		await bash.fs.writeFile("/site-packages/demo/__init__.py", "MINE = 1\n");

		const result = await bash.exec("pip uninstall demo");

		expect(result.stdout).toBe(
			"kept modified file /site-packages/demo/__init__.py\nSuccessfully uninstalled demo-1.0\n",
		);
		expect(await bash.fs.readFile("/site-packages/demo/__init__.py")).toBe("MINE = 1\n");
	});

	it("matches the package name the way pip normalises it", async () => {
		const cli = wheel("databricks-cli", "0.18.0", { "databricks_cli/__init__.py": "" });
		const bash = makeBash({ "databricks-cli": { version: "0.18.0", body: cli } });
		expect((await bash.exec("pip install databricks-cli")).exitCode).toBe(0);
		const result = await bash.exec("pip uninstall Databricks_CLI");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toBe("Successfully uninstalled databricks-cli-0.18.0\n");
	});

	it("reports a package that is not installed", async () => {
		const bash = makeBash(demoPackages);
		const result = await bash.exec("pip uninstall demo");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("pip: package 'demo' is not installed\n");
	});

	it("leaves a path another installed package still owns", async () => {
		const shared = { "shared/mod.py": "SAME\n" };
		const bash = makeBash({
			one: { version: "1.0", body: wheel("one", "1.0", { ...shared, "one/mod.py": "A\n" }) },
			two: { version: "1.0", body: wheel("two", "1.0", { ...shared, "two/mod.py": "B\n" }) },
		});
		expect((await bash.exec("pip install one two")).exitCode).toBe(0);

		expect((await bash.exec("pip uninstall one")).exitCode).toBe(0);

		expect(await bash.fs.exists("/site-packages/shared/mod.py")).toBe(true);
		expect(await bash.fs.exists("/site-packages/one/mod.py")).toBe(false);
	});
});

describe("pip against a backend with no package store", () => {
	it("says a SQL backend is required", async () => {
		const bash = new Bash({
			fs: new InMemoryFs(),
			python: true,
			fetch: fixtureFetch(demoPackages),
			customCommands: pythonPackageCommands,
		});
		const result = await bash.exec("pip install demo");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe(
			"pip: package management requires a SQL backend; this sandbox's filesystem has no package store\n",
		);
	});
});

describe("cross-sandbox reuse", () => {
	it("downloads the wheel once and grafts it into the second sandbox", async () => {
		const shared = createPackageState();
		const counter = { wheels: 0 };
		const first = makeBashWithFetch(countingFetch(demoPackages, counter), {}, shared);
		expect((await first.exec("pip install demo")).exitCode).toBe(0);
		expect(counter.wheels).toBe(1);

		const second = makeBashWithFetch(countingFetch(demoPackages, counter), {}, shared);
		const result = await second.exec("pip install demo");

		expect(result.exitCode, result.stderr).toBe(0);
		expect(counter.wheels).toBe(1);
		expect(await second.fs.readFile("/site-packages/demo/__init__.py")).toBe("VALUE = 1\n");
	});

	it("re-fetches the wheel when a blob the manifest claimed is gone", async () => {
		const shared = createPackageState();
		const counter = { wheels: 0 };
		const first = makeBashWithFetch(countingFetch(demoPackages, counter), {}, shared);
		expect((await first.exec("pip install demo")).exitCode).toBe(0);

		// A GC pass collected the blobs; the manifest still points at them.
		shared.blobs.clear();

		const second = makeBashWithFetch(countingFetch(demoPackages, counter), {}, shared);
		const result = await second.exec("pip install demo");

		expect(result.exitCode, result.stderr).toBe(0);
		expect(counter.wheels).toBe(2);
		expect(await second.fs.readFile("/site-packages/demo/__init__.py")).toBe("VALUE = 1\n");
	});
});
