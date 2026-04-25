import type { RuntimeOptions, Session, SessionManager } from "./session-manager.js";

export function createForbiddenError(): Error {
	return Object.assign(new Error("forbidden"), { code: "FORBIDDEN" });
}

export function isForbiddenError(err: unknown): boolean {
	return (err as Error & { code?: string })?.code === "FORBIDDEN";
}

export function forbiddenResponse(): Response {
	return Response.json({ error: "forbidden", code: "FORBIDDEN" }, { status: 403 });
}

export function assertSessionOwner(session: Pick<Session, "owner">, caller: string): void {
	if (session.owner && session.owner !== caller) {
		throw createForbiddenError();
	}
}

/**
 * Wrap a session operation with both rehydration and ownership enforcement.
 * The owner check runs inside the same session-locked path as the operation,
 * so cold sandboxes restored from Postgres are checked under lock rather than
 * via a racy in-memory snapshot.
 */
export async function withOwnedSessionOrRehydrate<T>(
	sessionManager: SessionManager,
	tenantId: string,
	sandboxId: string,
	caller: string,
	fn: (session: Session) => Promise<T>,
	runtimeOptions?: RuntimeOptions,
): Promise<T> {
	return sessionManager.withSessionOrRehydrate(
		tenantId,
		sandboxId,
		async (session) => {
			assertSessionOwner(session, caller);
			return fn(session);
		},
		runtimeOptions,
	);
}
