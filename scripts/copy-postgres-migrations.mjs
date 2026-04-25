import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src/fs/sql-fs/migrations/postgres");
const dest = join(root, "dist/fs/sql-fs/migrations/postgres");
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
