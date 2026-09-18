/**
 * Phase W: one wheel's bytes become durable and reusable, or the install
 * refuses. Nothing here touches a sandbox tree.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MANIFEST_FORMAT } from "../../../sql-fs/package-manifest.js";
import type { PackageManifest } from "../../../sql-fs/types.js";
import { type PackageLimits, packageLimits } from "../../commands/package-limits.js";
import { createInProcessWheelLease, createInstallBudget, prepareWheel } from "../../commands/pip-wheel-store.js";
import { type FakePackageFs, createPackageFs, createPackageState, hex } from "./package-store-fake.js";
import { buildWheel } from "./wheel-fixtures.js";

const lease = createInProcessWheelLease();

function sha256(body: Uint8Array): string {
	return createHash("sha256").update(body).digest("hex");
}

interface Harness {
	readonly fs: FakePackageFs;
	readonly wheel: Uint8Array;
	downloads: number;
	prepare: (limits?: PackageLimits) => Promise<PackageManifest>;
}

function harness(wheel: Uint8Array, fs: FakePackageFs = createPackageFs()): Harness {
	const state: Harness = {
		fs,
		wheel,
		downloads: 0,
		prepare: async () => {
			throw new Error("unset");
		},
	};
	state.prepare = (limits = packageLimits()) =>
		prepareWheel({
			store: fs,
			target: { name: "demo", version: "1.0", sha256: sha256(wheel) },
			limits,
			budget: createInstallBudget(),
			lease,
			download: async () => {
				state.downloads += 1;
				return wheel;
			},
		});
	return state;
}

describe("pip Phase W", () => {
	it("records one manifest and every blob on a cold wheel", async () => {
		const h = harness(buildWheel({ files: { "demo/core.py": "VALUE = 1\n" } }));
		const manifest = await h.prepare();

		expect(h.downloads).toBe(1);
		expect(manifest.manifestFormat).toBe(MANIFEST_FORMAT);
		expect(manifest.fileCount).toBe(5);
		expect(h.fs.state.counters.records).toBe(1);
		expect(h.fs.state.manifests.get(hex(manifest.wheelSha256))?.files.map((f) => f.path)).toEqual([
			"/site-packages/demo/__init__.py",
			"/site-packages/demo/core.py",
			"/site-packages/demo-1.0.dist-info/METADATA",
			"/site-packages/demo-1.0.dist-info/WHEEL",
			"/site-packages/demo-1.0.dist-info/RECORD",
		]);
	});

	it("skips the download and the ingest when the manifest is already recorded", async () => {
		const wheel = buildWheel({ files: { "demo/core.py": "VALUE = 1\n" } });
		const shared = createPackageState();
		const first = harness(wheel, createPackageFs(shared));
		await first.prepare();
		const ingestsAfterFirst = shared.counters.ingestCalls;

		// A different sandbox, same tenant-global state.
		const second = harness(wheel, createPackageFs(shared));
		await second.prepare();

		expect(second.downloads).toBe(0);
		expect(shared.counters.ingestCalls).toBe(ingestsAfterFirst);
		expect(shared.counters.records).toBe(1);
	});

	it("ingests every batch of a wheel that spans more than one batch", async () => {
		const files: Record<string, string> = {};
		for (let index = 0; index < 600; index++) files[`demo/mod_${index}.py`] = `N = ${index}\n`;
		const h = harness(buildWheel({ files }));
		const manifest = await h.prepare();

		expect(h.fs.state.counters.ingestCalls).toBe(2);
		expect(h.fs.state.counters.ingestedBlobs).toBe(manifest.fileCount);
		for (const file of h.fs.state.manifests.get(hex(manifest.wheelSha256))!.files) {
			expect(h.fs.state.blobs.has(hex(file.sha256))).toBe(true);
		}
	});

	it("fails naming the package when the downloaded bytes do not match the PyPI hash", async () => {
		const wheel = buildWheel({});
		const fs = createPackageFs();
		await expect(
			prepareWheel({
				store: fs,
				target: { name: "demo", version: "1.0", sha256: "0".repeat(64) },
				limits: packageLimits(),
				budget: createInstallBudget(),
				lease,
				download: async () => wheel,
			}),
		).rejects.toThrow("SHA-256 verification failed for demo 1.0");
		expect(fs.state.manifests.size).toBe(0);
	});

	it("re-ingests and retries once when recordManifest reports a collected blob", async () => {
		const h = harness(buildWheel({ files: { "demo/core.py": "VALUE = 1\n" } }));
		const realRecord = h.fs.recordManifest.bind(h.fs);
		let attempts = 0;
		h.fs.recordManifest = async (manifest, files) => {
			attempts += 1;
			if (attempts === 1) {
				// Simulate the GC window: the blobs vanish between ingest and record.
				h.fs.state.blobs.clear();
				throw Object.assign(new Error("EGRAFTMISSING"), { code: "EGRAFTMISSING", missing: [hex(files[0]!.sha256)] });
			}
			return realRecord(manifest, files);
		};

		const manifest = await h.prepare();

		expect(attempts).toBe(2);
		expect(h.downloads).toBe(1);
		expect(h.fs.state.manifests.has(hex(manifest.wheelSha256))).toBe(true);
	});

	it("charges the file budget across wheels and refuses the one that crosses it", async () => {
		const limits: PackageLimits = { ...packageLimits(), maxInstallFiles: 6 };
		const budget = createInstallBudget();
		const first = buildWheel({ name: "one", files: { "one/a.py": "a\n" } });
		const second = buildWheel({ name: "two", files: { "two/a.py": "a\n" } });
		const fs = createPackageFs();
		const prepare = (wheel: Uint8Array, name: string) =>
			prepareWheel({
				store: fs,
				target: { name, version: "1.0", sha256: sha256(wheel) },
				limits,
				budget,
				lease,
				download: async () => wheel,
			});

		await prepare(first, "one");
		expect(budget.files).toBe(5);
		await expect(prepare(second, "two")).rejects.toThrow("install exceeds 6 files (PIP_MAX_INSTALL_FILES)");
	});

	it("charges the download budget across wheels", async () => {
		const wheel = buildWheel({ files: { "demo/core.py": "VALUE = 1\n" } });
		const limits: PackageLimits = { ...packageLimits(), maxInstallDownloadBytes: wheel.byteLength };
		const budget = createInstallBudget();
		const fs = createPackageFs();
		const other = buildWheel({ name: "other", files: { "other/core.py": "VALUE = 2\n" } });
		const prepare = (body: Uint8Array, name: string) =>
			prepareWheel({
				store: fs,
				target: { name, version: "1.0", sha256: sha256(body) },
				limits,
				budget,
				lease,
				download: async () => body,
			});

		await prepare(wheel, "demo");
		await expect(prepare(other, "other")).rejects.toThrow(
			`install downloads exceed ${wheel.byteLength} bytes (PIP_MAX_INSTALL_DOWNLOAD_BYTES)`,
		);
	});
});
