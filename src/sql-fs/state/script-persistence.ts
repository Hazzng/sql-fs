import { runTrustedDbAsync } from "../defense.js";
import { raceDriverFault } from "../driver-fault.js";
import { createEscriptbuffer, createEstale } from "../errors.js";
import type { BufferedMutation, ScriptTxBufferConfig } from "../script-tx-buffer.js";
import type { SandboxGeneration, SqlDialect } from "../types.js";
import {
	type EpochAuthority,
	type MutationReceipt,
	type MutationSpec,
	PER_MUTATION_BASE_BYTES,
	type ReplayContext,
	type ScopeSettlement,
	type ScopeStamp,
} from "./types.js";

export class ScriptPersistence<Tx> {
	readonly #dialect: SqlDialect<Tx>;

	readonly #sandboxId: string;

	#scriptScope = false;

	#scriptScopeGeneration = 0;

	#scriptTx: Tx | undefined;

	#scriptTxEnd: (() => void) | undefined;

	#scriptTxAbort: ((err: Error) => void) | undefined;

	#scriptTxPromise: Promise<void> | undefined;

	#scriptEpoch: bigint | undefined;

	#scriptEpochLagging = false;

	#scriptTxLost: Error | undefined;

	#scriptTxGeneration = 0;

	readonly #scriptTxBuffer: ScriptTxBufferConfig;

	#mutations: BufferedMutation[] = [];

	#mutationBytes = 0;

	#idRemap = new Map<bigint, bigint>();

	#nextProvisionalId = -1n;

	readonly #assertLease: () => void;

	constructor(dialect: SqlDialect<Tx>, sandboxId: string, buffer: ScriptTxBufferConfig, assertLease: () => void) {
		this.#dialect = dialect;
		this.#sandboxId = sandboxId;
		this.#scriptTxBuffer = buffer;
		this.#assertLease = assertLease;
	}

	async guarded<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await raceDriverFault(() => runTrustedDbAsync(fn));
		} catch (err) {
			if (this.#scriptScope && (err as Error & { code?: string }).code === "EDRIVERFAULT") {
				this.#scriptTxLost ??= err as Error;
			}
			throw err;
		}
	}

	async #withTx<T>(authority: EpochAuthority, fn: (tx: Tx) => Promise<T>): Promise<T> {
		if (this.#scriptScope) {
			const scopeGeneration = this.#scriptScopeGeneration;
			this.assertAlive();
			if (this.#scriptTx === undefined) {
				await this.#openScriptTx(authority);
			}
			this.assertGeneration(scopeGeneration);
			const tx = this.#scriptTx as Tx;
			return this.guarded(() => fn(tx));
		}
		return this.guarded(() =>
			this.#dialect.transaction(async (tx) => {
				await this.#dialect.setSandboxContextWithLock(tx, this.#sandboxId);
				return await fn(tx);
			}),
		);
	}

	async read<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
		this.assertAlive();
		const scriptTx = this.#scriptTx;
		if (this.#scriptScope && scriptTx !== undefined) {
			return this.guarded(() => fn(scriptTx));
		}
		return this.guarded(() =>
			this.#dialect.transaction(async (tx) => {
				await this.#dialect.setSandboxContext(tx, this.#sandboxId);
				return await fn(tx);
			}),
		);
	}

	assertAlive(): void {
		if (this.#scriptScope && this.#scriptTxLost !== undefined) throw this.#scriptTxLost;
	}

	async #openScriptTx(authority: EpochAuthority): Promise<void> {
		// #166: under the buffered shape no transaction may span the script. Reaching
		// here means a write escaped `#mutate` — loud is the only safe failure, because
		// the silent version is the very connection pin this change exists to remove.
		if (this.#scriptTxBuffer.enabled) {
			throw new Error("script-tx: a mutation bypassed the buffer while SCRIPT_TX_BUFFERED is on");
		}
		const generation = ++this.#scriptTxGeneration;
		let resolveTxReady!: () => void;
		const txReady = new Promise<void>((r) => {
			resolveTxReady = r;
		});

		let resolveEnd!: () => void;
		let rejectEnd!: (err: Error) => void;
		const endPromise = new Promise<void>((resolve, reject) => {
			resolveEnd = resolve;
			rejectEnd = reject;
		});
		// `#scriptTxAbort` is live from here, but the only `await endPromise` sits inside the
		// transaction callback below and is not reached until `setSandboxContextWithLock` resolves.
		// An abort in between — an exec timing out while the statement is queued — would otherwise
		// reject a promise nobody is listening to and kill the process under the default
		// `--unhandled-rejections=throw`. Behind a connection pooler that queue is seconds to
		// minutes wide, so the window is routine rather than theoretical. The derived chain absorbs
		// the rejection without clearing it: the `await` below still throws and still rolls back.
		endPromise.catch(() => {});
		this.#scriptTxEnd = resolveEnd;
		this.#scriptTxAbort = rejectEnd;

		const scriptTxPromise = runTrustedDbAsync(() =>
			this.#dialect.transaction(async (tx) => {
				await this.#dialect.setSandboxContextWithLock(tx, this.#sandboxId);
				// The scope may have aborted while this statement was queued; adopting `tx` now would
				// hand the next scope a rolled-back handle.
				if (generation !== this.#scriptTxGeneration || !this.#scriptScope) {
					throw new Error("script-tx abandoned: scope ended while the transaction was opening");
				}
				// Pin + compare inside the locked tx; a separate pre-read would TOCTOU.
				const epoch = await this.#dialect.getSandboxEpoch(tx, this.#sandboxId);
				if (epoch !== authority.epoch) {
					throw createEstale(this.#sandboxId);
				}
				this.#scriptEpoch = epoch;
				this.#scriptTx = tx;
				resolveTxReady();
				await endPromise;
			}),
		);
		this.#scriptTxPromise = scriptTxPromise;
		// Consumes the rejection so a lost connection cannot surface as an unhandled rejection, and
		// records it so the rest of the scope fails closed (see `#scriptTxLost`). `endScriptScope`
		// still sees the rejection via `await this.#scriptTxPromise`, because .catch() creates a new
		// derived chain without clearing the original's rejected state. `#scriptTx` is deliberately
		// left set: `endScriptScope`'s recovery keys off `hadTx` to reload the cache off the rolled-
		// back state, and that reload is still needed.
		scriptTxPromise.catch((err: unknown) => {
			this.#scriptTxLost ??= err instanceof Error ? err : new Error("script-tx connection lost");
		});

		// Race txReady against #scriptTxPromise so that a connection failure before
		// setSandboxContextWithLock completes (i.e. before resolveTxReady fires) propagates
		// immediately rather than leaving this call hanging forever. The driver fault (#169) is a
		// third way for BOTH arms to stay pending forever: postgres.js throws out of its socket
		// write instead of rejecting the query, so `setSandboxContextWithLock` never settles.
		// `scriptTxPromise` itself is deliberately NOT raced — it lives for the whole scope and
		// `endScriptScope` needs the real COMMIT verdict off it.
		try {
			await raceDriverFault(() => Promise.race([txReady, scriptTxPromise]));
		} catch (err) {
			// The transaction callback may still be parked with nobody to end it. Nothing in this
			// scope may reopen on that connection, so the loss is sticky exactly as for a rejection.
			if ((err as Error & { code?: string }).code === "EDRIVERFAULT") this.#scriptTxLost ??= err as Error;
			throw err;
		}
	}

	async #assertDurableWriteEpoch(authority: EpochAuthority, tx: Tx): Promise<void> {
		this.#assertLease();
		this.assertAlive();
		if (this.#dialect.retireSandboxGeneration === undefined) return;
		const epoch = await this.#dialect.getSandboxEpoch(tx, this.#sandboxId);
		if (epoch !== authority.epoch) {
			throw createEstale(this.#sandboxId);
		}
	}

	async #withBareTx<T>(authority: EpochAuthority, fn: (tx: Tx) => Promise<T>): Promise<MutationReceipt<T>> {
		// Composite write methods include their own set_config + pg_advisory_xact_lock in their SQL.
		// Inside a script scope every write MUST run on the single script-tx so the
		// whole script (or batch — audit H10) commits or rolls back atomically. The
		// script-tx is opened lazily here on the first composite write; the advisory
		// lock is re-entrant within that transaction, so routing subsequent composites
		// through it cannot deadlock. Starting a *fresh* transaction here while a
		// scope is active would (a) auto-commit the write outside the scope — breaking
		// atomicity — and (b) deadlock against the script-tx's advisory lock.
		if (this.#scriptScope) {
			const scopeGeneration = this.#scriptScopeGeneration;
			this.assertAlive();
			if (this.#scriptTx === undefined) {
				await this.#openScriptTx(authority);
			}
			this.assertGeneration(scopeGeneration);
			const scriptTx = this.#scriptTx as Tx;
			const value = await this.guarded(() => fn(scriptTx));
			this.assertGeneration(scopeGeneration);
			// Refresh tx-local epoch; composites advance version (mv twice).
			if (this.#scriptEpoch !== undefined) {
				const epoch = await this.guarded(() => this.#dialect.getSandboxEpoch(scriptTx, this.#sandboxId));
				this.assertGeneration(scopeGeneration);
				this.#scriptEpoch = epoch;
			}
			return { kind: "transactionLocal", value };
		}
		let observedEpoch: bigint | undefined;
		const result = await this.guarded(() =>
			this.#dialect.transaction(async (tx) => {
				if (this.#dialect.retireSandboxGeneration !== undefined) {
					await this.#dialect.setSandboxContextWithLock(tx, this.#sandboxId);
					await this.#assertDurableWriteEpoch(authority, tx);
				}
				const value = await fn(tx);
				// Publish only after COMMIT; a failed COMMIT must not poison the cache.
				observedEpoch = await this.#dialect.getSandboxEpoch(tx, this.#sandboxId);
				this.#assertLease();
				return value;
			}),
		);
		return observedEpoch === undefined
			? { kind: "transactionLocal", value: result }
			: { kind: "committed", epoch: observedEpoch, value: result };
	}

	async #withWriteTx<T>(authority: EpochAuthority, fn: (tx: Tx) => Promise<T>): Promise<MutationReceipt<T>> {
		if (this.#scriptScope) {
			const scopeGeneration = this.#scriptScopeGeneration;
			const value = await this.#withTx(authority, fn);
			this.assertGeneration(scopeGeneration);
			this.#scriptEpochLagging = true;
			return { kind: "transactionLocal", value };
		}
		let observedEpoch: bigint | undefined;
		const result = await this.guarded(() =>
			this.#dialect.transaction(async (tx) => {
				await this.#dialect.setSandboxContextWithLock(tx, this.#sandboxId);
				const epoch = await this.#dialect.getSandboxEpoch(tx, this.#sandboxId);
				if (epoch !== authority.epoch) throw createEstale(this.#sandboxId);
				const value = await fn(tx);
				// Publish only after COMMIT; a failed COMMIT must not poison the pin.
				observedEpoch = await this.#dialect.getSandboxEpoch(tx, this.#sandboxId);
				this.#assertLease();
				return value;
			}),
		);
		return observedEpoch === undefined
			? { kind: "transactionLocal", value: result }
			: { kind: "committed", epoch: observedEpoch, value: result };
	}

	#bufferingWrites(): boolean {
		return this.#scriptTxBuffer.enabled && this.#scriptScope;
	}

	#mintInodeId(): bigint {
		const id = this.#nextProvisionalId;
		this.#nextProvisionalId -= 1n;
		return id;
	}

	#realId(id: bigint): bigint {
		if (id >= 0n) return id;
		const real = this.#idRemap.get(id);
		if (real === undefined) {
			throw Object.assign(new Error(`script-tx flush: provisional inode id ${id} was never bound`), {
				code: "ECOHERENCE",
			});
		}
		return real;
	}

	#recordMutation(m: BufferedMutation): void {
		// just-bash 3.6 opens every `>` target with an empty writeFile and writes the output in a second one.
		const last = this.#mutations[this.#mutations.length - 1];
		const superseding = m.supersedes !== undefined && last?.supersedes === m.supersedes;
		const ops = this.#mutations.length + (superseding ? 0 : 1);
		const bytes = this.#mutationBytes + m.bytes - (superseding ? last!.bytes : 0);
		if (ops > this.#scriptTxBuffer.maxOps || bytes > this.#scriptTxBuffer.maxBytes) {
			const err = createEscriptbuffer(ops, bytes, this.#scriptTxBuffer.maxOps, this.#scriptTxBuffer.maxBytes);
			this.#scriptTxLost ??= err;
			throw err;
		}
		if (superseding) this.#mutations[this.#mutations.length - 1] = m;
		else this.#mutations.push(m);
		this.#mutationBytes = bytes;
	}

	#discardMutations(): void {
		this.#mutations = [];
		this.#mutationBytes = 0;
		this.#idRemap = new Map();
	}

	async #flushMutations(authority: EpochAuthority): Promise<bigint | undefined> {
		const ops = this.#mutations;
		if (ops.length === 0) return;
		const startedAt = Date.now();
		const finalEpoch = await this.guarded(() =>
			this.#dialect.transaction(async (tx) => {
				await this.#dialect.setSandboxContextWithLock(tx, this.#sandboxId);
				this.assertAlive();
				const epoch = await this.#dialect.getSandboxEpoch(tx, this.#sandboxId);
				if (epoch !== authority.epoch) {
					throw createEstale(this.#sandboxId);
				}
				this.#scriptEpoch = epoch;
				for (const op of ops) {
					this.#assertLease();
					const produced = await (op.run as (handle: Tx) => Promise<readonly (bigint | undefined)[]>)(tx);
					for (let i = 0; i < op.minted.length; i++) {
						const real = produced[i];
						if (real !== undefined) this.#idRemap.set(op.minted[i]!, real);
					}
				}
				const result = await this.#dialect.getSandboxEpoch(tx, this.#sandboxId);
				this.#assertLease();
				return result;
			}),
		);
		this.#scriptEpoch = finalEpoch;
		console.log(
			JSON.stringify({
				event: "script_tx_flush",
				sandboxId: this.#sandboxId,
				ops: ops.length,
				bufferedBytes: this.#mutationBytes,
				durationMs: Date.now() - startedAt,
			}),
		);
		return finalEpoch;
	}

	assertGeneration(generation: number | undefined): void {
		if (generation === undefined && this.#scriptScope) throw createEstale(this.#sandboxId);
		if (generation !== undefined && (!this.#scriptScope || generation !== this.#scriptScopeGeneration)) {
			throw this.#scriptTxLost ?? createEstale(this.#sandboxId);
		}
		this.assertAlive();
	}

	async #settleLaggingScriptEpoch(): Promise<void> {
		const scriptTx = this.#scriptTx;
		if (!this.#scriptEpochLagging || scriptTx === undefined || this.#scriptEpoch === undefined) return;
		this.#scriptEpochLagging = false;
		this.#scriptEpoch = await this.guarded(() => this.#dialect.getSandboxEpoch(scriptTx, this.#sandboxId));
	}

	begin(): void {
		this.assertAlive();
		if (this.#scriptScope) {
			throw new Error("beginScriptScope: a script scope is already active");
		}
		this.#scriptTxLost = undefined;
		this.#scriptEpochLagging = false;
		this.#discardMutations();
		// Any open still in flight from a previous scope belongs to an older generation and will
		// abandon itself rather than adopt into this one.
		this.#scriptTxGeneration += 1;
		this.#scriptScopeGeneration += 1;
		this.#scriptScope = true;
	}

	get scopeActive(): boolean {
		return this.#scriptScope;
	}

	get transactionOpen(): boolean {
		return this.#scriptTx !== undefined;
	}

	get buffering(): boolean {
		return this.#bufferingWrites();
	}

	#replay(authority: EpochAuthority): ReplayContext {
		const owner = this;
		return {
			get expectedEpoch() {
				return owner.#scriptEpoch ?? authority.epoch;
			},
			resolveInodeId(id) {
				return owner.#realId(id);
			},
		};
	}

	captureGeneration(): number | undefined {
		return this.#scriptScope ? this.#scriptScopeGeneration : undefined;
	}

	captureReservation(): ScopeStamp {
		return { generation: this.#scriptScopeGeneration, active: this.#scriptScope };
	}

	assertReservation(stamp: ScopeStamp): void {
		if (stamp.active !== this.#scriptScope || stamp.generation !== this.#scriptScopeGeneration)
			throw this.#scriptTxLost ?? createEstale(this.#sandboxId);
		this.assertGeneration(stamp.active ? stamp.generation : undefined);
	}

	async mutate(authority: EpochAuthority, op: MutationSpec<Tx>): Promise<MutationReceipt<readonly bigint[]>> {
		const generation = this.captureGeneration();
		const replay = this.#replay(authority);
		const run = (tx: Tx) => op.run(tx, replay);
		const mints = op.mints ?? 0;
		if (this.buffering) {
			this.assertAlive();
			const minted: bigint[] = [];
			for (let i = 0; i < mints; i++) minted.push(this.#mintInodeId());
			this.#recordMutation({
				kind: op.kind,
				minted,
				bytes: op.bytes ?? PER_MUTATION_BASE_BYTES,
				supersedes: op.supersedes,
				run,
			});
			return { kind: "recorded", value: minted };
		}
		const receipt = op.composite ? await this.#withBareTx(authority, run) : await this.#withWriteTx(authority, run);
		if (generation !== undefined) this.assertGeneration(generation);
		return { ...receipt, value: receipt.value as readonly bigint[] };
	}

	async mutateOne(authority: EpochAuthority, op: Omit<MutationSpec<Tx>, "mints">): Promise<MutationReceipt<bigint>> {
		const generation = this.captureGeneration();
		const receipt = await this.mutate(authority, { ...op, mints: 1 });
		if (generation !== undefined) this.assertGeneration(generation);
		return { ...receipt, value: receipt.value[0] as bigint };
	}

	async write<T>(
		authority: EpochAuthority,
		run: (tx: Tx, replay: ReplayContext) => Promise<T>,
	): Promise<MutationReceipt<T>> {
		return this.#withWriteTx(authority, (tx) => run(tx, this.#replay(authority)));
	}

	async readForAppend<T>(authority: EpochAuthority, run: (tx: Tx) => Promise<T>): Promise<T> {
		return this.buffering ? this.read(run) : this.#withTx(authority, run);
	}

	async readSnapshot<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
		return this.guarded(() =>
			this.#dialect.transaction(
				async (tx) => {
					await this.#dialect.setSandboxContext(tx, this.#sandboxId);
					return run(tx);
				},
				{ isolationLevel: "repeatable read" },
			),
		);
	}

	async claimGeneration(): Promise<SandboxGeneration | undefined> {
		this.#assertLease();
		this.assertAlive();
		const retire = this.#dialect.retireSandboxGeneration;
		if (retire === undefined) return undefined;
		if (this.#scriptScope) throw createEstale(this.#sandboxId);
		const certificate = await this.guarded(() =>
			this.#dialect.transaction(async (tx) => {
				const result = await retire.call(this.#dialect, tx, this.#sandboxId, this.#assertLease);
				this.#assertLease();
				return result;
			}),
		);
		this.assertAlive();
		return certificate;
	}

	async finish(authority: EpochAuthority): Promise<ScopeSettlement> {
		if (!this.#scriptScope) return { kind: "unchanged" };
		const lost = this.#scriptTxLost;
		if (lost !== undefined) {
			const recovery = await this.abort();
			return { kind: "failed", error: lost, reloadRequired: recovery.reloadRequired };
		}
		this.#scriptScope = false;
		const hadTx = this.#scriptTx !== undefined || this.#mutations.length > 0;
		let committed = false;
		try {
			const flushedEpoch = await this.#flushMutations(authority);
			await this.#settleLaggingScriptEpoch();
			if (this.#scriptTxEnd !== undefined) {
				this.#assertLease();
				this.#scriptTxEnd();
				const txPromise = this.#scriptTxPromise;
				if (txPromise !== undefined) await raceDriverFault(() => txPromise);
			}
			committed = true;
			if (this.#scriptEpoch === undefined) return { kind: "unchanged" };
			return {
				kind: "committed",
				epoch: this.#scriptEpoch,
				inodeRemap: flushedEpoch === undefined ? undefined : this.#idRemap,
			};
		} catch (error) {
			if (hadTx && !committed) {
				const abort = this.#scriptTxAbort;
				const txPromise = this.#scriptTxPromise;
				if (abort !== undefined) abort(error instanceof Error ? error : new Error("script-tx aborted"));
				if (txPromise !== undefined) {
					try {
						await txPromise;
					} catch {}
				}
			}
			return { kind: "failed", error, reloadRequired: hadTx };
		} finally {
			this.#clearTransaction();
			this.#discardMutations();
		}
	}

	#clearTransaction(): void {
		this.#scriptTx = undefined;
		this.#scriptTxEnd = undefined;
		this.#scriptTxAbort = undefined;
		this.#scriptTxPromise = undefined;
		this.#scriptEpoch = undefined;
		this.#scriptEpochLagging = false;
	}

	async abort(): Promise<{ readonly reloadRequired: boolean }> {
		if (!this.#scriptScope) return { reloadRequired: false };
		this.#scriptScope = false;
		const hadTx = this.#scriptTx !== undefined || this.#mutations.length > 0;
		this.#discardMutations();
		const abort = this.#scriptTxAbort;
		const txPromise = this.#scriptTxPromise;
		this.#clearTransaction();
		if (abort !== undefined) abort(new Error("script-tx aborted"));
		if (txPromise !== undefined) txPromise.catch(() => {});
		return { reloadRequired: hadTx };
	}
}
