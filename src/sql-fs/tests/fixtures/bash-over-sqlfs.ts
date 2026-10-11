/**
 * Real just-bash over a real SqlFs on the probe dialect. The default tree has no
 * `/dev` and no `/tmp`, like a production sandbox: just-bash only seeds those on a
 * filesystem with sync methods, which SqlFs does not have.
 */

import { Bash, type BashOptions } from "just-bash";
import { SqlFs } from "../../sql-fs.js";
import { type DialectProbe, makeProbeDialect } from "./buffered-dialect.js";

export interface BashOverSqlFs {
	readonly bash: Bash;
	readonly fs: SqlFs;
	readonly probe: DialectProbe;
}

export async function bashOverSqlFs(bashOptions: Omit<BashOptions, "fs"> = {}): Promise<BashOverSqlFs> {
	const probe = makeProbeDialect();
	const fs = new SqlFs({ dialect: probe.dialect, sandboxId: "s-redirect" });
	await fs.ready();
	const bash = new Bash({ cwd: "/home/user", ...bashOptions, fs });
	probe.calls.length = 0;
	probe.windows.length = 0;
	return { bash, fs, probe };
}
