import { Bash, DefenseInDepthBox } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEfbig } from "../../errors.js";

describe("EFBIG construction during protected execution", () => {
	afterEach(() => {
		DefenseInDepthBox.resetInstance();
		vi.unstubAllEnvs();
	});

	it("uses live host caps while keeping sandbox environment reads blocked", async () => {
		DefenseInDepthBox.resetInstance();
		const violations: string[] = [];
		const messages: string[] = [];
		const bash = new Bash({
			defenseInDepth: {
				enabled: true,
				auditMode: false,
				onViolation: (violation) => violations.push(violation.type),
			},
			customCommands: [
				{
					name: "probe-config",
					trusted: false,
					execute: async () => {
						const read = createEfbig("/input", 9, 8, "read");
						const write = createEfbig("/output", 9, 8, "write");
						messages.push(read.message, write.message);
						let blocked = 0;
						for (const key of ["MAX_MCP_READ_FILE_BYTES", "MAX_FILE_WRITE_BYTES"]) {
							try {
								void process.env[key];
							} catch {
								blocked++;
							}
						}
						return { stdout: String(blocked), stderr: "", exitCode: 0 };
					},
				},
			],
		});

		for (const [mcp, write] of [
			[123456, 654321],
			[234567, 765432],
		]) {
			vi.stubEnv("MAX_MCP_READ_FILE_BYTES", String(mcp));
			vi.stubEnv("MAX_FILE_WRITE_BYTES", String(write));
			expect(await bash.exec("probe-config")).toMatchObject({ stdout: "2", stderr: "", exitCode: 0 });
			expect(messages.at(-2)).toContain(`capped separately at ${mcp} bytes`);
			expect(messages.at(-1)).toContain(`capped independently at ${write} bytes`);
		}
		expect(violations.filter((type) => type === "process_env")).toHaveLength(4);
	});
});
