/**
 * Host-side wheel (ZIP) reader. Validates the whole central directory before
 * inflating anything, then yields verified files in bounded batches.
 *
 * Built on `yauzl`, with three things it does not do: local-vs-central header
 * agreement (yauzl only checks the local signature and bounds), a bounded
 * inflate (entries are opened raw and piped through our own
 * `createInflateRaw({ maxOutputLength })` plus a byte counter), and the
 * wheel-level rules — WHEEL, RECORD, symlinks, encryption, collisions, limits.
 *
 * Nothing here is synchronous: no `inflateRawSync`, no sync zlib call.
 */

import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import yauzl from "yauzl";
import { packageEntryPathProblem } from "../../sql-fs/package-path.js";
import { PACKAGE_LIMIT_ENV, type PackageLimits, packageLimits } from "./package-limits.js";

/** Error raised for every rejected or corrupt archive. */
export class WheelError extends Error {
	readonly code = "PIP_WHEEL_ERROR";
}

/** One verified file ready to be turned into a blob + inode. */
export interface WheelFile {
	/** Archive-relative path, e.g. `pkg/mod.py` or `pkg-1.0.data/scripts/x`. */
	readonly path: string;
	readonly sha256: Uint8Array;
	readonly mode: number;
	readonly size: number;
	readonly content: Uint8Array;
}

/** Totals for the whole archive, known from the central directory. */
export interface WheelInfo {
	readonly distInfoDir: string;
	readonly fileCount: number;
	readonly totalBytes: number;
}

export interface WheelReadOptions {
	readonly limits?: PackageLimits;
	/** Flush a batch once this many inflated bytes are buffered (default 8 MB). */
	readonly maxBatchBytes?: number;
	/** Flush a batch once it holds this many entries (default 500). */
	readonly maxBatchEntries?: number;
	/** Budget already consumed by earlier wheels of the same install. */
	readonly consumedFiles?: number;
	readonly consumedBytes?: number;
}

const DEFAULT_BATCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_BATCH_ENTRIES = 500;

/** General purpose bit flags we care about. */
const FLAG_ENCRYPTED = 0x1;
const FLAG_DATA_DESCRIPTOR = 0x8;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IXUGO = 0o111;

/** A zlib/stream failure must never leak its own wording to the installer. */
const CORRUPT = "corrupt or hostile archive";

function fail(message: string): never {
	throw new WheelError(message);
}

/** Keeps a third-party message short enough to be safe in installer output. */
function briefly(err: unknown): string {
	const message = err instanceof Error ? err.message : "";
	return message.length > 0 && message.length < 160 ? message : "unreadable zip";
}

/** Decodes a PEP 376 RECORD hash (`sha256=<urlsafe-base64, no padding>`). */
function decodeRecordHash(value: string): Uint8Array | null {
	if (!value.startsWith("sha256=")) return null;
	const b64 = value.slice("sha256=".length).replace(/-/g, "+").replace(/_/g, "/");
	if (b64 === "") return null;
	const bytes = Buffer.from(b64, "base64");
	return bytes.length === 32 ? new Uint8Array(bytes) : null;
}

/** Splits a RECORD line into its three fields, honouring quoted paths. */
function parseRecordLine(line: string): { path: string; hash: string } | null {
	const trimmed = line.trim();
	if (trimmed === "") return null;
	// A path containing a comma is quoted per RFC 4180; the other fields are not.
	let path: string;
	let rest: string;
	if (trimmed.startsWith('"')) {
		const close = trimmed.indexOf('"', 1);
		if (close < 0) return null;
		path = trimmed.slice(1, close);
		rest = trimmed.slice(close + 2);
	} else {
		const comma = trimmed.indexOf(",");
		if (comma < 0) return null;
		path = trimmed.slice(0, comma);
		rest = trimmed.slice(comma + 1);
	}
	const nextComma = rest.indexOf(",");
	return { path, hash: nextComma < 0 ? rest : rest.slice(0, nextComma) };
}

interface ValidatedEntry {
	readonly entry: yauzl.Entry;
	readonly path: string;
	readonly mode: number;
	readonly size: number;
}

/** Every file lands on 0o644 or 0o755 — no setuid, no world-writable. */
function normalisedMode(entry: yauzl.Entry): number {
	const external = (entry.externalFileAttributes >>> 16) & 0xffff;
	return (external & S_IXUGO) !== 0 ? 0o755 : 0o644;
}

function isSymlink(entry: yauzl.Entry): boolean {
	const external = (entry.externalFileAttributes >>> 16) & 0xffff;
	return (external & S_IFMT) === S_IFLNK;
}

/** Reads the whole central directory; yauzl is driven in lazy-entry mode. */
async function readCentralDirectory(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
	const entries: yauzl.Entry[] = [];
	for await (const entry of zip.eachEntry()) entries.push(entry);
	return entries;
}

/**
 * Every check that can be made without inflating anything. Throws on the first
 * problem; returns the file entries in archive order plus the archive totals.
 */
function validateEntries(
	entries: readonly yauzl.Entry[],
	limits: PackageLimits,
	consumedFiles: number,
	consumedBytes: number,
): { files: ValidatedEntry[]; totalBytes: number } {
	const files: ValidatedEntry[] = [];
	const seen = new Set<string>();
	const dirPaths = new Set<string>();
	let totalBytes = consumedBytes;
	let fileCount = consumedFiles;

	for (const entry of entries) {
		const raw = entry.fileName;
		const isDir = raw.endsWith("/");
		const path = isDir ? raw.slice(0, -1) : raw;

		const problem = packageEntryPathProblem(path);
		if (problem !== null) fail(`wheel contains an unsafe path: ${problem}`);
		if (seen.has(path)) fail(`wheel contains duplicate paths: '${path}'`);
		seen.add(path);

		if ((entry.generalPurposeBitFlag & FLAG_ENCRYPTED) !== 0) {
			fail(`wheel entry '${path}' is encrypted`);
		}
		if (isSymlink(entry)) fail(`wheel contains a symbolic link: '${path}'`);

		if (isDir) {
			dirPaths.add(path);
			continue;
		}

		if (entry.compressionMethod !== METHOD_STORED && entry.compressionMethod !== METHOD_DEFLATE) {
			fail(`wheel entry '${path}' uses unsupported compression method ${entry.compressionMethod}`);
		}
		if (
			(entry.generalPurposeBitFlag & FLAG_DATA_DESCRIPTOR) !== 0 &&
			entry.compressedSize === 0 &&
			entry.uncompressedSize === 0 &&
			entry.crc32 === 0
		) {
			fail(`wheel entry '${path}' has a data descriptor with unknown sizes`);
		}
		if (entry.uncompressedSize > limits.maxFileBytes) {
			fail(
				`wheel entry '${path}' declares ${entry.uncompressedSize} bytes, over the ${limits.maxFileBytes} byte limit (${PACKAGE_LIMIT_ENV.maxFileBytes})`,
			);
		}

		fileCount += 1;
		if (fileCount > limits.maxInstallFiles) {
			fail(`install exceeds ${limits.maxInstallFiles} files (${PACKAGE_LIMIT_ENV.maxInstallFiles})`);
		}
		totalBytes += entry.uncompressedSize;
		if (totalBytes > limits.maxInstallBytes) {
			fail(`install exceeds ${limits.maxInstallBytes} extracted bytes (${PACKAGE_LIMIT_ENV.maxInstallBytes})`);
		}

		// Every ancestor of a file is a directory — a file at one of those paths is
		// a collision.
		const segments = path.split("/");
		for (let i = 1; i < segments.length; i++) dirPaths.add(segments.slice(0, i).join("/"));

		files.push({ entry, path, mode: normalisedMode(entry), size: entry.uncompressedSize });
	}

	for (const file of files) {
		if (dirPaths.has(file.path)) fail(`wheel contains a directory and a file at '${file.path}'`);
	}

	return { files, totalBytes: totalBytes - consumedBytes };
}

/** Local-header sizes, resolved through the ZIP64 extra field when escaped. */
function localSizes(local: yauzl.LocalFileHeader): { compressed: number; uncompressed: number } {
	let uncompressed = local.uncompressedSize;
	let compressed = local.compressedSize;
	if (uncompressed !== 0xffffffff && compressed !== 0xffffffff) return { compressed, uncompressed };
	for (const field of yauzl.parseExtraFields(Buffer.from(local.extraField))) {
		if (field.id !== 0x0001) continue;
		let offset = 0;
		if (uncompressed === 0xffffffff && field.data.length >= offset + 8) {
			uncompressed = Number(field.data.readBigUInt64LE(offset));
			offset += 8;
		}
		if (compressed === 0xffffffff && field.data.length >= offset + 8) {
			compressed = Number(field.data.readBigUInt64LE(offset));
		}
		break;
	}
	return { compressed, uncompressed };
}

/** Requires the local file header to agree with the central directory. */
async function assertHeadersAgree(zip: yauzl.ZipFile, entry: yauzl.Entry, path: string): Promise<void> {
	const local = await zip.readLocalFileHeaderPromise(entry);
	if (local.compressionMethod !== entry.compressionMethod) {
		fail(`wheel entry '${path}' disagrees with its local header on compression method`);
	}
	if (!Buffer.from(local.fileName).equals(Buffer.from(entry.fileNameRaw))) {
		fail(`wheel entry '${path}' disagrees with its local header on file name`);
	}
	// A streamed entry (bit 3) zeroes sizes and CRC locally; the central
	// directory stays authoritative and inflate still enforces both.
	if ((entry.generalPurposeBitFlag & FLAG_DATA_DESCRIPTOR) !== 0) return;
	if (local.crc32 !== entry.crc32) fail(`wheel entry '${path}' disagrees with its local header on CRC-32`);
	const sizes = localSizes(local);
	if (sizes.compressed !== entry.compressedSize || sizes.uncompressed !== entry.uncompressedSize) {
		fail(`wheel entry '${path}' disagrees with its local header on size`);
	}
}

/** Inflates one entry, bounded by both zlib's `maxOutputLength` and a counter. */
async function inflateEntry(zip: yauzl.ZipFile, item: ValidatedEntry): Promise<Uint8Array> {
	const { entry, path, size } = item;
	// Raw mode: the inflate stream, and its bound, are ours rather than yauzl's.
	const source: Readable = await zip.openReadStreamPromise(entry, { decodeFileData: false });
	const chunks: Buffer[] = [];
	let received = 0;

	const collect = async (stream: AsyncIterable<Buffer>): Promise<void> => {
		for await (const chunk of stream) {
			received += chunk.length;
			if (received > size) fail(`wheel entry '${path}' is larger than its declared size of ${size} bytes`);
			chunks.push(chunk);
		}
	};

	try {
		if (entry.compressionMethod === METHOD_STORED) {
			await pipeline(source, collect);
		} else {
			// maxOutputLength must be positive; the counter enforces the exact size.
			const inflate = zlib.createInflateRaw({ maxOutputLength: Math.max(size, 1) });
			await pipeline(source, inflate, collect);
		}
	} catch (err) {
		source.destroy();
		if (err instanceof WheelError) throw err;
		// Not matched on a zlib error code: every stream failure is one error here.
		throw new WheelError(`${CORRUPT}: entry '${path}' could not be decompressed`);
	}

	if (received !== size) {
		fail(`wheel entry '${path}' produced ${received} bytes but declares ${size}`);
	}
	const content = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, received);
	if (zlib.crc32(content) !== entry.crc32) {
		fail(`${CORRUPT}: entry '${path}' failed its CRC-32 check`);
	}
	return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
}

/**
 * Locates the single `*.dist-info` directory and validates WHEEL + RECORD.
 *
 * The two entries it has to inflate are returned in `preRead`, keyed by path,
 * so the main loop links them from this pass instead of inflating them twice.
 */
async function readMetadata(
	zip: yauzl.ZipFile,
	files: readonly ValidatedEntry[],
): Promise<{ distInfoDir: string; record: Map<string, Uint8Array>; preRead: Map<string, Uint8Array> }> {
	const distInfoDirs = new Set<string>();
	for (const file of files) {
		const first = file.path.split("/")[0]!;
		if (first.endsWith(".dist-info")) distInfoDirs.add(first);
	}
	if (distInfoDirs.size === 0) fail("wheel has no .dist-info directory");
	if (distInfoDirs.size > 1) fail("wheel has more than one .dist-info directory");
	const distInfoDir = [...distInfoDirs][0]!;

	const wheelEntry = files.find((f) => f.path === `${distInfoDir}/WHEEL`);
	if (wheelEntry === undefined) fail(`wheel has no ${distInfoDir}/WHEEL`);
	const preRead = new Map<string, Uint8Array>();
	const wheelBytes = await inflateEntry(zip, wheelEntry);
	preRead.set(wheelEntry.path, wheelBytes);
	const wheelText = Buffer.from(wheelBytes).toString("utf8");
	const headers = new Map<string, string>();
	for (const line of wheelText.split("\n")) {
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
	}
	const wheelVersion = headers.get("wheel-version") ?? "";
	if (!/^1\.\d+$/.test(wheelVersion)) {
		fail(`unsupported Wheel-Version '${wheelVersion}' (only 1.x is supported)`);
	}
	if ((headers.get("root-is-purelib") ?? "").toLowerCase() !== "true") {
		fail("only pure-Python wheels are supported (Root-Is-Purelib must be true)");
	}

	const recordPath = `${distInfoDir}/RECORD`;
	const recordEntry = files.find((f) => f.path === recordPath);
	if (recordEntry === undefined) fail(`wheel has no ${recordPath}`);
	const recordBytes = await inflateEntry(zip, recordEntry);
	preRead.set(recordEntry.path, recordBytes);
	const recordText = Buffer.from(recordBytes).toString("utf8");
	const record = new Map<string, Uint8Array>();
	for (const line of recordText.split("\n")) {
		const parsed = parseRecordLine(line);
		if (parsed === null) continue;
		const hash = decodeRecordHash(parsed.hash);
		if (hash !== null) record.set(parsed.path, hash);
	}
	for (const file of files) {
		if (file.path === recordPath) continue;
		if (!record.has(file.path)) fail(`wheel entry '${file.path}' is missing a sha256 entry in RECORD`);
	}
	return { distInfoDir, record, preRead };
}

/**
 * Yields verified files in bounded batches. Memory held: the caller's wheel
 * buffer plus exactly one batch — the array is handed to the consumer and
 * replaced before the next entry is inflated; nothing accumulates across
 * batches.
 */
export async function* readWheel(
	wheel: Uint8Array,
	options: WheelReadOptions = {},
): AsyncGenerator<readonly WheelFile[], WheelInfo, undefined> {
	const limits = options.limits ?? packageLimits();
	const maxBatchBytes = options.maxBatchBytes ?? DEFAULT_BATCH_BYTES;
	const maxBatchEntries = options.maxBatchEntries ?? DEFAULT_BATCH_ENTRIES;

	if (wheel.byteLength > limits.maxWheelBytes) {
		fail(
			`wheel is ${wheel.byteLength} bytes, over the ${limits.maxWheelBytes} byte limit (${PACKAGE_LIMIT_ENV.maxWheelBytes})`,
		);
	}

	let zip: yauzl.ZipFile;
	try {
		zip = await yauzl.fromBufferPromise(Buffer.from(wheel.buffer, wheel.byteOffset, wheel.byteLength), {
			lazyEntries: true,
			decodeStrings: true,
			// Reject backslashes rather than silently rewriting them to "/".
			strictFileNames: true,
			validateEntrySizes: true,
			autoClose: false,
		});
	} catch (err) {
		throw new WheelError(`${CORRUPT}: ${briefly(err)}`);
	}

	try {
		// yauzl rejects some shapes itself (bad names, strong encryption,
		// stored-size mismatch, truncation); the catch below remaps those.
		const entries: readonly yauzl.Entry[] = await readCentralDirectory(zip);

		const { files, totalBytes } = validateEntries(
			entries,
			limits,
			options.consumedFiles ?? 0,
			options.consumedBytes ?? 0,
		);
		const { distInfoDir, record, preRead } = await readMetadata(zip, files);

		let batch: WheelFile[] = [];
		let batchBytes = 0;
		for (const file of files) {
			await assertHeadersAgree(zip, file.entry, file.path);
			// WHEEL and RECORD were inflated (and CRC-checked) by `readMetadata`.
			const content = preRead.get(file.path) ?? (await inflateEntry(zip, file));
			const sha256 = new Uint8Array(createHash("sha256").update(content).digest());
			const expected = record.get(file.path);
			if (expected !== undefined && Buffer.compare(sha256, expected) !== 0) {
				fail(`wheel entry '${file.path}' does not match its RECORD sha256`);
			}
			batch.push({ path: file.path, sha256, mode: file.mode, size: file.size, content });
			batchBytes += content.byteLength;
			if (batchBytes >= maxBatchBytes || batch.length >= maxBatchEntries) {
				yield batch;
				batch = [];
				batchBytes = 0;
			}
		}
		if (batch.length > 0) yield batch;

		return { distInfoDir, fileCount: files.length, totalBytes };
	} catch (err) {
		if (err instanceof WheelError) throw err;
		throw new WheelError(`${CORRUPT}: ${briefly(err)}`);
	} finally {
		zip.close();
	}
}
