// Access tokens exactly as python-jose makes them (middleware/auth.py): HS256 over {"sub","role","exp"},
// so a token from either server works on the other and nobody is signed out by the migration.
import { jwtVerify, SignJWT } from "jose";

import { HttpError } from "../http";

export interface TokenClaims {
  sub?: string;
  role?: string;
  exp?: number;
}

const key = (secret: string) => new TextEncoder().encode(secret);

export async function createAccessToken(userId: string, role: string, secret: string, expireMinutes: number, algorithm = "HS256"): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + expireMinutes * 60;
  return new SignJWT({ sub: userId, role, exp }).setProtectedHeader({ alg: algorithm, typ: "JWT" }).sign(key(secret));
}

export async function decodeToken(token: string, secret: string, algorithm = "HS256"): Promise<TokenClaims> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: [algorithm] });
    return payload as TokenClaims;
  } catch {
    throw new HttpError(401, "Invalid token");
  }
}
