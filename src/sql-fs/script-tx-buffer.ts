/**
 * Buffered script-tx: configuration and the shape of one recorded mutation (#166).
 *
 * The legacy shape held ONE Postgres transaction open for the whole of `bash.exec`,
 * so a pooled server connection sat `idle in transaction` for as long as the user's
 * script ran — `sleep`, a Python step, a `git clone`. Under a transaction pooler that
 * wedges the pool at roughly `default_pool_size` concurrent writers. Buffered mode
 * records each mutation instead and replays the whole journal in one short
 * transaction at scope end, so the pinned window is a function of our own SQL
 * rather than of user code.
 */

/**
 * One recorded metadata mutation, replayed against the flush transaction.
 *
 * Deliberately NOT a data description: `run` is the same dialect call the eager
 * path makes, so the flush issues byte-identical SQL in the same order and inherits
 * the composites' fence-and-advance semantics unchanged.
 */
export interface BufferedMutation {
	/** Method name, for the flush log and the cap error. */
	readonly kind: string;
	/**
	 * Provisional (negative) inode ids this op minted, in the order `run` returns
	 * the real ones. Empty for ops that create no inode.
	 */
	readonly minted: readonly bigint[];
	/** Estimated bytes this op keeps alive while buffered — charged against the cap. */
	readonly bytes: number;
	/**
	 * Replays the op on the flush transaction, returning the real inode ids
	 * positionally matching `minted`. `undefined` in a slot means the database did
	 * not produce an id for that mint, which the post-flush provisional sweep turns
	 * into a hard failure rather than letting a negative id escape the caches.
	 *
	 * Declared with the dialect handle as `never` and in method syntax on purpose: the
	 * journal is a heterogeneous list held by a `SqlFs<Tx>` whose own `Tx` must stay
	 * covariant for the tests that assign a `SqlFs<PgTx>` to a `SqlFs<unknown>`. The
	 * only caller is `#flushMutations`, which passes the one transaction handle this
	 * session's dialect produced.
	 */
	run(tx: never): Promise<readonly (bigint | undefined)[]>;
}

/** Caps and the kill switch for the buffered script-tx. */
export interface ScriptTxBufferConfig {
	readonly enabled: boolean;
	readonly maxOps: number;
	readonly maxBytes: number;
}

/**
 * Cap defaults — chosen to be unreachable by legitimate work, which is the point:
 * the cap exists so buffer memory is *provably* bounded, not so it fires.
 *
 * Measured against the load harness (replica A, `script_tx_flush` log lines):
 *
 * | script                                              | ops   | buffered |
 * |-----------------------------------------------------|-------|----------|
 * | create 3,317 files across 60 dirs — the most a       | 3,317 | 648 KiB  |
 * | single exec can do, because just-bash caps a script  |       |          |
 * | at 10,000 commands (`maxCommandCount`)               |       |          |
 * | `cp -r` that whole tree                              |     1 | 485 KiB  |
 * | `chmod` sweep over it                                | 3,317 | 648 KiB  |
 * | `rm -rf` both trees                                  |     2 | 519 KiB  |
 *
 * 50,000 operations is 5x just-bash's own `maxCommandCount` default of 10,000, so
 * no single exec can approach it even if every command issued four mutations, and
 * 50x `MAX_BULK_WRITE_FILES` (1,000), the largest non-exec batch that runs inside a
 * scope. 32 MiB covers a `cp -r`/`rm -r` plan over a ~200,000-entry tree — larger
 * than the path cache a warm session is budgeted for in the first place.
 *
 * The buffer holds metadata only — paths, names, shas, ids, and the subtree plans
 * `cp -r`/`rm -r` capture. File bytes are NOT buffered: `commitBlob` commits blob
 * content eagerly on its own connection, and the 3 h GC grace window
 * (`BLOB_GC_MIN_AGE_MS`) covers a blob that is written but not yet referenced.
 *
 * At the cap the script fails closed with ESCRIPTBUFFER and nothing is applied.
 * Auto-flushing instead would break per-script atomicity.
 */
export const DEFAULT_SCRIPT_TX_BUFFER_MAX_OPS = 50_000;
export const DEFAULT_SCRIPT_TX_BUFFER_MAX_BYTES = 32 * 1024 * 1024;

function envPositiveInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Reads the rollout switch. **Default on**: the legacy shape wedges a whole replica
 * under a transaction pooler, so leaving it on by default would mean shipping a fix
 * nobody runs. `SCRIPT_TX_BUFFERED=false` restores the script-long transaction
 * without a code change, and both shapes stay fully wired.
 */
export function loadScriptTxBufferConfig(): ScriptTxBufferConfig {
	return {
		enabled: process.env.SCRIPT_TX_BUFFERED !== "false",
		maxOps: envPositiveInt("SCRIPT_TX_BUFFER_MAX_OPS", DEFAULT_SCRIPT_TX_BUFFER_MAX_OPS),
		maxBytes: envPositiveInt("SCRIPT_TX_BUFFER_MAX_BYTES", DEFAULT_SCRIPT_TX_BUFFER_MAX_BYTES),
	};
}
