/**
 * Shared JWT helpers using jose (HS256).
 * Used by CLI token generator and admin token endpoint.
 */

import { SignJWT, jwtVerify } from "jose";

export interface SignTokenOptions {
	sub: string;
	/** Tenant id claim. Omitted when not set, so legacy single-tenant tokens remain compact. */
	tenant?: string;
	expiresIn?: string; // e.g. "30d", "1y", "24h", "never" or undefined = no expiry
	secret: string;
	/** Optional JWT id claim. When set, allows correlating an issued token with audit logs. */
	jti?: string;
}

export interface VerifyTokenOptions {
	token: string;
	secret: string;
}

export interface TokenPayload {
	sub: string;
	tenant?: string;
	iat?: number;
	exp?: number;
}

/**
 * Sign a JWT with HS256.
 *
 * @param opts.sub - Subject (owner) claim.
 * @param opts.tenant - Optional tenant id claim. When omitted, the resulting token
 *                      has no `tenant` claim and auth middleware will resolve it to the default tenant.
 * @param opts.expiresIn - Expiry string (e.g. "30d", "1y", "24h", "never") or undefined for no expiry.
 * @param opts.secret - HS256 signing secret.
 * @returns The signed token string.
 */
export async function signToken({ sub, tenant, expiresIn, secret, jti }: SignTokenOptions): Promise<string> {
	const key = new TextEncoder().encode(secret);
	const body: Record<string, unknown> = { sub };
	if (tenant !== undefined) {
		body.tenant = tenant;
	}
	const jwt = new SignJWT(body).setProtectedHeader({ alg: "HS256" }).setIssuedAt();

	if (expiresIn && expiresIn !== "never") {
		jwt.setExpirationTime(expiresIn);
	}

	if (jti !== undefined) {
		jwt.setJti(jti);
	}

	return jwt.sign(key);
}

/**
 * Verify a JWT signed with HS256.
 * Returns the payload or throws on invalid/expired token.
 */
export async function verifyToken({ token, secret }: VerifyTokenOptions): Promise<TokenPayload> {
	const key = new TextEncoder().encode(secret);
	const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });

	return payload as TokenPayload;
}
