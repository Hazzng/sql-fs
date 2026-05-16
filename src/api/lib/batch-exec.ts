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

export interface ExecuteBatchOptions {
	/**
	 * Optional per-script timeout (ms). When set, each script gets its own
	 * independent budget instead of sharing `totalTimeoutMs` across the batch.
	 * `totalTimeoutMs` still acts as an outer ceiling.
	 *
	 * This is the recommended mode for capability probes (e.g. `python3 -c 'import foo'`
	 * × N) where a slow first script would otherwise silently exhaust the shared
	 * budget and turn later scripts into false negatives (issue #77).
	 */
	readonly perScriptTimeoutMs?: number;
}

const MAX_BATCH_PARALLELISM = 16;

async function runSequential(
	sessionManager: SessionManager,
	session: Session,
	scripts: readonly BatchScriptEntry[],
	totalTimeoutMs: number,
	outerSignal?: AbortSignal,
	options?: ExecuteBatchOptions,
): Promise<BatchScriptResult[]> {
	const results: BatchScriptResult[] = [];
	const batchStart = Date.now();
	const perScript = options?.perScriptTimeoutMs;

	for (const entry of scripts) {
		if (outerSignal?.aborted) break;

		const totalRemaining = totalTimeoutMs - (Date.now() - batchStart);

		if (totalRemaining <= 0) {
			results.push({ id: entry.id, stdout: "", stderr: "", exitCode: -1, error: "timeout" });
			continue;
		}

		// Per-script budget: each script gets its own timeout, capped by the
		// outer total budget so callers can't escape the total ceiling.
		const effectiveTimeout = perScript !== undefined ? Math.min(perScript, totalRemaining) : totalRemaining;

		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, effectiveTimeout);

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
	options?: ExecuteBatchOptions,
): Promise<BatchScriptResult[]> {
	const results = new Array<BatchScriptResult>(scripts.length) as BatchScriptResult[];
	const perScript = options?.perScriptTimeoutMs;

	const sharedController = new AbortController();
	let timedOut = false;

	const deadlineTimer = setTimeout(() => {
		timedOut = true;
		sharedController.abort();
	}, totalTimeoutMs);

	const onOuterAbort = () => sharedController.abort();
	outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
	if (outerSignal?.aborted) sharedController.abort();

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

				// Per-script timeout: combine with the shared controller so either
				// the batch deadline OR the per-script deadline can abort.
				let perScriptController: AbortController | undefined;
				let perScriptTimer: ReturnType<typeof setTimeout> | undefined;
				let perScriptTimedOut = false;
				let signalToUse: AbortSignal = sharedController.signal;
				let unlinkShared: (() => void) | undefined;
				if (perScript !== undefined) {
					perScriptController = new AbortController();
					perScriptTimer = setTimeout(() => {
						perScriptTimedOut = true;
						perScriptController?.abort();
					}, perScript);
					const onShared = () => perScriptController?.abort();
					sharedController.signal.addEventListener("abort", onShared, { once: true });
					unlinkShared = () => sharedController.signal.removeEventListener("abort", onShared);
					signalToUse = perScriptController.signal;
				}

				try {
					const execResult = await sessionManager.execWithRuntimeThrottle(session, entry.script, {
						signal: signalToUse,
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
						error:
							timedOut || perScriptTimedOut
								? "timeout"
								: sharedController.signal.aborted
									? "aborted"
									: "internal error",
					};
				} finally {
					if (perScriptTimer !== undefined) clearTimeout(perScriptTimer);
					unlinkShared?.();
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
	options?: ExecuteBatchOptions,
): Promise<BatchScriptResult[]> {
	const inReadOnlyScope = readOnlyContext.getStore() !== undefined;
	if (inReadOnlyScope) {
		return runParallel(sessionManager, session, scripts, totalTimeoutMs, outerSignal, options);
	}
	return runSequential(sessionManager, session, scripts, totalTimeoutMs, outerSignal, options);
}
