/**
 * Wheel reader — bit-flip fuzz. A mutated archive must either read cleanly with
 * every hash verified, or fail with a `WheelError`. A raw zlib/yauzl error, an
 * unhandled rejection or a hang is a bug.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WheelError, readWheel } from "../../commands/wheel-reader.js";
import { buildWheel } from "./wheel-fixtures.js";

/** Deterministic PRNG so a failure is reproducible from the seed. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const BASE = buildWheel({
	files: {
		"demo/mod.py": "def f():\n    return 42\n",
		"demo/data.txt": "x".repeat(400),
		"demo/sub/other.py": "import demo\n",
	},
	method: 8,
});

describe("readWheel — bit-flip fuzz", () => {
	it("either verifies or refuses every mutation of a valid wheel", async () => {
		const random = mulberry32(0x5eed);
		let refused = 0;
		let accepted = 0;

		for (let round = 0; round < 200; round++) {
			const mutated = Uint8Array.from(BASE);
			const flips = 1 + Math.floor(random() * 3);
			for (let i = 0; i < flips; i++) {
				const index = Math.floor(random() * mutated.length);
				mutated[index] = mutated[index]! ^ (1 << Math.floor(random() * 8));
			}

			try {
				for await (const batch of readWheel(mutated)) {
					for (const file of batch) {
						const digest = createHash("sha256").update(Buffer.from(file.content)).digest();
						expect(Buffer.from(file.sha256).equals(digest)).toBe(true);
						expect(file.content.byteLength).toBe(file.size);
					}
				}
				accepted += 1;
			} catch (err) {
				expect(err, `round ${round} threw a non-WheelError`).toBeInstanceOf(WheelError);
				refused += 1;
			}
		}

		expect(refused + accepted).toBe(200);
		expect(refused).toBeGreaterThan(0);
	}, 30_000);
});
