/**
 * Regression tests: SessionManager must pass `false` (not `undefined`) to the
 * `Bash` constructor when defense-in-depth is disabled.
 *
 * just-bash's `Bash` constructor does `t.defenseInDepth ?? true`, so omitting
 * the option enables defense-in-depth with default config — silently flipping
 * the rollout flag and changing production behavior.
 */

import { InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../session-manager.js";

const T = "default";

describe("SessionManager defense-in-depth wiring", () => {
	it("disabled flag passes false to Bash so just-bash does not default to true", async () => {
		const sm = new SessionManager({
			createFs: async () => new InMemoryFs(),
			defenseInDepth: false,
		});

		const session = await sm.getOrCreate(T, "sandbox-defense-off");

		// just-bash stores the option as `t.defenseInDepth ?? true`. Reading it
		// back as `false` proves the SessionManager passed `false` explicitly
		// rather than `undefined` (which would have nullish-coalesced to `true`).
		expect((session.bash as unknown as { defenseInDepthConfig: unknown }).defenseInDepthConfig).toBe(false);
	});

	it("default (no env var, no override) is disabled and passes false", async () => {
		const prev = process.env.JUST_BASH_DEFENSE_IN_DEPTH;
		process.env.JUST_BASH_DEFENSE_IN_DEPTH = undefined;
		try {
			const sm = new SessionManager({
				createFs: async () => new InMemoryFs(),
			});

			const session = await sm.getOrCreate(T, "sandbox-defense-default");

			expect((session.bash as unknown as { defenseInDepthConfig: unknown }).defenseInDepthConfig).toBe(false);
		} finally {
			if (prev !== undefined) process.env.JUST_BASH_DEFENSE_IN_DEPTH = prev;
		}
	});

	it("enabled flag passes a config object with auditMode honored", async () => {
		const sm = new SessionManager({
			createFs: async () => new InMemoryFs(),
			defenseInDepth: true,
			defenseAuditMode: false,
		});

		const session = await sm.getOrCreate(T, "sandbox-defense-on");

		const cfg = (session.bash as unknown as { defenseInDepthConfig: unknown }).defenseInDepthConfig;
		expect(cfg).toMatchObject({ enabled: true, auditMode: false });
	});
});
