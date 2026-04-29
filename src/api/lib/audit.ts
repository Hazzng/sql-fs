export function logAudit(event: string, fields: Record<string, unknown>): void {
	// `event` last so callers cannot spoof it by passing `event` in `fields`.
	console.log(JSON.stringify({ ...fields, event }));
}
