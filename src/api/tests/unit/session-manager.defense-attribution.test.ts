import { DefenseInDepthBox, InMemoryFs } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../session-manager.js";

describe("SessionManager defense audit attribution", () => {
	const managers: SessionManager[] = [];

	beforeEach(() => DefenseInDepthBox.resetInstance());
	afterEach(async () => {
		DefenseInDepthBox.resetInstance();
		vi.restoreAllMocks();
		await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
	});

	function manager(): SessionManager {
		const result = new SessionManager({
			createFs: async () => new InMemoryFs(),
			defenseInDepth: true,
			defenseAuditMode: false,
		});
		managers.push(result);
		return result;
	}

	it("executes two owners' sandboxes with one compatible defense configuration", async () => {
		const sm = manager();
		const first = await sm.getOrCreate("tenant", "sandbox-first", undefined, "owner-first");
		expect(await sm.execWithRuntimeThrottle(first, "echo first")).toMatchObject({
			stdout: "first\n",
			exitCode: 0,
		});

		const second = await sm.getOrCreate("tenant", "sandbox-second", undefined, "owner-second");
		expect(await sm.execWithRuntimeThrottle(second, "echo second")).toMatchObject({
			stdout: "second\n",
			exitCode: 0,
		});
	});

	it("attributes concurrent blocked commands to their calling sandbox across managers", async () => {
		const firstManager = manager();
		const secondManager = manager();
		const first = await firstManager.getOrCreate("tenant", "sandbox-first", undefined, "owner-first");
		const second = await secondManager.getOrCreate("tenant", "sandbox-second", undefined, "owner-second");
		const logs = vi.spyOn(console, "log").mockImplementation(() => {});

		for (const session of [first, second]) {
			session.bash.registerCommand({
				name: "probe-defense",
				trusted: false,
				execute: async (_args, ctx) => {
					await ctx.fs.stat("/");
					try {
						globalThis.Function("return 1")();
						return { stdout: "escaped\n", stderr: "", exitCode: 1 };
					} catch {
						return { stdout: "blocked\n", stderr: "", exitCode: 0 };
					}
				},
			});
		}

		const results = await Promise.all([
			firstManager.execWithRuntimeThrottle(first, "probe-defense"),
			secondManager.execWithRuntimeThrottle(second, "probe-defense"),
		]);
		expect(results.map((result) => result.stdout)).toEqual(["blocked\n", "blocked\n"]);
		const violations = logs.mock.calls
			.map(([line]) => JSON.parse(String(line)) as { event: string; type: string; sandboxId: string })
			.filter((entry) => entry.event === "defense_in_depth_violation" && entry.type === "function_constructor");
		expect(violations.map((entry) => entry.sandboxId).sort()).toEqual(["sandbox-first", "sandbox-second"]);
	});
});
