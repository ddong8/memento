// /api/auth/oidc: OpenID Connect SSO with PKCE (server/server/api/sso.py).
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

import { record as recordAudit } from "../audit";
import type { UserRow } from "../auth/current-user";
import { createAccessToken } from "../auth/jwt";
import type { Settings } from "../config";
import { auditRequest, type AppEnv } from "../context";
import type { Db } from "../db/client";
import { users } from "../db/pulled/schema";
import { HttpError } from "../http";

const STATE_TTL = 600;
const DISCOVERY_TTL = 3600;
const oidcCache = new Map<string, [number, Record<string, unknown>]>();

export function oidcEnabled(settings: Pick<Settings, "oidcIssuer" | "oidcClientId" | "oidcClientSecret">): boolean {
  return Boolean(settings.oidcIssuer && settings.oidcClientId && settings.oidcClientSecret);
}

function issuerOf(settings: Settings): string {
  return settings.oidcIssuer.replace(/\/+$/, "");
}

function frontendBase(settings: Settings): string {
  return settings.publicUrl ? settings.publicUrl.replace(/\/+$/, "") : "";
}

function redirectUri(c: Context<AppEnv>, settings: Settings): string {
  if (settings.publicUrl) return `${settings.publicUrl.replace(/\/+$/, "")}/api/auth/oidc/callback`;
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() || c.req.header("host") || url.host;
  return `${proto}://${host}/api/auth/oidc/callback`;
}

async function fetchJsonCached(url: string, key: string): Promise<Record<string, unknown>> {
  const hit = oidcCache.get(key);
  const now = Date.now() / 1000;
  if (hit && now - hit[0] < DISCOVERY_TTL) return hit[1];
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json()) as Record<string, unknown>;
  oidcCache.set(key, [now, data]);
  return data;
}

function signData(secretKey: string, data: string): string {
  return createHmac("sha256", secretKey).update(`oidc:${data}`).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function makeState(secretKey: string, nextPath: string): string {
  const payload = b64url(Buffer.from(JSON.stringify({ n: randomBytes(16).toString("hex"), t: Math.floor(Date.now() / 1000), next: nextPath })));
  return `${payload}.${signData(secretKey, payload)}`;
}

export function readState(secretKey: string, state: string): { n: string; t: number; next: string } | null {
  try {
    const dot = state.indexOf(".");
    if (dot < 0) return null;
    const payload = state.slice(0, dot);
    const sig = state.slice(dot + 1);
    if (!safeEqual(sig, signData(secretKey, payload))) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { n: string; t: number; next?: string };
    if (Math.abs(Date.now() / 1000 - Number(data.t)) > STATE_TTL) return null;
    return { n: String(data.n), t: Number(data.t), next: String(data.next ?? "") };
  } catch {
    return null;
  }
}

function nonceOf(secretKey: string, n: string): string {
  return signData(secretKey, `nonce:${n}`).slice(0, 32);
}

function verifierOf(secretKey: string, n: string): string {
  return signData(secretKey, `pkce:${n}`);
}

function challengeOf(verifier: string): string {
  return b64url(createHash("sha256").update(verifier, "ascii").digest());
}

export function sanitizeNext(nextPath: string | null | undefined): string {
  if (nextPath && nextPath.startsWith("/") && !nextPath.startsWith("//") && !nextPath.startsWith("/\\")) return nextPath;
  return "";
}

function allowedDomains(settings: Settings): string[] {
  return (settings.oidcAllowedDomains || "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

export function domainAllowed(settings: Settings, email: string): boolean {
  const domains = allowedDomains(settings);
  return !domains.length || domains.includes(email.toLowerCase().split("@").pop() || "");
}

export function emailTrusted(settings: Settings, claims: Record<string, unknown>): boolean {
  const email = String(claims.email ?? "").toLowerCase();
  if (!email) return false;
  if (claims.email_verified === true || String(claims.email_verified ?? "").toLowerCase() === "true") return true;
  const domains = allowedDomains(settings);
  return domains.length > 0 && domains.includes(email.split("@").pop() || "");
}

export function roleFromGroups(settings: Settings, claims: Record<string, unknown>): string | null {
  const group = (settings.oidcAdminGroup || "").trim();
  if (!group) return null;
  const raw = claims.groups ?? claims.roles ?? [];
  const groups = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.map(String) : [];
  return groups.includes(group) ? "admin" : "viewer";
}

export async function resolveSsoUser(
  db: Db,
  settings: Settings,
  claims: Record<string, unknown>,
): Promise<[UserRow | null, string | null]> {
  if (!claims.sub) return [null, "sso_failed"];
  const subject = `${issuerOf(settings)}|${String(claims.sub)}`;
  const email = String(claims.email || claims.preferred_username || "").trim().toLowerCase();
  if (email && email.includes("@") && !domainAllowed(settings, email)) return [null, "sso_domain_not_allowed"];

  let [user] = await db.select().from(users).where(eq(users.oidcSubject, subject)).limit(1);
  if (!user && email && emailTrusted(settings, { ...claims, email })) {
    const [byEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (byEmail) {
      const [linked] = await db.update(users).set({ oidcSubject: subject }).where(eq(users.id, byEmail.id)).returning();
      user = linked ?? byEmail;
    }
  }
  if (!user) {
    if (!email || !email.includes("@")) return [null, "sso_no_email"];
    const [dup] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (dup) return [null, "sso_email_unverified"];
    if (!settings.oidcAutoCreate) return [null, "sso_no_account"];
    const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
    const first = !anyUser;
    const [created] = await db
      .insert(users)
      .values({
        id: randomUUID(),
        email,
        name: String(claims.name || claims.preferred_username || email.split("@")[0]),
        avatarUrl: typeof claims.picture === "string" ? claims.picture : null,
        hashedPassword: null,
        role: first ? "owner" : (roleFromGroups(settings, claims) ?? "viewer"),
        status: "active",
        collectorToken: randomBytes(32).toString("hex"),
        oidcSubject: subject,
      })
      .returning();
    return [created!, null];
  }

  if (user.status !== "active") return [null, "account_disabled"];
  const role = roleFromGroups(settings, claims);
  if (role && (user.role === "viewer" || user.role === "admin") && user.role !== role) {
    const [updated] = await db.update(users).set({ role }).where(eq(users.id, user.id)).returning();
    user = updated ?? user;
  }
  return [user, null];
}

async function exchangeCode(c: Context<AppEnv>, settings: Settings, code: string, n: string): Promise<Record<string, unknown>> {
  const meta = await fetchJsonCached(`${issuerOf(settings)}/.well-known/openid-configuration`, "discovery");
  const tokenEndpoint = String(meta.token_endpoint);
  const basicAuth = Buffer.from(`${settings.oidcClientId}:${settings.oidcClientSecret}`).toString("base64");
  const resp = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(c, settings),
      code_verifier: verifierOf(settings.secretKey, n),
      client_id: settings.oidcClientId,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`token exchange ${resp.status}`);
  const tokens = (await resp.json()) as { id_token?: string; access_token?: string };
  if (!tokens.id_token) throw new Error("no id_token");

  const jwksUri = String(meta.jwks_uri);
  const expectedIssuer = String(meta.issuer || issuerOf(settings));
  const verifyWithJwks = async (jwks: Record<string, unknown>) => {
    const localSet = createLocalJWKSet(jwks as unknown as JSONWebKeySet);
    const { payload } = await jwtVerify(tokens.id_token!, localSet, {
      audience: settings.oidcClientId,
      issuer: expectedIssuer,
    });
    return payload as Record<string, unknown>;
  };

  let claims: Record<string, unknown>;
  try {
    claims = await verifyWithJwks(await fetchJsonCached(jwksUri, "jwks"));
  } catch {
    oidcCache.delete("jwks");
    claims = await verifyWithJwks(await fetchJsonCached(jwksUri, "jwks"));
  }
  if (claims.nonce !== nonceOf(settings.secretKey, n)) throw new Error("nonce mismatch");

  if ((!claims.email || (settings.oidcAdminGroup && !("groups" in claims))) && meta.userinfo_endpoint && tokens.access_token) {
    const ui = await fetch(String(meta.userinfo_endpoint), {
      headers: { authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (ui.ok) {
      const info = (await ui.json()) as Record<string, unknown>;
      if (info.sub === claims.sub) {
        const merged: Record<string, unknown> = { ...info };
        for (const [k, v] of Object.entries(claims)) if (v !== null && v !== undefined && v !== "") merged[k] = v;
        claims = merged;
      }
    }
  }
  return claims;
}

export const ssoRoutes = new Hono<AppEnv>();

ssoRoutes.get("/authorize", async (c) => {
  const { settings } = c.var.deps;
  if (!oidcEnabled(settings)) throw new HttpError(404, "SSO not configured");
  let meta: Record<string, unknown>;
  try {
    meta = await fetchJsonCached(`${issuerOf(settings)}/.well-known/openid-configuration`, "discovery");
  } catch {
    return c.redirect(`${frontendBase(settings)}/auth/login?error=sso_failed`, 302);
  }
  const state = makeState(settings.secretKey, sanitizeNext(c.req.query("next")));
  const parsed = readState(settings.secretKey, state)!;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: settings.oidcClientId,
    redirect_uri: redirectUri(c, settings),
    scope: settings.oidcScopes || "openid email profile",
    state,
    nonce: nonceOf(settings.secretKey, parsed.n),
    code_challenge: challengeOf(verifierOf(settings.secretKey, parsed.n)),
    code_challenge_method: "S256",
  });
  return c.redirect(`${String(meta.authorization_endpoint)}?${params.toString()}`, 302);
});

ssoRoutes.get("/callback", async (c) => {
  const { db, settings } = c.var.deps;
  const fail = (code: string) => c.redirect(`${frontendBase(settings)}/auth/login?error=${code}`, 302);
  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  const error = c.req.query("error") ?? "";
  const data = state ? readState(settings.secretKey, state) : null;
  if (error || !data || !code || !oidcEnabled(settings)) return fail("sso_failed");

  let claims: Record<string, unknown>;
  try {
    claims = await exchangeCode(c, settings, code, data.n);
  } catch {
    return fail("sso_failed");
  }

  const [user, err] = await resolveSsoUser(db, settings, claims);
  if (!user) {
    await recordAudit(db, null, "auth.sso.denied", auditRequest(c), {
      detail: { reason: err, email: claims.email, sub: claims.sub },
    });
    return fail(err || "sso_failed");
  }
  await recordAudit(db, user, "auth.sso.login", auditRequest(c));
  const token = await createAccessToken(user.id, user.role, settings.secretKey, settings.accessTokenExpireMinutes, settings.algorithm);
  const nextPath = sanitizeNext(data.next);
  return c.redirect(`${frontendBase(settings)}/auth/callback#token=${token}&next=${encodeURIComponent(nextPath)}`, 302);
});
