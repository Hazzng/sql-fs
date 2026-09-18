/**
 * Hand-assembled ZIP/wheel fixtures for the wheel-reader tests. Every field the
 * reader inspects (flags, methods, sizes, CRC, external attributes, ZIP64 extra
 * fields, local-vs-central disagreement) can be set independently, including to
 * values a well-formed archive would never contain.
 */

import { createHash } from "node:crypto";
import zlib from "node:zlib";

const encoder = new TextEncoder();

export interface EntrySpec {
	readonly name: string;
	readonly content?: string | Uint8Array;
	/** 0 = stored, 8 = deflate. Defaults to 0. */
	readonly method?: number;
	/** General purpose bit flag. */
	readonly flags?: number;
	/** Full 32-bit external attributes; the high 16 bits are the unix mode. */
	readonly externalAttrs?: number;
	/** Write sizes as 0xffffffff plus a ZIP64 extra field. */
	readonly zip64?: boolean;
	/** Overrides written into both headers' CRC field. */
	readonly crc?: number;
	/** Overrides the declared uncompressed size in both headers. */
	readonly declaredSize?: number;
	/** Overrides written into the local header only. */
	readonly local?: {
		readonly name?: string;
		readonly method?: number;
		readonly crc?: number;
		readonly compressedSize?: number;
		readonly uncompressedSize?: number;
	};
}

export function unixMode(mode: number): number {
	return (mode << 16) >>> 0;
}

/** External attributes marking an entry as a symlink (0o120777). */
export const SYMLINK_ATTRS = unixMode(0o120777);

function toBytes(content: string | Uint8Array | undefined): Uint8Array {
	if (content === undefined) return new Uint8Array(0);
	return typeof content === "string" ? encoder.encode(content) : content;
}

function u16(value: number): Buffer {
	const b = Buffer.alloc(2);
	b.writeUInt16LE(value & 0xffff, 0);
	return b;
}

function u32(value: number): Buffer {
	const b = Buffer.alloc(4);
	b.writeUInt32LE(value >>> 0, 0);
	return b;
}

function u64(value: number): Buffer {
	const b = Buffer.alloc(8);
	b.writeBigUInt64LE(BigInt(value), 0);
	return b;
}

function zip64Extra(uncompressed: number, compressed: number): Buffer {
	return Buffer.concat([u16(0x0001), u16(16), u64(uncompressed), u64(compressed)]);
}

/** Builds a ZIP archive from raw entry specs. */
export function buildZip(entries: readonly EntrySpec[]): Uint8Array {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const spec of entries) {
		const raw = toBytes(spec.content);
		const method = spec.method ?? 0;
		const data = method === 8 ? zlib.deflateRawSync(Buffer.from(raw)) : Buffer.from(raw);
		const crc = spec.crc ?? zlib.crc32(Buffer.from(raw));
		const uncompressed = spec.declaredSize ?? raw.length;
		const compressed = data.length;
		const nameBytes = Buffer.from(encoder.encode(spec.name));
		const localNameBytes = spec.local?.name === undefined ? nameBytes : Buffer.from(encoder.encode(spec.local.name));
		const flags = spec.flags ?? 0;
		const extra = spec.zip64 ? zip64Extra(uncompressed, compressed) : Buffer.alloc(0);
		const sizeField = spec.zip64 ? 0xffffffff : uncompressed;
		const compField = spec.zip64 ? 0xffffffff : compressed;

		locals.push(
			Buffer.concat([
				u32(0x04034b50),
				u16(20),
				u16(flags),
				u16(spec.local?.method ?? method),
				u16(0),
				u16(0),
				u32(spec.local?.crc ?? crc),
				u32(spec.local?.compressedSize ?? compField),
				u32(spec.local?.uncompressedSize ?? sizeField),
				u16(localNameBytes.length),
				u16(extra.length),
				localNameBytes,
				extra,
				data,
			]),
		);
		centrals.push(
			Buffer.concat([
				u32(0x02014b50),
				u16(20),
				u16(20),
				u16(flags),
				u16(method),
				u16(0),
				u16(0),
				u32(crc),
				u32(compField),
				u32(sizeField),
				u16(nameBytes.length),
				u16(extra.length),
				u16(0),
				u16(0),
				u16(0),
				u32(spec.externalAttrs ?? unixMode(0o644)),
				u32(offset),
				nameBytes,
				extra,
			]),
		);
		offset += locals[locals.length - 1]!.length;
	}

	const localBlock = Buffer.concat(locals);
	const centralBlock = Buffer.concat(centrals);
	const eocd = Buffer.concat([
		u32(0x06054b50),
		u16(0),
		u16(0),
		u16(entries.length),
		u16(entries.length),
		u32(centralBlock.length),
		u32(localBlock.length),
		u16(0),
	]);
	return new Uint8Array(Buffer.concat([localBlock, centralBlock, eocd]));
}

function recordHash(content: string | Uint8Array): string {
	const digest = createHash("sha256")
		.update(Buffer.from(toBytes(content)))
		.digest();
	return `sha256=${digest.toString("base64url").replace(/=+$/, "")}`;
}

export interface WheelSpec {
	readonly name?: string;
	readonly version?: string;
	/** Payload files, archive-relative. */
	readonly files?: Readonly<Record<string, string>>;
	/** Extra raw entries appended verbatim (hostile cases). */
	readonly extraEntries?: readonly EntrySpec[];
	/** Overrides for the generated payload entries. */
	readonly entryOverrides?: Readonly<Record<string, Omit<EntrySpec, "name">>>;
	readonly wheelMetadata?: string;
	/** Extra `Key: value` lines appended to METADATA (e.g. `Requires-Dist:`). */
	readonly metadataExtra?: readonly string[];
	/** Extra files inside the `.dist-info` directory, keyed by base name. */
	readonly distInfoFiles?: Readonly<Record<string, string>>;
	/** Skip the generated `<name>/__init__.py` payload module. */
	readonly omitDefaultModule?: boolean;
	/** Replaces the generated RECORD body. */
	readonly record?: string;
	/** Paths omitted from the generated RECORD. */
	readonly omitFromRecord?: readonly string[];
	/** Paths whose RECORD hash is replaced with a wrong one. */
	readonly corruptRecordFor?: readonly string[];
	readonly method?: number;
}

const WRONG_HASH = `sha256=${Buffer.alloc(32, 0x5a).toString("base64url")}`;

/** Builds a syntactically valid wheel with a generated WHEEL and RECORD. */
export function buildWheel(spec: WheelSpec = {}): Uint8Array {
	const name = spec.name ?? "demo";
	const version = spec.version ?? "1.0";
	const distInfo = `${name}-${version}.dist-info`;
	const files: Record<string, string> = spec.omitDefaultModule
		? { ...spec.files }
		: { [`${name}/__init__.py`]: "x = 1\n", ...spec.files };
	const wheelMeta =
		spec.wheelMetadata ?? "Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: py3-none-any\n";
	const metadata = [
		"Metadata-Version: 2.1",
		`Name: ${name}`,
		`Version: ${version}`,
		...(spec.metadataExtra ?? []),
		"",
		"",
	].join("\n");

	const contents: Record<string, string> = {
		...files,
		[`${distInfo}/METADATA`]: metadata,
		[`${distInfo}/WHEEL`]: wheelMeta,
	};
	for (const [base, body] of Object.entries(spec.distInfoFiles ?? {})) contents[`${distInfo}/${base}`] = body;

	const omit = new Set(spec.omitFromRecord ?? []);
	const corrupt = new Set(spec.corruptRecordFor ?? []);
	const recordLines: string[] = [];
	for (const [path, body] of Object.entries(contents)) {
		if (omit.has(path)) continue;
		const hash = corrupt.has(path) ? WRONG_HASH : recordHash(body);
		recordLines.push(`${path},${hash},${toBytes(body).length}`);
	}
	recordLines.push(`${distInfo}/RECORD,,`);
	const record = spec.record ?? `${recordLines.join("\n")}\n`;

	const entries: EntrySpec[] = Object.entries({ ...contents, [`${distInfo}/RECORD`]: record }).map(([path, body]) => ({
		name: path,
		content: body,
		method: spec.method ?? 0,
		...spec.entryOverrides?.[path],
	}));
	return buildZip([...entries, ...(spec.extraEntries ?? [])]);
}
