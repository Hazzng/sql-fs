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

export async function withOwnedSessionOrRehydrate<T>(
	sessionManager: SessionManager,
	sandboxId: string,
	caller: string,
	fn: (session: Session) => Promise<T>,
	runtimeOptions?: RuntimeOptions,
): Promise<T> {
	return sessionManager.withSessionOrRehydrate(
		sandboxId,
		async (session) => {
			assertSessionOwner(session, caller);
			return fn(session);
		},
		runtimeOptions,
	);
}
