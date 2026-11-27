// Auth dependencies matching server/server/middleware/auth.py.
import { timingSafeEqual } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { Context } from "hono";

import type { AppEnv } from "../context";
import { users } from "../db/pulled/schema";
import { HttpError, normalizeUuid, requiredHeader } from "../http";
import { decodeToken } from "./jwt";

export type UserRow = typeof users.$inferSelect;

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export async function userFromToken(c: Context<AppEnv>, token: string): Promise<UserRow> {
  const { settings, db } = c.var.deps;
  const payload = await decodeToken(token, settings.secretKey, settings.algorithm);
  const userId = normalizeUuid(payload.sub);
  if (!userId) throw new HttpError(401, "Invalid token payload");
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.status !== "active") throw new HttpError(401, "User not found or inactive");
  return user;
}

export async function currentUser(c: Context<AppEnv>): Promise<UserRow> {
  const auth = c.req.header("authorization");
  if (!auth || !auth.startsWith("Bearer ")) throw new HttpError(401, "Missing authorization");
  return userFromToken(c, auth.slice(7));
}

export async function currentUserFlexible(c: Context<AppEnv>): Promise<UserRow> {
  const auth = c.req.header("authorization");
  let raw: string | null = null;
  if (auth && auth.startsWith("Bearer ")) raw = auth.slice(7);
  else if (c.req.query("token")) raw = c.req.query("token")!;
  else if (c.req.query("access_token")) raw = c.req.query("access_token")!;
  if (!raw) throw new HttpError(401, "Missing authorization");
  return userFromToken(c, raw);
}

export async function optionalUser(c: Context<AppEnv>): Promise<UserRow | null> {
  const auth = c.req.header("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  try {
    return await currentUser(c);
  } catch (e) {
    if (e instanceof HttpError) return null;
    throw e;
  }
}

export async function verifyCollectorTokenValue(c: Context<AppEnv>, token: string): Promise<UserRow> {
  const { settings, db } = c.var.deps;
  const [user] = await db.select().from(users).where(eq(users.collectorToken, token)).limit(1);
  if (user) {
    if (user.status !== "active") throw new HttpError(401, "Account is not active");
    return user;
  }
  if (safeEqual(token, settings.collectorToken)) {
    const [owner] = await db.select().from(users).where(and(eq(users.role, "owner"), eq(users.status, "active"))).limit(1);
    if (owner) return owner;
  }
  throw new HttpError(401, "Invalid collector token");
}

export async function verifyCollectorToken(c: Context<AppEnv>): Promise<UserRow> {
  const token = requiredHeader(c, "x-collector-token");
  return verifyCollectorTokenValue(c, token);
}

export async function currentUserOrCollector(c: Context<AppEnv>): Promise<UserRow> {
  const auth = c.req.header("authorization");
  if (auth && auth.startsWith("Bearer ")) return currentUser(c);
  const collector = c.req.header("x-collector-token");
  if (collector) return verifyCollectorTokenValue(c, collector);
  throw new HttpError(401, "Missing authorization");
}

export function requireRole(user: UserRow, ...roles: string[]): void {
  if (!roles.includes(user.role)) throw new HttpError(403, "Insufficient permissions");
}
