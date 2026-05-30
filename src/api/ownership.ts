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

/**
 * Fail-CLOSED ownership predicate. Returns `true` only when the caller is
 * positively identified AND matches the recorded owner.
 *
 * Audit M1: the previous check (`owner && owner !== caller`) was fail-OPEN — an
 * empty/NULL `owner` skipped the comparison entirely, so every authenticated
 * caller could reach an ownerless sandbox. Auth always populates a non-empty
 * `sub` (see auth.ts), and both create paths persist `owner = caller`, so an
 * empty owner only ever indicates legacy/corrupt data and must NOT grant access.
 */
export function isOwnedBy(owner: string | null | undefined, caller: string): boolean {
	return caller.length > 0 && !!owner && owner === caller;
}

export function assertSessionOwner(session: Pick<Session, "owner">, caller: string): void {
	if (!isOwnedBy(session.owner, caller)) {
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

/**
 * readOnly variant of withOwnedSessionOrRehydrate. Routes through
 * `SessionManager.withSessionRead` (shared RWLock, no distributed exec
 * lock, FS in read-only scope). The owner check still runs inside the
 * session's shared scope so cold sandboxes restored from Postgres are
 * authorized under lock rather than via a racy in-memory snapshot.
 */
export async function withOwnedSessionRead<T>(
	sessionManager: SessionManager,
	tenantId: string,
	sandboxId: string,
	caller: string,
	fn: (session: Session) => Promise<T>,
	runtimeOptions?: RuntimeOptions,
): Promise<T> {
	return sessionManager.withSessionRead(
		tenantId,
		sandboxId,
		async (session) => {
			assertSessionOwner(session, caller);
			return fn(session);
		},
		runtimeOptions,
	);
}
