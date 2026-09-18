// Mint an HS256 bearer token. Must live inside the repo so `jose` resolves.
import { SignJWT } from "jose";

const secret = process.env.AUTH_SECRET;
if (!secret) throw new Error("AUTH_SECRET is required");

console.log(
	await new SignJWT({ sub: process.argv[2] ?? "loadtest-owner" })
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setExpirationTime("12h")
		.sign(new TextEncoder().encode(secret)),
);
