/**
 * Shared ingest manifest builder used by both the HTTP `/ingest-files` route
 * and the MCP `fs_ingest` tool. It collapses two ingest modes into a single
 * `BulkIngestFile[]` ready for `fs.bulkIngest`:
 *
 *   - `files`: { relPath: base64 }   — inline bytes
 *   - `paths`: { relPath: hostPath } — server reads the host filesystem
 *
 * Trust model for `paths`: the API process reads whatever the OS allows
 * the calling host to read. This is fine for the colocated agent ↔ server
 * topology MCP is designed for, but it MUST NOT be exposed on a multi-tenant
 * network surface without an additional access boundary. The HTTP route
 * deliberately does not forward `paths` for that reason; only MCP does.
 *
 * The builder returns an array of error messages instead of a single string
 * so each surface can shape its own response (HTTP `details: string[]`,
 * MCP `error: string`).
 */

import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { BulkIngestFile } from "../sql-fs/types.js";
import { isValidBase64, isValidBasePath, isValidHostPath, isValidRelativePath } from "./ingest-validation.js";
import { positiveIntEnv } from "./lib/env.js";

// Audit H11 (#5, #6, #10, #43): bound ingest manifests so a single call cannot
// exhaust memory or host file descriptors.
/** Max total entries (files + paths) in one ingest manifest. */
const MAX_INGEST_FILES = Number(process.env.MAX_INGEST_FILES ?? "10000");
/** Max total decoded/read bytes across one ingest manifest. */
const MAX_INGEST_BYTES = Number(process.env.MAX_INGEST_BYTES ?? `${512 * 1024 * 1024}`);
/** Max concurrent host-file reads for `paths` mode (FD / memory bound). Steps the
 * read loop, so it must be a positive integer (0/NaN would hang or no-op). */
const MAX_INGEST_PATHS_CONCURRENCY = positiveIntEnv(process.env.MAX_INGEST_PATHS_CONCURRENCY, 16);

export interface BuildIngestPayloadArgs {
	readonly basePath: string;
	readonly files?: Record<string, string>;
	readonly paths?: Record<string, string>;
	/**
	 * When true, an empty payload (no `files` and no `paths`) returns
	 * `{ ok: true, bulkFiles: [] }` instead of an error. The HTTP route uses
	 * this to preserve the historical contract where an empty `files` map
	 * succeeds with `fileCount: 0`; MCP rejects empty payloads to prevent
	 * silent no-op tool calls.
	 */
	readonly allowEmpty?: boolean;
}

export type BuildIngestPayloadResult =
	| { readonly ok: true; readonly bulkFiles: BulkIngestFile[] }
	| { readonly ok: false; readonly errors: string[] };

export interface PreparedIngestPayload {
	readonly bulkFiles: BulkIngestFile[];
	readonly contentBytes: number;
	materialize(signal?: AbortSignal): Promise<BuildIngestPayloadResult>;
}

export type PrepareIngestPayloadResult =
	| { readonly ok: true; readonly payload: PreparedIngestPayload }
	| { readonly ok: false; readonly errors: string[] };

type IngestSource =
	| { readonly path: string; readonly size: number; readonly base64: string }
	| { readonly path: string; readonly size: number; readonly hostPath: string; readonly relativePath: string };

async function readHostFile(
	source: Extract<IngestSource, { hostPath: string }>,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	signal?.throwIfAborted();
	const handle = await open(source.hostPath, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size !== source.size) throw new Error("Host file changed before ingest");
		const bytes = Buffer.allocUnsafeSlow(source.size);
		let offset = 0;
		while (offset < bytes.length) {
			signal?.throwIfAborted();
			const result = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
			if (result.bytesRead === 0) throw new Error("Host file changed during ingest");
			offset += result.bytesRead;
		}
		signal?.throwIfAborted();
		const extra = await handle.read(Buffer.allocUnsafeSlow(1), 0, 1, offset);
		const after = await handle.stat();
		if (extra.bytesRead !== 0 || !after.isFile() || after.size !== source.size) {
			throw new Error("Host file changed during ingest");
		}
		return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	} finally {
		await handle.close();
	}
}

export async function prepareBulkIngestPayload(args: BuildIngestPayloadArgs): Promise<PrepareIngestPayloadResult> {
	const { basePath } = args;

	if (!isValidBasePath(basePath)) {
		return { ok: false, errors: ["basePath must be a safe absolute path"] };
	}

	const filesEntries = Object.entries(args.files ?? {});
	const pathsEntries = Object.entries(args.paths ?? {});

	if (filesEntries.length === 0 && pathsEntries.length === 0) {
		if (args.allowEmpty)
			return {
				ok: true,
				payload: { bulkFiles: [], contentBytes: 0, materialize: async () => ({ ok: true, bulkFiles: [] }) },
			};
		return { ok: false, errors: ["at least one of `files` or `paths` must be non-empty"] };
	}

	if (filesEntries.length + pathsEntries.length > MAX_INGEST_FILES) {
		return {
			ok: false,
			errors: [`too many entries: ${filesEntries.length + pathsEntries.length} (max ${MAX_INGEST_FILES})`],
		};
	}

	// Validate everything before doing any I/O so the caller sees one
	// consolidated error rather than a mid-batch failure.
	const invalidRel: string[] = [];
	const invalidBase64: string[] = [];
	const invalidHost: string[] = [];
	const duplicateKeys: string[] = [];

	const fileKeys = new Set<string>();
	for (const [rel, b64] of filesEntries) {
		if (!isValidRelativePath(rel)) {
			invalidRel.push(rel);
			continue;
		}
		if (!isValidBase64(b64)) {
			invalidBase64.push(rel);
			continue;
		}
		fileKeys.add(rel);
	}
	for (const [rel, hostPath] of pathsEntries) {
		if (!isValidRelativePath(rel)) {
			invalidRel.push(rel);
			continue;
		}
		if (!isValidHostPath(hostPath)) {
			invalidHost.push(rel);
			continue;
		}
		if (fileKeys.has(rel)) duplicateKeys.push(rel);
	}

	const errors = formatValidationErrors({ invalidRel, invalidBase64, invalidHost, duplicateKeys });
	if (errors.length > 0) return { ok: false, errors };

	const sources: IngestSource[] = [];
	let totalBytes = 0;
	for (const [rel, b64] of filesEntries) {
		const size = (b64.length / 4) * 3 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
		totalBytes += size;
		if (totalBytes > MAX_INGEST_BYTES)
			return { ok: false, errors: [`ingest exceeds byte limit (${MAX_INGEST_BYTES})`] };
		sources.push({ path: `${basePath}/${rel}`, size, base64: b64 });
	}

	const unreadable: string[] = [];
	for (let i = 0; i < pathsEntries.length; i += MAX_INGEST_PATHS_CONCURRENCY) {
		const batch = pathsEntries.slice(i, i + MAX_INGEST_PATHS_CONCURRENCY);
		const results = await Promise.allSettled(
			batch.map(async ([rel, hostPath]) => {
				const info = await stat(hostPath);
				if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0)
					throw new Error("Host ingest requires a regular file");
				return { path: `${basePath}/${rel}`, size: info.size, hostPath, relativePath: rel };
			}),
		);
		for (let j = 0; j < results.length; j++) {
			const result = results[j];
			if (result?.status === "fulfilled") {
				totalBytes += result.value.size;
				if (totalBytes > MAX_INGEST_BYTES)
					return { ok: false, errors: [`ingest exceeds byte limit (${MAX_INGEST_BYTES})`] };
				sources.push(result.value);
			} else {
				const entry = batch[j];
				if (entry) unreadable.push(entry[0]);
			}
		}
	}
	if (unreadable.length > 0) return { ok: false, errors: [`unreadable host paths: ${unreadable.join(", ")}`] };

	return {
		ok: true,
		payload: {
			bulkFiles: sources.map(({ path }) => ({ path, content: new Uint8Array(0), mode: 0o644 })),
			contentBytes: totalBytes,
			async materialize(signal) {
				const bulkFiles: BulkIngestFile[] = [];
				const unreadable: string[] = [];
				for (let i = 0; i < sources.length; i += MAX_INGEST_PATHS_CONCURRENCY) {
					signal?.throwIfAborted();
					const batch = sources.slice(i, i + MAX_INGEST_PATHS_CONCURRENCY);
					const results = await Promise.allSettled(
						batch.map(async (source) => ({
							path: source.path,
							content:
								"base64" in source
									? new Uint8Array(Buffer.from(source.base64, "base64"))
									: await readHostFile(source, signal),
							mode: 0o644,
						})),
					);
					signal?.throwIfAborted();
					for (let j = 0; j < results.length; j++) {
						const result = results[j];
						if (result?.status === "fulfilled") bulkFiles.push(result.value);
						else {
							const source = batch[j];
							if (source && "relativePath" in source) unreadable.push(source.relativePath);
							else if (result?.status === "rejected") throw result.reason;
						}
					}
				}
				return unreadable.length > 0
					? { ok: false, errors: [`unreadable host paths: ${unreadable.join(", ")}`] }
					: { ok: true, bulkFiles };
			},
		},
	};
}

export async function buildBulkIngestPayload(args: BuildIngestPayloadArgs): Promise<BuildIngestPayloadResult> {
	const prepared = await prepareBulkIngestPayload(args);
	return prepared.ok ? prepared.payload.materialize() : prepared;
}

interface ValidationBuckets {
	readonly invalidRel: string[];
	readonly invalidBase64: string[];
	readonly invalidHost: string[];
	readonly duplicateKeys: string[];
}

function formatValidationErrors(b: ValidationBuckets): string[] {
	const out: string[] = [];
	if (b.invalidRel.length > 0) out.push(`invalid paths: ${b.invalidRel.join(", ")}`);
	if (b.invalidBase64.length > 0) out.push(`invalid base64: ${b.invalidBase64.join(", ")}`);
	if (b.invalidHost.length > 0) out.push(`invalid host paths: ${b.invalidHost.join(", ")}`);
	if (b.duplicateKeys.length > 0) out.push(`duplicate keys in files and paths: ${b.duplicateKeys.join(", ")}`);
	return out;
}
