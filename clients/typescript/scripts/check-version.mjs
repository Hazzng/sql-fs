import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const versionSource = await readFile(new URL("../src/version.ts", import.meta.url), "utf8");
const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");

const sourceVersion = versionSource.match(/export const version = "([^"]+)"/)?.[1];
const changelogVersion = changelog.match(/^## \[([^\]]+)\]/m)?.[1];
const versions = {
	"package.json": packageJson.version,
	"src/version.ts": sourceVersion,
	"CHANGELOG.md": changelogVersion,
};

if (!sourceVersion || !changelogVersion || new Set(Object.values(versions)).size !== 1) {
	console.error("TypeScript SDK version mismatch:", versions);
	process.exit(1);
}

console.log(`TypeScript SDK version ${packageJson.version} is consistent.`);
