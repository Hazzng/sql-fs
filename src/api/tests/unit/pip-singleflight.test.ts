/**
 * Phase 4: the in-process wheel lease and the structured install events.
 *
 * The lease is what makes two concurrent cold installs of one wheel download it
 * once; the events are what make that claim measurable rather than asserted.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MANIFEST_FORMAT } from "../../../sql-fs/package-manifest.js";
import { packageLimits } from "../../commands/package-limits.js";
import {
	type PipLogger,
	createInProcessWheelLease,
	createInstallBudget,
	prepareWheel,
} from "../../commands/pip-wheel-store.js";
import { createPackageFs, createPackageState } from "./package-store-fake.js";
import { makeBash, sha256, wheel } from "./pip-fixtures.js";
import { buildWheel } from "./wheel-fixtures.js";

const WHEEL = buildWheel({ files: { "demo/core.py": "VALUE = 1\n" } });
const WHEEL_SHA = createHash("sha256").update(WHEEL).digest("hex");

/** Blocks the leader inside the lease until the test lets it finish. */
function gate(): { wait: Promise<void>; open: () => void } {
	let open = (): void => {};
	const wait = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { wait, open };
}

describe("in-process wheel lease", () => {
	it("downloads once and records one manifest for two concurrent cold installs", async () => {
		const state = createPackageState();
		const lease = createInProcessWheelLease();
		const events: Record<string, unknown>[] = [];
		const log: PipLogger = (event) => events.push(event);
		const leader = gate();
		let downloads = 0;

		const start = (blockFirst: boolean): Promise<unknown> =>
			prepareWheel({
				store: createPackageFs(state),
				target: { name: "demo", version: "1.0", sha256: WHEEL_SHA },
				limits: packageLimits(),
				budget: createInstallBudget(),
				lease,
				log,
				download: async () => {
					downloads += 1;
					if (blockFirst) await leader.wait;
					return WHEEL;
				},
			});

		const first = start(true);
		const second = start(false);
		leader.open();
		await Promise.all([first, second]);

		expect(downloads).toBe(1);
		expect(state.counters.records).toBe(1);
		expect(events.map((event) => event.event)).toEqual([
			"pip_manifest_miss",
			"pip_singleflight_wait",
			"pip_manifest_hit",
		]);
	});

	it("clears the map entry on rejection so the next caller re-runs the work", async () => {
		const lease = createInProcessWheelLease();
		const calls: number[] = [];
		const run = (index: number, fail: boolean): Promise<string> =>
			lease("sha", async () => {
				calls.push(index);
				if (fail) throw new Error("boom");
				return "ok";
			});

		await expect(run(1, true)).rejects.toThrow("boom");
		await expect(run(2, false)).resolves.toBe("ok");
		expect(calls).toEqual([1, 2]);
	});

	it("reports no wait to the first caller and a measured wait to the second", async () => {
		const lease = createInProcessWheelLease();
		const waits: number[] = [];
		const leader = gate();
		const first = lease("sha", async (info) => {
			waits.push(info.waitedMs);
			await leader.wait;
		});
		const second = lease("sha", async (info) => {
			waits.push(info.waitedMs);
		});
		leader.open();
		await Promise.all([first, second]);

		expect(waits.length).toBe(2);
		expect(waits[0]).toBe(0);
		expect(waits[1]).toBeGreaterThanOrEqual(0);
	});
});

describe("install log events", () => {
	const body = wheel("demo", "1.0", { "demo.py": "VALUE = 1\n" });
	const hash = sha256(body);
	const packages = { demo: { version: "1.0", body } };

	it("emits a miss and a publish on a cold install", async () => {
		const events: Record<string, unknown>[] = [];
		const bash = makeBash(packages, { log: (event) => events.push(event) });
		const result = await bash.exec("pip install demo");

		expect(result.exitCode, result.stderr).toBe(0);
		expect(events).toEqual([
			{
				event: "pip_manifest_miss",
				wheel: hash,
				name: "demo",
				version: "1.0",
				fileCount: 4,
				bytes: 383,
				elapsedMs: expect.any(Number),
			},
			{
				event: "pip_publish",
				wheel: hash,
				name: "demo",
				version: "1.0",
				fileCount: 4,
				bytes: 383,
				elapsedMs: expect.any(Number),
			},
		]);
	});

	it("emits a hit when a second sandbox installs the wheel the first one stored", async () => {
		const state = createPackageState();
		await makeBash(packages, {}, state).exec("pip install demo");
		const events: Record<string, unknown>[] = [];
		const second = makeBash(packages, { log: (event) => events.push(event) }, state);
		const result = await second.exec("pip install demo");

		expect(result.exitCode, result.stderr).toBe(0);
		expect(events[0]).toEqual({
			event: "pip_manifest_hit",
			wheel: hash,
			name: "demo",
			version: "1.0",
			fileCount: 4,
			bytes: 383,
			elapsedMs: expect.any(Number),
		});
		expect(state.counters.records).toBe(1);
	});

	it("emits a wait event carrying both durations when the lease queued", async () => {
		const events: Record<string, unknown>[] = [];
		const store = createPackageFs();
		const manifest = await prepareWheel({
			store,
			target: { name: "demo", version: "1.0", sha256: WHEEL_SHA },
			limits: packageLimits(),
			budget: createInstallBudget(),
			// A lease that always reports a wait, which is what the second caller of
			// a contended hash sees.
			lease: (_key, fn) => fn({ waitedMs: 7 }),
			log: (event) => events.push(event),
			download: async () => WHEEL,
		});

		expect(manifest.manifestFormat).toBe(MANIFEST_FORMAT);
		expect(events[0]).toEqual({
			event: "pip_singleflight_wait",
			wheel: WHEEL_SHA,
			name: "demo",
			version: "1.0",
			fileCount: manifest.fileCount,
			bytes: manifest.totalBytes,
			elapsedMs: expect.any(Number),
			waitedMs: 7,
		});
		expect(events[1]?.event).toBe("pip_manifest_miss");
	});
});
