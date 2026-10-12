import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const [publishedPackage, rebuiltPackage, destination] = process.argv.slice(2).map((path) => resolve(path));
if (!publishedPackage || !rebuiltPackage || !destination) {
	throw new Error("Usage: node scripts/build-just-bash-patch.mjs published-package rebuilt-package destination.patch");
}

const replacements = new Map([
	["chunk-7JDTFUAS.js", "chunk-EJFBIRMD.js"],
	["chunk-HUBBEVGT.js", "chunk-GN6CQ3J4.js"],
	["chunk-YB332JPX.js", "chunk-7M672HB6.js"],
	["chunk-ZJ4CT5GK.js", "chunk-W5J5ADJF.js"],
	["flag-coverage-6H5UC6MZ.js", "flag-coverage-EDO3VM43.js"],
	["js-exec-P4V2KRFM.js", "js-exec-NDLXDUBN.js"],
	["sed-LNQ6NZ4Z.js", "sed-MBB5SXGD.js"],
	["tr-MVHS2JJ6.js", "tr-4NGL47UU.js"],
	["chunk-OJGN3WUD.js", "chunk-W5J5ADJF.js"],
	["chunk-WFTFZTBF.js", "chunk-W5J5ADJF.js"],
	["flag-coverage-Z55NAONZ.js", "flag-coverage-EDO3VM43.js"],
	["flag-coverage-LL5FWF66.js", "flag-coverage-EDO3VM43.js"],
	["sed-QHDI2JH7.js", "sed-MBB5SXGD.js"],
	["sed-K5WN2HUX.js", "sed-MBB5SXGD.js"],
	["worker.js", "worker.js"],
	["python3-ITKBIH4N.js", "python3-SDFCGIU4.js"],
	["python3-TEKPY5OZ.js", "python3-SDFCGIU4.js"],
	["python3-7ZQ66YFN.js", "python3-SDFCGIU4.js"],
	["python3-KUAM4I3Z.js", "python3-SDFCGIU4.js"],
	["python3-AWVLLUZK.js", "python3-SDFCGIU4.js"],
	["python3-YIUTGINW.js", "python3-SDFCGIU4.js"],
	["js-exec-5HKSCQVE.js", "js-exec-NDLXDUBN.js"],
	["chunk-DDGUZILH.js", "chunk-R6ZGLVXI.js"],
	["chunk-2EYHSTYR.js", "chunk-5UTZMNI5.js"],
	["chunk-JVG54D23.js", "chunk-YUFU7O6I.js"],
	["chunk-IO36IOHD.js", "chunk-5BMPT6SF.js"],
	["chunk-STGZJMNG.js", "chunk-VGCXKMXN.js"],
	["ls-7AAWXLVD.js", "ls-MQTYWW4T.js"],
	["flag-coverage-2R6SYFYB.js", "flag-coverage-EDO3VM43.js"],
]);

function normalizedHash(source) {
	return createHash("sha256").update(source.replace(/[A-Z0-9]{8}(?=\.js)/g, "HASH")).digest("hex");
}

async function chunks(packagePath) {
	const directory = join(packagePath, "dist/bundle/chunks");
	const entries = await readdir(directory);
	return Promise.all(
		entries.filter((name) => name.endsWith(".js")).map(async (name) => ({
			name,
			source: await readFile(join(directory, name), "utf8"),
		})),
	);
}

const [publishedChunks, rebuiltChunks] = await Promise.all([chunks(publishedPackage), chunks(rebuiltPackage)]);
const originals = new Map(publishedChunks.map(({ name, source }) => [normalizedHash(source), name]));
for (const { name, source } of rebuiltChunks) {
	const original = originals.get(normalizedHash(source));
	if (original) replacements.set(name, original);
	else if (!replacements.has(name) && name !== "chunk-CIY4XCGA.js") {
		throw new Error(`Unmapped rebuilt chunk ${name}`);
	}
}

const temporary = await mkdtemp(join(tmpdir(), "sql-fs-just-bash-patch-"));
try {
	await cp(join(publishedPackage, "dist/bundle"), join(temporary, "dist/bundle"), { recursive: true });
	await cp(join(publishedPackage, "dist/types.d.ts"), join(temporary, "dist/types.d.ts"));
	await cp(join(publishedPackage, "dist/limits.d.ts"), join(temporary, "dist/limits.d.ts"));
	await mkdir(join(temporary, "dist/fs"), { recursive: true });
	await cp(join(publishedPackage, "dist/fs/interface.d.ts"), join(temporary, "dist/fs/interface.d.ts"));
	execFileSync("git", ["init", "--quiet"], { cwd: temporary });
	execFileSync("git", ["add", "."], { cwd: temporary });
	await cp(join(rebuiltPackage, "dist/types.d.ts"), join(temporary, "dist/types.d.ts"));
	await cp(join(rebuiltPackage, "dist/limits.d.ts"), join(temporary, "dist/limits.d.ts"));
	await cp(join(rebuiltPackage, "dist/fs/interface.d.ts"), join(temporary, "dist/fs/interface.d.ts"));
	for (const { name, source } of [
		...rebuiltChunks,
		{ name: "../index.js", source: await readFile(join(rebuiltPackage, "dist/bundle/index.js"), "utf8") },
	]) {
		const rewritten = source.replace(/[A-Za-z0-9_-]+-[A-Z0-9]{8}\.js/g, (name) => replacements.get(name) ?? name);
		await writeFile(join(temporary, "dist/bundle/chunks", replacements.get(name) ?? name), rewritten);
	}
	execFileSync("git", ["add", "--intent-to-add", "."], { cwd: temporary });
	const patch = execFileSync("git", ["diff", "--no-ext-diff", "--no-color"], {
		cwd: temporary,
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
	});
	await writeFile(destination, patch);
	console.log(JSON.stringify({ patch: destination, bytes: Buffer.byteLength(patch), normalizedChunks: replacements.size }));
} finally {
	await rm(temporary, { recursive: true, force: true });
}
