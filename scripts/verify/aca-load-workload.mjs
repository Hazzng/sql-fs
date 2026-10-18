export async function visitConcurrent(items, concurrency, visit) {
	let next = 0, failed = false, failure;
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (!failed && next < items.length) {
			const index = next++;
			try { await visit(items[index], index); }
			catch (error) { if (!failed) { failed = true; failure = error; } }
		}
	}));
	if (failed) throw failure;
}

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function overloadDelayMs(retryAfter, attempt, nowMs = Date.now()) {
	const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
	const date = Date.parse(retryAfter || '');
	const minimum = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 :
		Number.isFinite(date) ? Math.max(0, date - nowMs) : 1000;
	return Math.max(minimum, Math.min(10000, 1000 * 2 ** Math.min(attempt, 4)));
}

export function buildScript(marker, cfg, path = '/home/user/aca-markers.txt') {
	return `${cfg.hold ? `sleep ${cfg.hold / 1000} && ` : ''}${cfg.cpu ? `i=0; while [ "$i" -lt ${cfg.cpu} ]; do i=$((i+1)); done; ` : ''}` +
		`printf '%s\\n' ${quote(marker)} >> ${quote(path)} && printf '%s' ${quote(marker)}`;
}

export function validateOperation(op, counts, readable) {
	const attempts = op.attempts.map(a => {
		const count = readable ? counts.get(a.marker) || 0 : null;
		return { marker: a.marker, count, valid: a.success ? count === 1 : a.safeRefusal || a.rejected ? count === 0 : null };
	});
	const count = readable ? attempts.reduce((n, a) => n + a.count, 0) : null;
	const valid = attempts.some(a => a.valid === false) ? false : op.outcome === 'unknown' ? null :
		attempts.every(a => a.valid === true) && count === (op.outcome === 'success' ? 1 : 0);
	return { op: op.id, marker: op.marker, sandbox: op.sandbox, outcome: op.outcome, count, attempts, valid };
}

export function markerIntegrity(operations, counts) {
	const known = new Set(operations.flatMap(op => op.attempts.map(a => a.marker)));
	const unexpected = [...counts.keys()].filter(marker => !known.has(marker));
	const duplicates = [...counts].filter(([, count]) => count > 1).map(([marker]) => marker);
	return { valid: unexpected.length === 0 && duplicates.length === 0,
		unexpectedCount: unexpected.length, duplicateCount: duplicates.length,
		unexpectedMarkers: unexpected.slice(0, 20), duplicateMarkers: duplicates.slice(0, 20) };
}

export function outcomeTotals(ledger) {
	const totals = { success: 0, safeRefusal: 0, unknown: 0, failed: 0 };
	for (const op of ledger) totals[Object.hasOwn(totals, op.outcome) ? op.outcome : 'unknown']++;
	return totals;
}
