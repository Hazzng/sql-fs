/**
 * Shared JWT helpers using jose (HS256).
 * Used by CLI token generator and admin token endpoint.
 */

import { SignJWT, jwtVerify } from "jose";

export interface SignTokenOptions {
	sub: string;
	expiresIn?: string; // e.g. "30d", "1y", "24h", "never" or undefined = no expiry
	secret: string;
}

export interface VerifyTokenOptions {
	token: string;
	secret: string;
}

export interface TokenPayload {
	sub: string;
	iat?: number;
	exp?: number;
}

/**
 * Sign a JWT with HS256.
 * Returns the signed token string.
 */
export async function signToken({ sub, expiresIn, secret }: SignTokenOptions): Promise<string> {
	const key = new TextEncoder().encode(secret);
	const jwt = new SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).setIssuedAt();

	if (expiresIn && expiresIn !== "never") {
		jwt.setExpirationTime(expiresIn);
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
