/**
 * Copy the Pyodide runner sources to dist/ as RAW .ts.
 *
 * Deno runs `dist/pyodide-runner/runner.ts` directly (it uses Deno globals and is
 * excluded from the tsc build). `runner.ts` imports `./protocol.ts`, so the raw
 * protocol source must sit beside it. tsc separately emits
 * `dist/pyodide-runner/protocol.js` for the Node side (src/api/pyodide/ipc.ts) —
 * both coexist; Deno resolves the explicit `.ts`, Node imports the `.js`.
 */
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src/pyodide-runner");
const dest = join(root, "dist/pyodide-runner");
mkdirSync(dest, { recursive: true });
for (const name of readdirSync(src)) {
	if (name.endsWith(".ts")) copyFileSync(join(src, name), join(dest, name));
}
