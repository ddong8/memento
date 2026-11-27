// The signed-in user from "Authorization: Bearer <jwt>" (middleware/auth.py get_current_user).
import { eq } from "drizzle-orm";
import type { Context } from "hono";

import type { AppEnv } from "../context";
import { users } from "../db/pulled/schema";
import { HttpError } from "../http";
import { decodeToken } from "./jwt";

export type UserRow = typeof users.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export async function userFromToken(c: Context<AppEnv>, token: string): Promise<UserRow> {
  const { settings, db } = c.var.deps;
  const payload = await decodeToken(token, settings.secretKey, settings.algorithm);
  const userId = payload.sub;
  if (!userId) throw new HttpError(401, "Invalid token payload");
  // uuid.UUID() in Python: a malformed id there is a 500; refuse it cleanly here
  if (!UUID_RE.test(userId)) throw new HttpError(401, "Invalid token payload");
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.status !== "active") throw new HttpError(401, "User not found or inactive");
  return user;
}

export async function currentUser(c: Context<AppEnv>): Promise<UserRow> {
  const auth = c.req.header("authorization");
  if (!auth || !auth.startsWith("Bearer ")) throw new HttpError(401, "Missing authorization");
  return userFromToken(c, auth.slice(7));
}
