import type { IScriptTxFs } from "./sql-fs.js";

export class SessionScopedFs {
	readonly #inner: IScriptTxFs;

	constructor(inner: IScriptTxFs) {
		this.#inner = inner;
	}

	get inner(): IScriptTxFs {
		return this.#inner;
	}

	get isActive(): boolean {
		return this.#inner.scriptScopeActive;
	}

	get hasTx(): boolean {
		return this.#inner.scriptTxOpen;
	}

	beginScope(): void {
		if (this.#inner.scriptScopeActive) return;
		this.#inner.beginScriptScope();
	}

	async endScope(): Promise<void> {
		if (!this.#inner.scriptScopeActive) return;
		await this.#inner.endScriptScope();
	}

	async abortScope(): Promise<void> {
		if (!this.#inner.scriptScopeActive) return;
		await this.#inner.abortScriptScope();
	}

	/**
	 * Run `fn` inside one script-tx scope: commit when it returns, roll back when it throws.
	 *
	 * A returned value commits even when it represents a rejected outcome — a rejection writes
	 * nothing, and the lazily-opened transaction must still be closed rather than left open.
	 *
	 * Nests safely: when a scope is already open, this runs inside it and leaves committing or
	 * rolling back to whoever opened it — finalizing another caller's transaction here would
	 * commit its half-run script.
	 */
	async run<T>(fn: () => Promise<T>): Promise<T> {
		const ownsScope = !this.isActive;
		if (ownsScope) this.beginScope();
		try {
			const result = await fn();
			if (ownsScope) await this.endScope();
			return result;
		} catch (err) {
			if (ownsScope) await this.abortScope();
			throw err;
		}
	}
}
