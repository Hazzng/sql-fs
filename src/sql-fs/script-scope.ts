export interface ScriptScope {
	readonly isActive: boolean;
	beginScope(): void | Promise<void>;
	endScope(): Promise<void>;
	abortScope(): Promise<void>;
	run<T>(fn: () => Promise<T>): Promise<T>;
}

export async function runInScriptScope<T>(scope: ScriptScope | undefined, fn: () => Promise<T>): Promise<T> {
	if (scope === undefined || scope.isActive) return fn();
	await scope.beginScope();
	try {
		const result = await fn();
		await scope.endScope();
		return result;
	} catch (primary) {
		try {
			await scope.abortScope();
		} catch {}
		throw primary;
	}
}
