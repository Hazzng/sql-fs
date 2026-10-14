import { runInScriptScope, type ScriptScope } from "./script-scope.js";
import type { IScriptTxFs } from "./sql-fs.js";

export class SessionScopedFs implements ScriptScope {
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

	async run<T>(fn: () => Promise<T>): Promise<T> {
		return runInScriptScope(this, fn);
	}
}
