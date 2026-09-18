/**
 * Wheel reader — every archive that must be refused, and the layer that must
 * refuse it. All of these throw `WheelError`; none may reach the caller as a
 * raw zlib or yauzl failure.
 */

import { describe, expect, it } from "vitest";
import { packageLimits } from "../../commands/package-limits.js";
import { WheelError, readWheel } from "../../commands/wheel-reader.js";
import { SYMLINK_ATTRS, buildWheel, buildZip } from "./wheel-fixtures.js";

async function drain(wheel: Uint8Array, options = {}): Promise<void> {
	for await (const batch of readWheel(wheel, options)) void batch;
}

async function refusal(wheel: Uint8Array, options = {}): Promise<Error> {
	try {
		await drain(wheel, options);
	} catch (err) {
		expect(err).toBeInstanceOf(WheelError);
		return err as Error;
	}
	throw new Error("expected the wheel to be refused");
}

describe("readWheel — hostile paths", () => {
	// yauzl's own file-name validation fires before ours for these three; the
	// reader still surfaces exactly one installer error.
	it("refuses a parent-directory traversal", async () => {
		const err = await refusal(buildWheel({ extraEntries: [{ name: "../escape.py", content: "x\n" }] }));

		expect(err.message).toBe("corrupt or hostile archive: invalid relative path: ../escape.py");
	});

	it("refuses an absolute path", async () => {
		const err = await refusal(buildWheel({ extraEntries: [{ name: "/etc/passwd", content: "x\n" }] }));

		expect(err.message).toBe("corrupt or hostile archive: absolute path: /etc/passwd");
	});

	it("refuses a backslash path", async () => {
		const err = await refusal(buildWheel({ extraEntries: [{ name: "demo\\evil.py", content: "x\n" }] }));

		expect(err.message).toBe("corrupt or hostile archive: invalid characters in fileName: demo\\evil.py");
	});

	it("refuses a NUL byte in a path", async () => {
		const err = await refusal(buildWheel({ extraEntries: [{ name: "demo/a\0b.py", content: "x\n" }] }));

		expect(err.message).toBe("wheel contains an unsafe path: NUL byte in path 'demo/ab.py'");
	});

	it("refuses a path longer than 512 characters", async () => {
		const long = `demo/${"a".repeat(600)}.py`;
		const err = await refusal(buildWheel({ extraEntries: [{ name: long, content: "x\n" }] }));

		expect(err.message.startsWith("wheel contains an unsafe path: path longer than 512 characters")).toBe(true);
	});

	it("refuses duplicate paths", async () => {
		const err = await refusal(buildWheel({ extraEntries: [{ name: "demo/__init__.py", content: "different\n" }] }));

		expect(err.message).toBe("wheel contains duplicate paths: 'demo/__init__.py'");
	});

	it("refuses a directory and a file at the same path", async () => {
		const err = await refusal(buildWheel({ files: { "demo/pkg": "file\n", "demo/pkg/mod.py": "inner\n" } }));

		expect(err.message).toBe("wheel contains a directory and a file at 'demo/pkg'");
	});
});

describe("readWheel — hostile entry metadata", () => {
	it("refuses a symlink entry", async () => {
		const err = await refusal(
			buildWheel({ extraEntries: [{ name: "demo/link", content: "/etc/passwd", externalAttrs: SYMLINK_ATTRS }] }),
		);

		expect(err.message).toBe("wheel contains a symbolic link: 'demo/link'");
	});

	it("refuses an encrypted entry", async () => {
		const err = await refusal(
			buildWheel({ extraEntries: [{ name: "demo/enc.py", content: "x\n", method: 8, flags: 0x1 }] }),
		);

		expect(err.message).toBe("wheel entry 'demo/enc.py' is encrypted");
	});

	it("refuses an unsupported compression method", async () => {
		const err = await refusal(
			buildWheel({ extraEntries: [{ name: "demo/lzma.py", content: "x\n", method: 14, local: { method: 14 } }] }),
		);

		expect(err.message).toBe("wheel entry 'demo/lzma.py' uses unsupported compression method 14");
	});

	it("refuses a data descriptor with unknown sizes", async () => {
		const err = await refusal(
			buildWheel({
				extraEntries: [{ name: "demo/stream.py", content: "", flags: 0x8, crc: 0 }],
			}),
		);

		expect(err.message).toBe("wheel entry 'demo/stream.py' has a data descriptor with unknown sizes");
	});

	it("refuses an entry over the per-file byte limit", async () => {
		const limits = { ...packageLimits(), maxFileBytes: 8 };
		const err = await refusal(buildWheel({ files: { "demo/big.py": "0123456789" } }), { limits });

		expect(err.message).toBe("wheel entry 'demo/big.py' declares 10 bytes, over the 8 byte limit (PIP_MAX_FILE_BYTES)");
	});

	it("refuses an install over the extracted-byte limit", async () => {
		const limits = { ...packageLimits(), maxInstallBytes: 20 };
		const err = await refusal(buildWheel({ files: { "demo/a.py": "0123456789" } }), { limits });

		expect(err.message).toBe("install exceeds 20 extracted bytes (PIP_MAX_INSTALL_BYTES)");
	});

	it("refuses an install over the file-count limit, counting earlier wheels", async () => {
		const limits = { ...packageLimits(), maxInstallFiles: 6 };
		const err = await refusal(buildWheel(), { limits, consumedFiles: 3 });

		expect(err.message).toBe("install exceeds 6 files (PIP_MAX_INSTALL_FILES)");
	});

	it("refuses a wheel over the archive byte limit", async () => {
		const limits = { ...packageLimits(), maxWheelBytes: 100 };
		const err = await refusal(buildWheel(), { limits });

		expect(err.message.includes("(PIP_MAX_WHEEL_BYTES)")).toBe(true);
	});
});

describe("readWheel — corrupt content", () => {
	it("refuses an entry whose CRC-32 does not match", async () => {
		const err = await refusal(
			buildWheel({ files: { "demo/mod.py": "hello\n" }, entryOverrides: { "demo/mod.py": { crc: 0x1234 } } }),
		);

		expect(err.message).toBe("corrupt or hostile archive: entry 'demo/mod.py' failed its CRC-32 check");
	});

	it("refuses an entry that declares more bytes than it holds", async () => {
		const err = await refusal(
			buildWheel({
				files: { "demo/mod.py": "hello\n" },
				entryOverrides: { "demo/mod.py": { method: 8, declaredSize: 99 } },
			}),
		);

		expect(err.message).toBe("wheel entry 'demo/mod.py' produced 6 bytes but declares 99");
	});

	it("refuses an entry that declares fewer bytes than it holds", async () => {
		const wheel = buildWheel({
			files: { "demo/mod.py": "hello world\n" },
			method: 8,
			entryOverrides: { "demo/mod.py": { method: 8, declaredSize: 3 } },
		});

		const err = await refusal(wheel);

		expect(err.message).toBe("wheel entry 'demo/mod.py' is larger than its declared size of 3 bytes");
	});

	it("refuses a local header that disagrees with the central directory", async () => {
		const wheel = buildWheel({
			files: { "demo/mod.py": "hello\n" },
			entryOverrides: { "demo/mod.py": { local: { crc: 0x9999 } } },
		});

		const err = await refusal(wheel);

		expect(err.message).toBe("wheel entry 'demo/mod.py' disagrees with its local header on CRC-32");
	});

	it("refuses a local header whose file name differs", async () => {
		const wheel = buildWheel({
			files: { "demo/mod.py": "hello\n" },
			entryOverrides: { "demo/mod.py": { local: { name: "demo/other.py" } } },
		});

		const err = await refusal(wheel);

		expect(err.message).toBe("wheel entry 'demo/mod.py' disagrees with its local header on file name");
	});

	it("refuses undecompressable deflate data as a corrupt archive", async () => {
		const wheel = buildWheel({ files: { "demo/mod.py": "hello\n" }, method: 8 });
		// Corrupt the first entry's payload: 30-byte local header + a 16-byte name.
		const copy = Uint8Array.from(wheel);
		copy[47] = copy[47]! ^ 0xff;
		copy[48] = copy[48]! ^ 0xff;

		const err = await refusal(copy);

		expect(err.message.startsWith("corrupt or hostile archive")).toBe(true);
	});

	it("refuses a buffer that is not a zip at all", async () => {
		const err = await refusal(new Uint8Array(64).fill(7));

		expect(err.message.startsWith("corrupt or hostile archive")).toBe(true);
	});
});

describe("readWheel — wheel metadata", () => {
	it("refuses a wheel with no RECORD entry for a file", async () => {
		const err = await refusal(buildWheel({ files: { "demo/mod.py": "x\n" }, omitFromRecord: ["demo/mod.py"] }));

		expect(err.message).toBe("wheel entry 'demo/mod.py' is missing a sha256 entry in RECORD");
	});

	it("refuses a file whose RECORD hash does not match", async () => {
		const err = await refusal(buildWheel({ files: { "demo/mod.py": "x\n" }, corruptRecordFor: ["demo/mod.py"] }));

		expect(err.message).toBe("wheel entry 'demo/mod.py' does not match its RECORD sha256");
	});

	it("refuses a non-purelib wheel", async () => {
		const err = await refusal(buildWheel({ wheelMetadata: "Wheel-Version: 1.0\nRoot-Is-Purelib: false\n" }));

		expect(err.message).toBe("only pure-Python wheels are supported (Root-Is-Purelib must be true)");
	});

	it("refuses an unsupported Wheel-Version", async () => {
		const err = await refusal(buildWheel({ wheelMetadata: "Wheel-Version: 2.0\nRoot-Is-Purelib: true\n" }));

		expect(err.message).toBe("unsupported Wheel-Version '2.0' (only 1.x is supported)");
	});

	it("refuses an archive with no dist-info directory", async () => {
		const err = await refusal(buildZip([{ name: "demo/mod.py", content: "x\n" }]));

		expect(err.message).toBe("wheel has no .dist-info directory");
	});

	it("refuses an archive with two dist-info directories", async () => {
		const err = await refusal(buildWheel({ extraEntries: [{ name: "other-2.0.dist-info/WHEEL", content: "x\n" }] }));

		expect(err.message).toBe("wheel has more than one .dist-info directory");
	});
});
