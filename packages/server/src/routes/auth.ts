// /api/auth: register, login, refresh, token-exchange, GitHub OAuth, WeChat login, profile & avatar
// (server/server/api/auth.py).
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";

import { record } from "../audit";
import { currentUser, type UserRow } from "../auth/current-user";
import { createAccessToken } from "../auth/jwt";
import { hashPassword, verifyPassword } from "../auth/password";
import { cacheGet, cacheSet } from "../cache";
import type { Settings } from "../config";
import { auditRequest, requestIp, type AppEnv } from "../context";
import { withoutNul } from "../db/client";
import { inviteCodes, users } from "../db/pulled/schema";
import { HttpError, jsonBody } from "../http";
import { pgToIso } from "../pytime";
import * as rateLimit from "../rate-limit";
import { oidcEnabled, sanitizeNext } from "./sso";

export const LOGIN_WINDOW = 15 * 60;
export const LOGIN_MAX_PER_ACCOUNT = 10;
export const LOGIN_MAX_PER_IP = 30;
export const REGISTER_WINDOW = 60 * 60;
export const REGISTER_MAX_PER_IP = 10;
export const TOKEN_EXCHANGE_MAX_PER_IP = 30;
export const TOKEN_EXCHANGE_WINDOW = 600;
export const PAIR_CLAIM_MAX_PER_IP = 20;
export const PAIR_CLAIM_WINDOW = 600;
export const PAIR_CODE_TTL_SECONDS = 90;
const WECHAT_MAX_SKEW_SECONDS = 300;

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

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

function detectAvatarMime(data: Uint8Array): string | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
    return "image/png";
  }
  const head6 = Buffer.from(data.subarray(0, 6)).toString("ascii");
  if (head6 === "GIF87a" || head6 === "GIF89a") return "image/gif";
  if (
    data.length >= 12 &&
    Buffer.from(data.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(data.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

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

function githubRedirectUri(c: Context<AppEnv>, settings: Settings): string {
  if (settings.publicUrl) return `${settings.publicUrl.replace(/\/+$/, "")}/api/auth/github/callback`;
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() || c.req.header("host") || url.host;
  return `${proto}://${host}/api/auth/github/callback`;
}

function signState(secretKey: string, payloadB64: string): string {
  return createHmac("sha256", secretKey).update(payloadB64, "utf8").digest("hex");
}

function makeGhState(secretKey: string, nextPath: string): string {
  const payload = { n: randomBytes(16).toString("hex"), t: Math.floor(Date.now() / 1000), next: nextPath };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${signState(secretKey, payloadB64)}`;
}

function verifyGhState(secretKey: string, state: string): string | null {
  try {
    const dot = state.indexOf(".");
    if (dot < 0) return null;
    const b64 = state.slice(0, dot);
    const sig = state.slice(dot + 1);
    if (!safeEqual(sig, signState(secretKey, b64))) return null;
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as { t: number; next?: string };
    if (Math.abs(Date.now() / 1000 - Number(payload.t)) > 600) return null;
    return sanitizeNext(payload.next);
  } catch {
    return null;
  }
}

// ---- One-Time Mobile Pairing Codes (standalone & cloud QR login) ----
interface PairCodeRecord {
  user_id: string;
  role: string;
  expires_at: number;
}
const pairCodes = new Map<string, PairCodeRecord>();

function cleanExpiredPairCodes(): void {
  const now = Date.now();
  for (const [k, v] of pairCodes) {
    if (v.expires_at <= now) pairCodes.delete(k);
  }
}

async function storePairCode(c: Context<AppEnv>, code: string, rec: PairCodeRecord): Promise<void> {
  cleanExpiredPairCodes();
  if (pairCodes.size > 1000) {
    const oldest = pairCodes.keys().next().value;
    if (oldest) pairCodes.delete(oldest);
  }
  pairCodes.set(code, rec);
  const redis = c.var.deps.redis();
  if (redis) {
    try {
      await redis.set(`memento:pair:${code}`, JSON.stringify(rec), "EX", PAIR_CODE_TTL_SECONDS);
    } catch {
      /* fallback to memory when redis is unavailable */
    }
  }
}

async function consumePairCode(c: Context<AppEnv>, code: string): Promise<PairCodeRecord | null> {
  const redis = c.var.deps.redis();
  if (redis) {
    try {
      const key = `memento:pair:${code}`;
      let raw: string | null = null;
      if (typeof (redis as unknown as { getdel?: (k: string) => Promise<string | null> }).getdel === "function") {
        raw = await (redis as unknown as { getdel: (k: string) => Promise<string | null> }).getdel(key);
      } else {
        const res = await redis.multi().get(key).del(key).exec();
        raw = (res?.[0]?.[1] as string | null) ?? null;
      }
      pairCodes.delete(code);
      if (raw) {
        const parsed = JSON.parse(raw) as PairCodeRecord;
        return parsed.expires_at > Date.now() ? parsed : null;
      }
      return null;
    } catch {
      /* fall through to in-memory store */
    }
  }
  const local = pairCodes.get(code) ?? null;
  pairCodes.delete(code);
  if (!local || local.expires_at <= Date.now()) return null;
  return local;
}

// ---- WeChat Ticket Store ----
interface WechatTicket {
  status: string;
  openid: string | null;
  created_at: number;
  completed_at?: number;
}
const wechatTickets = new Map<string, WechatTicket>();

function cleanExpiredTickets(): void {
  const now = Date.now() / 1000;
  for (const [k, v] of wechatTickets) if (now - (v.created_at || 0) > 600) wechatTickets.delete(k);
}

async function getTicketData(c: Context<AppEnv>, code: string): Promise<WechatTicket | null> {
  const redis = c.var.deps.redis();
  const cached = await cacheGet(redis, `wechat_ticket:${code}`, 0);
  if (cached && typeof cached === "object") return cached as WechatTicket;
  return wechatTickets.get(code) ?? null;
}

async function setTicketData(c: Context<AppEnv>, code: string, data: WechatTicket, ttlSec = 300): Promise<void> {
  wechatTickets.set(code, data);
  await cacheSet(c.var.deps.redis(), `wechat_ticket:${code}`, data, ttlSec, { l1: false });
}

async function deleteTicketData(c: Context<AppEnv>, code: string): Promise<void> {
  wechatTickets.delete(code);
  await cacheSet(c.var.deps.redis(), `wechat_ticket:${code}`, { status: "used" }, 60, { l1: false });
}

function wechatTokenUsed(settings: Settings, signature: string, timestamp: string, nonce: string): "current" | "previous" | null {
  for (const [label, tok] of [
    ["current", settings.wechatToken],
    ["previous", settings.wechatTokenPrevious],
  ] as const) {
    if (tok && signature) {
      const expected = createHash("sha1").update([tok, timestamp, nonce].sort().join(""), "utf8").digest("hex");
      if (safeEqual(expected, signature)) return label;
    }
  }
  return null;
}

function extractXmlTag(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${tag}>`, "i").exec(xml);
  return (m?.[1] ?? m?.[2] ?? "").trim();
}

function xmlReply(toUser: string, fromUser: string, content: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `<xml>\n  <ToUserName><![CDATA[${toUser}]]></ToUserName>\n  <FromUserName><![CDATA[${fromUser}]]></FromUserName>\n  <CreateTime>${now}</CreateTime>\n  <MsgType><![CDATA[text]]></MsgType>\n  <Content><![CDATA[${content}]]></Content>\n</xml>`;
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
    sso_enabled: oidcEnabled(settings),
    sso_name: settings.oidcDisplayName || "",
    password_login: settings.passwordLogin,
  });
});

authRoutes.post("/register", async (c) => {
  const { settings, db } = c.var.deps;
  const redis = c.var.deps.redis();
  const req = await jsonBody(c, ["email", "password"] as const, ["name", "invite_code"] as const);
  const ipKey = `register:ip:${requestIp(c) || "unknown"}`;
  await rateLimit.check(redis, ipKey, REGISTER_MAX_PER_IP);
  await rateLimit.hit(redis, ipKey, REGISTER_WINDOW);

  const [dup] = await db.select({ id: users.id }).from(users).where(eq(users.email, req.email)).limit(1);
  if (dup) throw new HttpError(400, "Email already registered");

  const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
  const isFirst = !anyUser;

  let invite: typeof inviteCodes.$inferSelect | null = null;
  if (req.invite_code) {
    const [inv] = await db.select().from(inviteCodes).where(eq(inviteCodes.code, req.invite_code)).limit(1);
    if (!inv) throw new HttpError(400, "Invalid invite code");
    if (inv.expiresAt && Date.parse(pgToIso(inv.expiresAt) ?? inv.expiresAt) < Date.now()) {
      throw new HttpError(400, "Invite code expired");
    }
    if (inv.useCount >= inv.maxUses) throw new HttpError(400, "Invite code already used up");
    invite = inv;
  }

  if (!isFirst && !settings.passwordLogin) throw new HttpError(403, "请使用企业账号登录");
  if (!isFirst && !invite) {
    if (settings.registrationMode === "closed") throw new HttpError(403, "Registration is closed");
    if (settings.registrationMode === "invite_only") throw new HttpError(403, "invite_code is required");
  }

  let role = "viewer";
  if (isFirst) role = "owner";
  else if (invite) role = invite.roleOnAccept === "admin" || invite.roleOnAccept === "viewer" ? invite.roleOnAccept : "viewer";

  const [created] = await db
    .insert(users)
    .values(
      withoutNul({
        id: randomUUID(),
        email: req.email,
        name: req.name ?? null,
        hashedPassword: hashPassword(req.password),
        role,
        status: "active",
        collectorToken: randomBytes(32).toString("hex"),
      }),
    )
    .returning();

  if (invite) {
    await db.update(inviteCodes).set({ useCount: invite.useCount + 1 }).where(eq(inviteCodes.id, invite.id));
  }
  return c.json(userResponse(created!));
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
  if (!user && safeEqual(given, settings.collectorToken)) {
    [user] = await db.select().from(users).where(and(eq(users.role, "owner"), eq(users.status, "active"))).limit(1);
  }
  if (!user || user.status !== "active") {
    await rateLimit.hit(redis, ipKey, TOKEN_EXCHANGE_WINDOW);
    throw new HttpError(401, "Invalid collector token");
  }
  const token = await createAccessToken(user.id, user.role, settings.secretKey, settings.accessTokenExpireMinutes, settings.algorithm);
  return c.json({ access_token: token, token_type: "bearer", user_id: user.id, role: user.role });
});

// ---- One-Time QR Pairing (Desktop standalone <-> Mobile App) ----
authRoutes.post("/pair/create", async (c) => {
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  const user = await currentUser(c);
  if (user.status !== "active") throw new HttpError(403, "Account not active");
  const code = randomBytes(24).toString("base64url");
  await storePairCode(c, code, {
    user_id: user.id,
    role: user.role,
    expires_at: Date.now() + PAIR_CODE_TTL_SECONDS * 1000,
  });
  return c.json({ code, expires_in: PAIR_CODE_TTL_SECONDS });
});

authRoutes.post("/pair/claim", async (c) => {
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  const { settings, db } = c.var.deps;
  const redis = c.var.deps.redis();
  const ipKey = `pair_claim:ip:${requestIp(c) || "unknown"}`;
  await rateLimit.check(redis, ipKey, PAIR_CLAIM_MAX_PER_IP);

  const req = await jsonBody(c, ["code"] as const);
  const code = req.code.trim();
  if (!code || code.length < 16 || code.length > 128) {
    await rateLimit.hit(redis, ipKey, PAIR_CLAIM_WINDOW);
    throw new HttpError(401, "配对码无效或已过期");
  }

  const rec = await consumePairCode(c, code);
  if (!rec) {
    await rateLimit.hit(redis, ipKey, PAIR_CLAIM_WINDOW);
    throw new HttpError(401, "配对码无效或已过期，请在桌面端刷新二维码后重试");
  }

  const [user] = await db.select().from(users).where(eq(users.id, rec.user_id)).limit(1);
  if (!user || user.status !== "active") {
    throw new HttpError(403, "Account not active");
  }

  await record(db, user, "auth.pair_claim", auditRequest(c));
  const token = await createAccessToken(user.id, user.role, settings.secretKey, settings.accessTokenExpireMinutes, settings.algorithm);
  return c.json({
    access_token: token,
    token_type: "bearer",
    user_id: user.id,
    role: user.role,
    user: userResponse(user),
  });
});

// ---- GitHub OAuth ----
authRoutes.get("/github/authorize", (c) => {
  const { settings } = c.var.deps;
  if (!settings.githubClientId) throw new HttpError(404, "GitHub OAuth not configured");
  const params = new URLSearchParams({
    client_id: settings.githubClientId,
    redirect_uri: githubRedirectUri(c, settings),
    scope: "read:user user:email",
    state: makeGhState(settings.secretKey, sanitizeNext(c.req.query("next"))),
  });
  return c.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`, 302);
});

authRoutes.get("/github/callback", async (c) => {
  const { db, settings } = c.var.deps;
  const frontend = settings.publicUrl ? settings.publicUrl.replace(/\/+$/, "") : "";
  const fail = (errCode: string) => c.redirect(`${frontend}/auth/login?error=${errCode}`, 302);

  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  const nextPath = verifyGhState(settings.secretKey, state);
  if (nextPath === null || !code) return fail("github_oauth_failed");

  let ghUser: Record<string, unknown>;
  let verifiedEmail: string | null = null;
  try {
    const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: settings.githubClientId,
        client_secret: settings.githubClientSecret,
        code,
        redirect_uri: githubRedirectUri(c, settings),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenResp.ok) return fail("github_oauth_failed");
    const ghToken = ((await tokenResp.json()) as { access_token?: string }).access_token;
    if (!ghToken) return fail("github_oauth_failed");

    const ghHeaders = { authorization: `Bearer ${ghToken}`, accept: "application/vnd.github+json" };
    const uResp = await fetch("https://api.github.com/user", { headers: ghHeaders, signal: AbortSignal.timeout(15_000) });
    if (!uResp.ok) return fail("github_oauth_failed");
    ghUser = (await uResp.json()) as Record<string, unknown>;

    const eResp = await fetch("https://api.github.com/user/emails", { headers: ghHeaders, signal: AbortSignal.timeout(15_000) });
    if (eResp.ok) {
      const emails = (await eResp.json()) as { email?: string; primary?: boolean; verified?: boolean }[];
      const chosen = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
      if (chosen?.email) verifiedEmail = chosen.email;
    }
  } catch {
    return fail("github_oauth_failed");
  }

  if (!ghUser.id) return fail("github_oauth_failed");
  const ghId = String(ghUser.id);
  const email = verifiedEmail || String(ghUser.email ?? "").trim() || null;
  if (!email) return fail("github_oauth_failed");

  let [user] = await db.select().from(users).where(eq(users.githubId, ghId)).limit(1);
  if (!user && verifiedEmail) {
    const [byEmail] = await db.select().from(users).where(eq(users.email, verifiedEmail)).limit(1);
    if (byEmail) {
      const [upd] = await db.update(users).set({ githubId: ghId }).where(eq(users.id, byEmail.id)).returning();
      user = upd ?? byEmail;
    }
  }
  if (!user) {
    const [dup] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (dup) return fail("github_oauth_failed");
    const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
    const isFirst = !anyUser;
    if (!isFirst && settings.registrationMode !== "open") return fail("registration_closed");
    if (!isFirst && !settings.passwordLogin) return fail("sso_required");
    const [created] = await db
      .insert(users)
      .values({
        id: randomUUID(),
        email,
        name: String(ghUser.name || ghUser.login || ""),
        avatarUrl: typeof ghUser.avatar_url === "string" ? ghUser.avatar_url : null,
        hashedPassword: null,
        role: isFirst ? "owner" : "viewer",
        status: "active",
        collectorToken: randomBytes(32).toString("hex"),
        githubId: ghId,
      })
      .returning();
    user = created!;
  }

  if (user.status !== "active") return fail("account_disabled");
  if (!settings.passwordLogin && user.role !== "owner") return fail("sso_required");

  await record(db, user, "auth.github.login", auditRequest(c));
  const token = await createAccessToken(user.id, user.role, settings.secretKey, settings.accessTokenExpireMinutes, settings.algorithm);
  return c.redirect(`${frontend}/auth/callback#token=${token}&next=${encodeURIComponent(nextPath)}`, 302);
});

// ---- Current user profile & avatar ----
authRoutes.get("/me", async (c) => c.json(userResponse(await currentUser(c))));

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

authRoutes.post("/me/avatar", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  if (user.status !== "active") throw new HttpError(403, "Account not active");
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new HttpError(422, [{ type: "missing", loc: ["body", "file"], msg: "Field required", input: null }]);

  const ct = (file.type || "").toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(ct)) {
    throw new HttpError(400, "Unsupported image format. Please upload JPG, PNG, WebP or GIF.");
  }
  const maxBytes = 2 * 1024 * 1024;
  if (file.size === 0) throw new HttpError(400, "Uploaded file is empty");
  if (file.size > maxBytes) throw new HttpError(400, "Avatar file size exceeds 2MB limit");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) throw new HttpError(400, "Uploaded file is empty");
  if (bytes.length > maxBytes) throw new HttpError(400, "Avatar file size exceeds 2MB limit");
  const realMime = detectAvatarMime(bytes);
  if (!realMime) throw new HttpError(400, "Invalid image signature. Please upload a valid JPG, PNG, WebP or GIF.");

  const dataUri = `data:${realMime};base64,${Buffer.from(bytes).toString("base64")}`;
  const [updated] = await db
    .update(users)
    .set({ avatarUrl: dataUri, updatedAt: sql`now()` as unknown as string })
    .where(eq(users.id, user.id))
    .returning();
  return c.json(userResponse(updated ?? user));
});

authRoutes.delete("/me/avatar", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  if (user.status !== "active") throw new HttpError(403, "Account not active");
  const [updated] = await db
    .update(users)
    .set({ avatarUrl: null, updatedAt: sql`now()` as unknown as string })
    .where(eq(users.id, user.id))
    .returning();
  return c.json(userResponse(updated ?? user));
});

authRoutes.post("/me/rotate-collector-token", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  if (user.status !== "active") throw new HttpError(403, "Account not active");
  const nextToken = randomBytes(32).toString("hex");
  const [updated] = await db
    .update(users)
    .set({ collectorToken: nextToken, updatedAt: sql`now()` as unknown as string })
    .where(eq(users.id, user.id))
    .returning();
  return c.json(userResponse(updated ?? user));
});

// ---- WeChat Official Account Webhook & QR Login ----
authRoutes.get("/wechat/webhook", (c) => {
  const signature = c.req.query("signature") ?? "";
  const timestamp = c.req.query("timestamp") ?? "";
  const nonce = c.req.query("nonce") ?? "";
  const echostr = c.req.query("echostr") ?? "";
  if (!signature || !echostr) return c.text("Memento WeChat Webhook is active.", 200);
  if (wechatTokenUsed(c.var.deps.settings, signature, timestamp, nonce)) return c.text(echostr, 200);
  return c.text("Invalid signature", 403);
});

authRoutes.post("/wechat/webhook", async (c) => {
  const signature = c.req.query("signature") ?? "";
  const timestamp = c.req.query("timestamp") ?? "";
  const nonce = c.req.query("nonce") ?? "";
  const used = wechatTokenUsed(c.var.deps.settings, signature, timestamp, nonce);
  if (!used || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > WECHAT_MAX_SKEW_SECONDS) {
    return c.text("forbidden", 403);
  }
  const xml = await c.req.text();
  if (!xml) return c.text("success", 200);

  try {
    const msgType = extractXmlTag(xml, "MsgType").toLowerCase();
    const fromUser = extractXmlTag(xml, "FromUserName");
    const toUser = extractXmlTag(xml, "ToUserName");
    if (msgType === "text") {
      const content = extractXmlTag(xml, "Content");
      if (/^\d{6}$/.test(content)) {
        const ticket = await getTicketData(c, content);
        if (ticket && ticket.status === "pending" && Date.now() / 1000 - (ticket.created_at || 0) <= 300) {
          ticket.status = "success";
          ticket.openid = fromUser;
          ticket.completed_at = Date.now() / 1000;
          await setTicketData(c, content, ticket, 300);
          return c.body(xmlReply(fromUser, toUser, "✅ 登录口令验证成功！请返回网页或桌面端，正在为您自动登录。"), 200, { "content-type": "application/xml" });
        }
        return c.body(xmlReply(fromUser, toUser, "⚠️ 口令已过期或不存在，请在屏幕上点击「刷新」获取新口令。"), 200, { "content-type": "application/xml" });
      }
      if (["登录", "登陆", "验证码", "login"].includes(content)) {
        return c.body(xmlReply(fromUser, toUser, "收到登录请求！请在 Memento 客户端点击「微信登录」，直接发送屏幕上显示的 6 位口令即可自动登录。"), 200, { "content-type": "application/xml" });
      }
      return c.body(xmlReply(fromUser, toUser, "收到您的消息！\n若需登录 Memento，请在网页/客户端点击「微信登录」并发送屏幕上显示的 6 位口令。"), 200, { "content-type": "application/xml" });
    }
    if (msgType === "event" && extractXmlTag(xml, "Event").toLowerCase() === "subscribe") {
      return c.body(xmlReply(fromUser, toUser, "欢迎关注！\n在登录 Memento 时，请直接发送登录屏幕上显示的 6 位数字口令即可自动登录。"), 200, { "content-type": "application/xml" });
    }
  } catch {
    /* fall through */
  }
  return c.text("success", 200);
});

authRoutes.get("/wechat/ticket", async (c) => {
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  cleanExpiredTickets();
  let code = "";
  for (let i = 0; i < 20; i++) {
    code = String(randomInt(100000, 1000000));
    if (!(await getTicketData(c, code))) break;
  }
  await setTicketData(c, code, { status: "pending", openid: null, created_at: Date.now() / 1000 }, 300);
  return c.json({ ticket: code, expires_in: 300 });
});

authRoutes.get("/wechat/poll", async (c) => {
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  const ticket = c.req.query("ticket");
  if (!ticket) throw new HttpError(422, [{ type: "missing", loc: ["query", "ticket"], msg: "Field required", input: null }]);
  const data = await getTicketData(c, ticket);
  if (!data) return c.json({ status: "not_found" });
  if (Date.now() / 1000 - (data.created_at || 0) > 300) return c.json({ status: "expired" });
  if (data.status !== "success" || !data.openid) return c.json({ status: "pending" });

  const { db, settings } = c.var.deps;
  const openid = data.openid;
  let [user] = await db.select().from(users).where(eq(users.wechatOpenid, openid)).limit(1);
  if (!user) {
    const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
    const isFirst = !anyUser;
    if (!isFirst && settings.registrationMode !== "open") {
      return c.json({ status: "registration_closed", detail: "系统注册已关闭" });
    }
    if (!isFirst && !settings.passwordLogin) {
      return c.json({ status: "sso_required", detail: "请使用企业账号登录" });
    }
    let email = `wx_${openid.slice(0, 10).toLowerCase()}@memento.local`;
    const [chk] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (chk) email = `wx_${openid.slice(0, 8).toLowerCase()}_${randomBytes(4).toString("hex")}@memento.local`;
    const [created] = await db
      .insert(users)
      .values({
        id: randomUUID(),
        email,
        name: `微信用户_${openid.slice(-4)}`,
        role: isFirst ? "owner" : "viewer",
        status: "active",
        collectorToken: randomBytes(32).toString("hex"),
        wechatOpenid: openid,
      })
      .returning();
    user = created!;
  }

  if (user.status !== "active") return c.json({ status: "account_disabled", detail: "账号已被停用" });
  if (!settings.passwordLogin && user.role !== "owner") return c.json({ status: "sso_required", detail: "请使用企业账号登录" });

  await deleteTicketData(c, ticket);
  const token = await createAccessToken(user.id, user.role, settings.secretKey, settings.accessTokenExpireMinutes, settings.algorithm);
  return c.json({ status: "success", access_token: token, user_id: user.id, role: user.role });
});
