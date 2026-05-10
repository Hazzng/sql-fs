#!/usr/bin/env node
// Keeps openapi-spec.ts and README.md version badge in sync with package.json after `pnpm changeset:version`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const specPath = join(root, "src", "api", "openapi-spec.ts");
writeFileSync(
	specPath,
	readFileSync(specPath, "utf8").replace(
		/version: "\d+\.\d+\.\d+"/,
		`version: "${pkg.version}"`,
	),
);
console.log(`openapi-spec.ts → ${pkg.version}`);

const readmePath = join(root, "README.md");
writeFileSync(
	readmePath,
	readFileSync(readmePath, "utf8").replace(
		/badge\/version-[\d.]+/,
		`badge/version-${pkg.version}`,
	),
);
console.log(`README.md badge → ${pkg.version}`);
