import type { SessionManager } from "../session-manager.js";
import type { Session } from "../session-manager.js";

export interface BatchScriptEntry {
	readonly id: string;
	readonly script: string;
}

export interface BatchScriptResult {
	readonly id: string;
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly error?: string;
}

export async function executeBatch(
	sessionManager: SessionManager,
	session: Session,
	scripts: readonly BatchScriptEntry[],
	totalTimeoutMs: number,
	outerSignal?: AbortSignal,
): Promise<BatchScriptResult[]> {
	const results: BatchScriptResult[] = [];
	const batchStart = Date.now();

	for (const entry of scripts) {
		if (outerSignal?.aborted) break;

		const remaining = totalTimeoutMs - (Date.now() - batchStart);

		if (remaining <= 0) {
			results.push({ id: entry.id, stdout: "", stderr: "", exitCode: -1, error: "timeout" });
			continue;
		}

		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, remaining);

		const abortFromOuter = () => controller.abort();
		outerSignal?.addEventListener("abort", abortFromOuter, { once: true });

		try {
			const execResult = await sessionManager.execWithRuntimeThrottle(session, entry.script, {
				signal: controller.signal,
			});
			clearTimeout(timer);
			outerSignal?.removeEventListener("abort", abortFromOuter);

			if (timedOut) {
				results.push({ id: entry.id, stdout: "", stderr: "", exitCode: -1, error: "timeout" });
			} else {
				results.push({
					id: entry.id,
					stdout: execResult.stdout,
					stderr: execResult.stderr,
					exitCode: execResult.exitCode,
				});
			}
		} catch {
			clearTimeout(timer);
			outerSignal?.removeEventListener("abort", abortFromOuter);
			if (timedOut) {
				results.push({ id: entry.id, stdout: "", stderr: "", exitCode: -1, error: "timeout" });
			} else {
				results.push({ id: entry.id, stdout: "", stderr: "internal error", exitCode: -1 });
			}
		}
	}

	return results;
}
