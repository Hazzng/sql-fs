import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requireMigratedSchema } from "../../../sql-fs/tests/integration/helpers/schema-preconditions.js";
import { RuntimeBridgeFixture } from "./helpers/runtime-bridge.js";

describe.skipIf(!process.env.DATABASE_URL)(
	"bounded worker JavaScript bridge with an operator 64 MiB file override",
	() => {
		let fixture: RuntimeBridgeFixture | undefined;

		beforeAll(async () => {
			await requireMigratedSchema(process.env.DATABASE_URL ?? "");
		});

		beforeEach(() => vi.stubEnv("MAX_EXEC_FILE_BYTES", "67108864"));

		afterEach(async () => {
			try {
				await fixture?.close();
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it("reads 16 MiB through the bounded filesystem bridge", async () => {
			fixture = new RuntimeBridgeFixture();
			await fixture.ready();
			const size = 16 * 1024 * 1024;
			const chunk = 1024 * 1024;
			const markers = [
				[0, 0],
				[chunk - 1, 255],
				[chunk, 128],
				[2 * chunk - 1, 1],
				[2 * chunk, 254],
				[size - 1, 127],
			] as const;
			const sha256 = await fixture.put(size, markers);
			const result = await fixture.exec(
				`js-exec -c 'const d=require("fs").readFileSync("/home/user/input"); console.log(JSON.stringify([d.length,...${JSON.stringify(markers.map(([offset]) => offset))}.map(i=>d.readUInt8(i))]))'`,
			);
			expect(result.stderr).toBe("");
			expect(result).toMatchObject({
				exitCode: 0,
				stdout: `${JSON.stringify([size, ...markers.map(([, value]) => value)])}\n`,
			});
			await fixture.verifyAndReuse(sha256);
		});

		it("rejects a 49 MiB whole-file read within its finite budget and keeps the owner healthy", async () => {
			fixture = new RuntimeBridgeFixture();
			await fixture.ready();
			const sha256 = await fixture.put(49 * 1024 * 1024);
			const result = await fixture.exec(
				`js-exec -c 'console.log(require("fs").readFileSync("/home/user/input").length)'`,
			);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("JavaScript bridge read limit");
			await fixture.verifyAndReuse(sha256);
		});
	},
);
