/**
 * Phase P: the DB-only publish. Every refusal happens before any mutation, and
 * the ledger row is the last thing written.
 */

import { createHash } from "node:crypto";
import type { CommandContext } from "just-bash";
import { describe, expect, it } from "vitest";
import { MANIFEST_FORMAT } from "../../../sql-fs/package-manifest.js";
import type { GraftFile } from "../../../sql-fs/types.js";
import { type PackageLimits, packageLimits } from "../../commands/package-limits.js";
import { type IncomingWheel, StaleManifestError, publishInstall } from "../../commands/pip-publish.js";
import { type FakePackageFs, createPackageFs, hex } from "./package-store-fake.js";

const encoder = new TextEncoder();

function digest(text: string): Uint8Array {
	return new Uint8Array(createHash("sha256").update(encoder.encode(text)).digest());
}

/** Seeds a tenant-global manifest plus its blobs, as Phase W would have. */
async function seedWheel(
	fs: FakePackageFs,
	name: string,
	version: string,
	files: Readonly<Record<string, string>>,
): Promise<IncomingWheel> {
	const wheelSha256 = digest(`${name}-${version}`);
	const rows: GraftFile[] = [];
	for (const [path, body] of Object.entries(files)) {
		const sha256 = digest(body);
		await fs.ingestBlobs([{ sha256, data: encoder.encode(body) }]);
		rows.push({ path: `/site-packages/${path}`, sha256, mode: 0o644, size: encoder.encode(body).length });
	}
	await fs.recordManifest(
		{
			wheelSha256,
			manifestFormat: MANIFEST_FORMAT,
			name,
			version,
			fileCount: rows.length,
			totalBytes: rows.reduce((sum, row) => sum + row.size, 0),
		},
		rows,
	);
	return { name, version, wheelSha256 };
}

function context(fs: FakePackageFs, signal?: AbortSignal): CommandContext {
	return { fs, cwd: "/", ...(signal ? { signal } : {}) } as unknown as CommandContext;
}

function publish(fs: FakePackageFs, incoming: readonly IncomingWheel[], limits?: Partial<PackageLimits>) {
	return publishInstall({ ctx: context(fs), store: fs, incoming, limits: { ...packageLimits(), ...limits } });
}

describe("pip publish", () => {
	it("refuses before any mutation when two packages provide one path differently", async () => {
		const fs = createPackageFs();
		const one = await seedWheel(fs, "one", "1.0", { "shared/mod.py": "A\n" });
		const two = await seedWheel(fs, "two", "1.0", { "shared/mod.py": "B\n" });

		await expect(publish(fs, [one, two])).rejects.toThrow(
			"one and two both provide '/site-packages/shared/mod.py' with different contents",
		);
		expect(fs.graftedPaths).toEqual([]);
		expect(fs.ledger.size).toBe(0);
	});

	it("allows two packages to provide the same path when the bytes are identical", async () => {
		const fs = createPackageFs();
		const one = await seedWheel(fs, "one", "1.0", { "shared/mod.py": "SAME\n" });
		const two = await seedWheel(fs, "two", "1.0", { "shared/mod.py": "SAME\n" });

		const result = await publish(fs, [one, two]);

		expect(result.notes).toEqual([]);
		expect(fs.ledger.size).toBe(2);
	});

	it("refuses over the sandbox byte quota, naming the number and the knob", async () => {
		const fs = createPackageFs();
		const one = await seedWheel(fs, "one", "1.0", { "one/mod.py": "0123456789\n" });

		await expect(publish(fs, [one], { sandboxQuotaBytes: 5 })).rejects.toThrow(
			"installed packages would use 11 bytes, over this sandbox's 5 byte limit (PIP_SANDBOX_QUOTA_BYTES)",
		);
		expect(fs.ledger.size).toBe(0);
	});

	it("refuses over the sandbox file quota, naming the number and the knob", async () => {
		const fs = createPackageFs();
		const one = await seedWheel(fs, "one", "1.0", { "one/a.py": "a\n", "one/b.py": "b\n" });

		await expect(publish(fs, [one], { sandboxMaxFiles: 1 })).rejects.toThrow(
			"installed packages would use 2 files, over this sandbox's 1 file limit (PIP_SANDBOX_MAX_FILES)",
		);
	});

	it("removes a superseded version's files, keeps an edited one, and prunes the emptied directory", async () => {
		const fs = createPackageFs();
		const old = await seedWheel(fs, "demo", "1.0", {
			"demo/gone.py": "OLD\n",
			"demo/dropped.py": "OLD\n",
			"demo/old_only/leaf.py": "OLD\n",
		});
		await publish(fs, [old]);

		// The sandbox edits a file the next version no longer ships.
		await fs.writeFile("/site-packages/demo/dropped.py", "MINE\n");

		const fresh = await seedWheel(fs, "demo", "2.0", { "demo/fresh.py": "NEW\n" });
		const result = await publish(fs, [fresh]);

		expect(result.notes).toEqual(["kept modified file /site-packages/demo/dropped.py"]);
		expect(await fs.exists("/site-packages/demo/gone.py")).toBe(false);
		expect(await fs.exists("/site-packages/demo/old_only")).toBe(false);
		expect(await fs.readFile("/site-packages/demo/dropped.py")).toBe("MINE\n");
		expect(await fs.readFile("/site-packages/demo/fresh.py")).toBe("NEW\n");
		expect(fs.ledger.get("demo")?.version).toBe("2.0");
	});

	it("overwrites an edited file the new version still ships", async () => {
		const fs = createPackageFs();
		const old = await seedWheel(fs, "demo", "1.0", { "demo/mod.py": "OLD\n" });
		await publish(fs, [old]);
		await fs.writeFile("/site-packages/demo/mod.py", "MINE\n");

		const fresh = await seedWheel(fs, "demo", "2.0", { "demo/mod.py": "NEW\n" });
		const result = await publish(fs, [fresh]);

		expect(result.notes).toEqual([]);
		expect(await fs.readFile("/site-packages/demo/mod.py")).toBe("NEW\n");
	});

	it("keeps a superseded path that another installed package still owns", async () => {
		const fs = createPackageFs();
		const shared = await seedWheel(fs, "other", "1.0", { "shared/mod.py": "SAME\n" });
		const old = await seedWheel(fs, "demo", "1.0", { "shared/mod.py": "SAME\n" });
		await publish(fs, [shared, old]);

		const fresh = await seedWheel(fs, "demo", "2.0", { "demo/new.py": "NEW\n" });
		await publish(fs, [fresh]);

		expect(await fs.exists("/site-packages/shared/mod.py")).toBe(true);
	});

	it("treats an identical (name, wheel) already in the ledger as a no-op", async () => {
		const fs = createPackageFs();
		const demo = await seedWheel(fs, "demo", "1.0", { "demo/mod.py": "A\n" });
		await publish(fs, [demo]);
		const graftedFirst = fs.graftedPaths.length;

		const result = await publish(fs, [demo]);

		expect(result.notes).toEqual(["already satisfied: demo-1.0"]);
		expect(result.grafted).toEqual([]);
		expect(fs.graftedPaths.length).toBe(graftedFirst);
	});

	it("refuses to start when the exec was already cancelled", async () => {
		const fs = createPackageFs();
		const demo = await seedWheel(fs, "demo", "1.0", { "demo/mod.py": "A\n" });

		await expect(
			publishInstall({
				ctx: context(fs, AbortSignal.abort()),
				store: fs,
				incoming: [demo],
				limits: packageLimits(),
			}),
		).rejects.toThrow("install was cancelled before anything was written");
		expect(fs.state.counters.touches).toBe(0);
		expect(fs.ledger.size).toBe(0);
	});

	it("reports the stale wheel when the graft finds a collected blob", async () => {
		const fs = createPackageFs();
		const demo = await seedWheel(fs, "demo", "1.0", { "demo/mod.py": "A\n" });
		fs.state.blobs.clear();

		const error = await publish(fs, [demo]).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(StaleManifestError);
		expect((error as StaleManifestError).wheels).toEqual([hex(demo.wheelSha256)]);
		expect(fs.ledger.size).toBe(0);
	});

	it("writes the compat overlay before the ledger row", async () => {
		const fs = createPackageFs();
		const demo = await seedWheel(fs, "demo", "1.0", { "demo/mod.py": "A\n" });
		const order: string[] = [];
		const realUpsert = fs.upsertInstalledPackages.bind(fs);
		fs.upsertInstalledPackages = async (rows) => {
			order.push("ledger");
			return realUpsert(rows);
		};

		await publishInstall({
			ctx: context(fs),
			store: fs,
			incoming: [demo],
			limits: packageLimits(),
			compatOverlay: async () => {
				order.push("overlay");
			},
		});

		expect(order).toEqual(["overlay", "ledger"]);
	});
});
