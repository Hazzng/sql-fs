/** Shared wheel / PyPI fixtures for the experimental pip command tests. */
import { createHash } from "node:crypto";
import { Bash, InMemoryFs } from "just-bash";
import type { Command, SecureFetch } from "just-bash";
import { pythonPackageCommands } from "../../commands/pip-command.js";

const encoder = new TextEncoder();

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/** Small stored ZIP writer so the tests do not depend on a host archive tool. */
export function storedZip(entries: Record<string, string>): Uint8Array {
	const local: number[] = [];
	const central: number[] = [];
	let offset = 0;
	for (const [name, value] of Object.entries(entries)) {
		const nameBytes = encoder.encode(name);
		const content = encoder.encode(value);
		const crc = crc32(content);
		local.push(
			0x50,
			0x4b,
			0x03,
			0x04,
			...u16(20),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(crc),
			...u32(content.length),
			...u32(content.length),
			...u16(nameBytes.length),
			...u16(0),
			...nameBytes,
			...content,
		);
		central.push(
			0x50,
			0x4b,
			0x01,
			0x02,
			...u16(20),
			...u16(20),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(crc),
			...u32(content.length),
			...u32(content.length),
			...u16(nameBytes.length),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(offset),
			...nameBytes,
		);
		offset = local.length;
	}
	const end = [
		0x50,
		0x4b,
		0x05,
		0x06,
		...u16(0),
		...u16(0),
		...u16(Object.keys(entries).length),
		...u16(Object.keys(entries).length),
		...u32(central.length),
		...u32(local.length),
		...u16(0),
	];
	return Uint8Array.from([...local, ...central, ...end]);
}

export function wheel(
	packageName: string,
	version: string,
	files: Record<string, string>,
	requiresDist: string[] = [],
	entryPoint?: string,
): Uint8Array {
	const distribution = packageName.replace(/[-_.]+/g, "_");
	const metadata = [
		"Metadata-Version: 2.1",
		`Name: ${packageName}`,
		`Version: ${version}`,
		...requiresDist.map((item) => `Requires-Dist: ${item}`),
		"",
		"",
	].join("\n");
	const allFiles: Record<string, string> = {
		...files,
		[`${distribution}-${version}.dist-info/METADATA`]: metadata,
		[`${distribution}-${version}.dist-info/WHEEL`]: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
	};
	if (entryPoint)
		allFiles[`${distribution}-${version}.dist-info/entry_points.txt`] =
			`[console_scripts]\ndatabricks = ${entryPoint}\n`;
	return storedZip(allFiles);
}

export function sha256(body: Uint8Array): string {
	return createHash("sha256").update(body).digest("hex");
}

export type PackageFixture = {
	readonly version: string;
	readonly body: Uint8Array;
	readonly requiresDist?: string[];
	readonly entryPoint?: string;
	readonly filename?: string;
};

export type FetchResult = Awaited<ReturnType<SecureFetch>>;

export function fixtureFetch(packages: Record<string, PackageFixture>): SecureFetch {
	return async (url): Promise<FetchResult> => {
		const parsed = new URL(url);
		if (parsed.hostname === "pypi.org") {
			const match = parsed.pathname.match(/^\/pypi\/([^/]+)(?:\/([^/]+))?\/json$/);
			const packageName = match?.[1];
			const fixture = packageName ? packages[packageName] : undefined;
			if (!fixture) return { status: 404, statusText: "Not Found", headers: {}, body: encoder.encode("{}"), url };
			const filename = fixture.filename ?? `${packageName}-${fixture.version}-py3-none-any.whl`;
			const artifact = {
				filename,
				url: `https://files.pythonhosted.org/${filename}`,
				packagetype: "bdist_wheel",
				digests: { sha256: sha256(fixture.body) },
			};
			const response = {
				info: { version: fixture.version, requires_dist: fixture.requiresDist ?? [] },
				releases: { [fixture.version]: [artifact] },
				urls: [artifact],
			};
			return {
				status: 200,
				statusText: "OK",
				headers: { "content-type": "application/json" },
				body: encoder.encode(JSON.stringify(response)),
				url,
			};
		}
		if (parsed.hostname === "files.pythonhosted.org") {
			const filename = parsed.pathname.slice(1);
			const fixture = Object.entries(packages).find(
				([name, value]) => (value.filename ?? `${name}-${value.version}-py3-none-any.whl`) === filename,
			)?.[1];
			if (!fixture) return { status: 404, statusText: "Not Found", headers: {}, body: new Uint8Array(), url };
			return {
				status: 200,
				statusText: "OK",
				headers: { "content-type": "application/octet-stream" },
				body: fixture.body,
				url,
			};
		}
		if (parsed.hostname === "db.test") {
			return {
				status: 200,
				statusText: "OK",
				headers: { "content-type": "application/json" },
				body: encoder.encode(JSON.stringify({ ok: true })),
				url,
			};
		}
		return { status: 403, statusText: "Forbidden", headers: {}, body: new Uint8Array(), url };
	};
}

export function makeBash(packages: Record<string, PackageFixture>, commands: Command[] = pythonPackageCommands): Bash {
	return new Bash({
		fs: new InMemoryFs(),
		python: true,
		fetch: fixtureFetch(packages),
		customCommands: commands,
	});
}
