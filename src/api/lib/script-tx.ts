import { runInScriptScope, type ScriptScope } from "../../sql-fs/script-scope.js";
import { assertScriptLeaseHeld } from "./script-lease.js";

export async function runInScriptTx<T>(
	session: { readonly scriptTx: ScriptScope | undefined },
	fn: () => Promise<T>,
): Promise<T> {
	const scriptTx = session.scriptTx;
	if (scriptTx === undefined) return fn();
	return runInScriptScope(scriptTx, async () => {
		const result = await fn();
		assertScriptLeaseHeld("write aborted: distributed exec lock lost mid-request");
		return result;
	});
}
