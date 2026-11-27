// /api/auth: sign-in with a password, token refresh, collector-token exchange, the registration mode the
// register page shows, and the signed-in user (api/auth.py). Same requests, responses and errors.
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";

import { record } from "../audit";
import { createAccessToken } from "../auth/jwt";
import { currentUser, type UserRow } from "../auth/current-user";
import { verifyPassword } from "../auth/password";
import { auditRequest, requestIp, type AppEnv } from "../context";
import { withoutNul } from "../db/client";
import { users } from "../db/pulled/schema";
import { HttpError, jsonBody } from "../http";
import * as rateLimit from "../rate-limit";

export const LOGIN_WINDOW = 15 * 60;
export const LOGIN_MAX_PER_ACCOUNT = 10;
export const LOGIN_MAX_PER_IP = 30;
export const TOKEN_EXCHANGE_MAX_PER_IP = 30;
export const TOKEN_EXCHANGE_WINDOW = 600;

const timingSafeEqual = (a: string, b: string) => {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
};

/** UserResponse: the fields and order pydantic serializes. */
export function userResponse(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    collector_token: u.collectorToken,
    avatar_url: u.avatarUrl,
  };
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/registration-mode", async (c) => {
  const { settings, db } = c.var.deps;
  const [any] = await db.select({ id: users.id }).from(users).limit(1);
  return c.json({
    mode: settings.registrationMode,
    has_any_user: !!any,
    github_enabled: !!(settings.githubClientId && settings.githubClientSecret),
    wechat_enabled: !!settings.wechatToken,
    sso_enabled: !!(settings.oidcIssuer && settings.oidcClientId && settings.oidcClientSecret),
    sso_name: settings.oidcDisplayName || "",
    password_login: settings.passwordLogin,
  });
});

authRoutes.post("/login", async (c) => {
  const { settings, db } = c.var.deps;
  const redis = c.var.deps.redis();
  const req = await jsonBody(c, ["email", "password"] as const);
  const accountKey = `login:account:${req.email.trim().toLowerCase()}`;
  const ipKey = `login:ip:${requestIp(c) || "unknown"}`;
  await rateLimit.check(redis, accountKey, LOGIN_MAX_PER_ACCOUNT);
  await rateLimit.check(redis, ipKey, LOGIN_MAX_PER_IP);

  const [user] = await db.select().from(users).where(eq(users.email, req.email)).limit(1);
  if (!user || !user.hashedPassword || !verifyPassword(req.password, user.hashedPassword)) {
    await rateLimit.hit(redis, accountKey, LOGIN_WINDOW);
    await rateLimit.hit(redis, ipKey, LOGIN_WINDOW);
    await record(db, user ?? null, "auth.login_failed", auditRequest(c), { detail: { email: req.email.trim().toLowerCase() } });
    throw new HttpError(401, "Invalid credentials");
  }
  if (user.status !== "active") throw new HttpError(403, "Account not yet approved");
  // Password sign-in turned off for the company: only the owner keeps it, to get in if SSO breaks
  if (!settings.passwordLogin && user.role !== "owner") throw new HttpError(403, "请使用企业账号登录");

  await rateLimit.reset(redis, accountKey);
  await record(db, user, "auth.login", auditRequest(c));
  const token = await createAccessToken(user.id, user.role, settings.secretKey, settings.accessTokenExpireMinutes, settings.algorithm);
  return c.json({ access_token: token, token_type: "bearer", user_id: user.id, role: user.role });
});

authRoutes.post("/refresh", async (c) => {
  const { settings } = c.var.deps;
  const user = await currentUser(c);
  if (user.status !== "active") throw new HttpError(403, "Account not active");
  const token = await createAccessToken(user.id, user.role, settings.secretKey, settings.accessTokenExpireMinutes, settings.algorithm);
  return c.json({ access_token: token, token_type: "bearer", user_id: user.id, role: user.role });
});

authRoutes.post("/token-exchange", async (c) => {
  const { settings, db } = c.var.deps;
  const redis = c.var.deps.redis();
  const ipKey = `token_exchange:ip:${requestIp(c) || "unknown"}`;
  await rateLimit.check(redis, ipKey, TOKEN_EXCHANGE_MAX_PER_IP);

  const given = c.req.header("x-collector-token");
  if (!given) {
    await rateLimit.hit(redis, ipKey, TOKEN_EXCHANGE_WINDOW);
    throw new HttpError(401, "X-Collector-Token header required");
  }
  let [user] = await db.select().from(users).where(eq(users.collectorToken, given)).limit(1);
  // Legacy global token -> the owner
  if (!user && timingSafeEqual(given, settings.collectorToken)) {
    [user] = await db.select().from(users).where(and(eq(users.role, "owner"), eq(users.status, "active"))).limit(1);
  }
  if (!user || user.status !== "active") {
    await rateLimit.hit(redis, ipKey, TOKEN_EXCHANGE_WINDOW);
    throw new HttpError(401, "Invalid collector token");
  }
  const token = await createAccessToken(user.id, user.role, settings.secretKey, settings.accessTokenExpireMinutes, settings.algorithm);
  return c.json({ access_token: token, token_type: "bearer", user_id: user.id, role: user.role });
});

authRoutes.get("/me", async (c) => c.json(userResponse(await currentUser(c))));

/** Validated avatar: "" clears it, a data:image/ URI up to 2 MB, or an http(s) URL cut at 2048. */
export function cleanAvatar(raw: string): string | null {
  const avatar = raw.trim();
  if (!avatar) return null;
  if (avatar.startsWith("data:image/")) {
    if (avatar.length > 2 * 1024 * 1024) throw new HttpError(400, "Avatar image size exceeds 2MB limit");
    return avatar;
  }
  if (avatar.startsWith("http://") || avatar.startsWith("https://")) return avatar.slice(0, 2048);
  throw new HttpError(400, "Invalid avatar URL or data URI format");
}

authRoutes.patch("/me", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  if (user.status !== "active") throw new HttpError(403, "Account not active");
  const req = await jsonBody(c, [] as const, ["name", "avatar_url"] as const);
  const changes: Partial<typeof users.$inferInsert> = {};
  if (req.name != null) {
    const clean = req.name.trim();
    changes.name = clean ? [...clean].slice(0, 255).join("") : null;
  }
  if (req.avatar_url != null) changes.avatarUrl = cleanAvatar(req.avatar_url);
  if (Object.keys(changes).length === 0) return c.json(userResponse(user));
  const [updated] = await db
    .update(users)
    .set({ ...withoutNul(changes), updatedAt: sql`now()` as unknown as string })
    .where(eq(users.id, user.id))
    .returning();
  return c.json(userResponse(updated ?? user));
});
