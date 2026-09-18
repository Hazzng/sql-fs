/**
 * Integration: the whole install pipeline against a real Postgres — Phase W
 * (blobs + manifest), Phase P (graft + ledger), uninstall, and the property the
 * design exists for: the second sandbox to want a wheel downloads nothing.
 *
 * The shell is assembled exactly as `SessionManager` assembles it (a `Bash` over
 * the sandbox's `SqlFs`, with the package store injected into the commands), so
 * the command path under test is the production one.
 */

import { Bash } from "just-bash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../../sql-fs/dialects/postgres.js";
import { asPackageStore } from "../../../sql-fs/package-store.js";
import { SqlFs } from "../../../sql-fs/sql-fs.js";
import { createPythonPackageCommands } from "../../commands/pip-command.js";
import { fixtureFetch, sha256, wheel } from "../unit/pip-fixtures.js";

const SKIP = !process.env.DATABASE_URL;
const suffix = `${Date.now()}`;

const demoWheel = wheel("demo", "1.0", {
	"demo/__init__.py": `VALUE = "${suffix}"\n`,
	"demo/extra/leaf.py": `LEAF = "${suffix}"\n`,
});
const packages = { demo: { version: "1.0", body: demoWheel } };
const wheelHash = sha256(demoWheel);
const wheelKey = Buffer.from(wheelHash, "hex");

describe.skipIf(SKIP)("pip install — Postgres end to end", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	const sandboxes = [`pip-a-${suffix}`, `pip-b-${suffix}`, `pip-c-${suffix}`] as const;
	const counter = { wheels: 0 };

	/** One sandbox's shell, wired like `SessionManager.buildPythonPackageCommands`. */
	async function shell(sandboxId: string): Promise<Bash & { fs: SqlFs }> {
		const fs = new SqlFs({ dialect, sandboxId });
		await fs.ready();
		const inner = fixtureFetch(packages);
		return new Bash({
			fs,
			python: true,
			fetch: (url, options) => {
				if (new URL(url).hostname === "files.pythonhosted.org") counter.wheels += 1;
				return inner(url, options);
			},
			customCommands: createPythonPackageCommands({ packageStore: asPackageStore(fs)! }),
		}) as Bash & { fs: SqlFs };
	}

	beforeAll(async () => {
		await dialect.connect();
		for (const id of sandboxes) await dialect.transaction((tx) => dialect.createSandbox(tx, id));
	});

	afterAll(async () => {
		try {
			for (const id of sandboxes) {
				await dialect.transaction(async (tx) => {
					await tx`DELETE FROM sandbox_packages WHERE sandbox_id = ${id}`;
					await dialect.deleteSandbox(tx, id);
				});
			}
			await dialect.transaction(async (tx) => {
				await tx`DELETE FROM package_manifests WHERE wheel_sha256 = ${wheelKey}`;
			});
		} finally {
			await dialect.disconnect();
		}
	});

	it("installs into the first sandbox, downloading the wheel once", async () => {
		const bash = await shell(sandboxes[0]);
		const result = await bash.exec("pip install demo");

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toBe("Successfully installed demo-1.0\n");
		expect(counter.wheels).toBe(1);
		expect(await bash.fs.readFile("/site-packages/demo/__init__.py")).toBe(`VALUE = "${suffix}"\n`);
		expect((await bash.exec("pip freeze")).stdout).toBe("demo==1.0\n");
	});

	it("installs the same wheel into a second sandbox with zero downloads", async () => {
		const before = counter.wheels;
		const bash = await shell(sandboxes[1]);
		const result = await bash.exec("pip install demo");

		expect(result.exitCode, result.stderr).toBe(0);
		expect(counter.wheels).toBe(before);
		expect(await bash.fs.readFile("/site-packages/demo/extra/leaf.py")).toBe(`LEAF = "${suffix}"\n`);
	});

	it("uninstalls the package, its files and its ledger row", async () => {
		const bash = await shell(sandboxes[1]);
		const result = await bash.exec("pip uninstall -y demo");

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toBe("Successfully uninstalled demo-1.0\n");
		expect(await bash.fs.exists("/site-packages/demo/extra")).toBe(false);
		expect(await bash.fs.exists("/site-packages/demo")).toBe(false);
		expect((await bash.exec("pip list")).stdout).toBe("");
	});

	it("re-fetches the wheel exactly once after a GC pass took the manifest and its blobs", async () => {
		// A blob a manifest references cannot be hand-deleted: the
		// `package_manifest_files → blobs` FK is ON DELETE RESTRICT, which is the
		// point of it. The reachable shape is what `gcOrphanBlobs` does — manifest
		// first (file rows cascade), blobs second — and the manifest itself can
		// only go once no ledger row references it, so the last holder uninstalls.
		const holder = await shell(sandboxes[0]);
		expect((await holder.exec("pip uninstall -y demo")).exitCode).toBe(0);

		const blobKeys = (await dialect.loadManifestFiles([new Uint8Array(wheelKey)]))
			.get(wheelHash)!
			.map((file) => Buffer.from(file.sha256));
		expect(blobKeys.length).toBeGreaterThan(0);
		await dialect.transaction(async (tx) => {
			await tx`DELETE FROM package_manifests WHERE wheel_sha256 = ${wheelKey}`;
			for (const blob of blobKeys) {
				await tx`
					DELETE FROM blobs b
					WHERE b.sha256 = ${blob}
					  AND NOT EXISTS (SELECT 1 FROM inodes i WHERE i.content_sha256 = b.sha256)
					  AND NOT EXISTS (SELECT 1 FROM package_manifest_files f WHERE f.blob_sha256 = b.sha256)
				`;
			}
		});
		const before = counter.wheels;

		const bash = await shell(sandboxes[2]);
		const result = await bash.exec("pip install demo");

		expect(result.exitCode, result.stderr).toBe(0);
		expect(counter.wheels).toBe(before + 1);
		expect(await bash.fs.readFile("/site-packages/demo/__init__.py")).toBe(`VALUE = "${suffix}"\n`);
	});
});
