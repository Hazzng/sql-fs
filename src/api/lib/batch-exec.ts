import { readOnlyContext } from "../read-only-context.js";
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

const MAX_BATCH_PARALLELISM = 16;

async function runSequential(
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
			} else if (outerSignal?.aborted) {
				break;
			} else {
				results.push({ id: entry.id, stdout: "", stderr: "internal error", exitCode: -1 });
			}
		}
	}

	return results;
}

async function runParallel(
	sessionManager: SessionManager,
	session: Session,
	scripts: readonly BatchScriptEntry[],
	totalTimeoutMs: number,
	outerSignal?: AbortSignal,
): Promise<BatchScriptResult[]> {
	const results = new Array<BatchScriptResult>(scripts.length) as BatchScriptResult[];

	const sharedController = new AbortController();
	let timedOut = false;

	const deadlineTimer = setTimeout(() => {
		timedOut = true;
		sharedController.abort();
	}, totalTimeoutMs);

	const onOuterAbort = () => sharedController.abort();
	outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

	try {
		const cap = Math.min(scripts.length, MAX_BATCH_PARALLELISM);
		let cursor = 0;

		const runWorker = async (): Promise<void> => {
			while (true) {
				const idx = cursor++;
				if (idx >= scripts.length) break;

				const entry = scripts[idx]!;

				if (sharedController.signal.aborted) {
					results[idx] = {
						id: entry.id,
						stdout: "",
						stderr: "",
						exitCode: -1,
						error: timedOut ? "timeout" : "aborted",
					};
					continue;
				}

				try {
					const execResult = await sessionManager.execWithRuntimeThrottle(session, entry.script, {
						signal: sharedController.signal,
					});
					results[idx] = {
						id: entry.id,
						stdout: execResult.stdout,
						stderr: execResult.stderr,
						exitCode: execResult.exitCode,
					};
				} catch {
					results[idx] = {
						id: entry.id,
						stdout: "",
						stderr: "",
						exitCode: -1,
						error: timedOut ? "timeout" : "aborted",
					};
				}
			}
		};

		const workers: Promise<void>[] = [];
		for (let i = 0; i < cap; i++) {
			workers.push(runWorker());
		}
		await Promise.all(workers);
	} finally {
		clearTimeout(deadlineTimer);
		outerSignal?.removeEventListener("abort", onOuterAbort);
	}

	return results;
}

export async function executeBatch(
	sessionManager: SessionManager,
	session: Session,
	scripts: readonly BatchScriptEntry[],
	totalTimeoutMs: number,
	outerSignal?: AbortSignal,
): Promise<BatchScriptResult[]> {
	const inReadOnlyScope = readOnlyContext.getStore() !== undefined;
	if (inReadOnlyScope) {
		return runParallel(sessionManager, session, scripts, totalTimeoutMs, outerSignal);
	}
	return runSequential(sessionManager, session, scripts, totalTimeoutMs, outerSignal);
}
