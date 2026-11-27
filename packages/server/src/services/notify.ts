// Phone push notifications: native APNs (HTTP/2 + Live Activity), Expo, Bark & ntfy (server/server/services/notify_service.py).
import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import * as http2 from "node:http2";
import { isIP } from "node:net";

import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { SignJWT } from "jose";

import type { Settings } from "../config";
import { withoutNul, type Db } from "../db/client";
import { users } from "../db/pulled/schema";
import { publishEvent } from "./sse";

const RISKY_PUSHES_PER_TASK = 5;
const RISKY_KEY = "risky-pushes:";
const DEDUP_WINDOW_SECONDS = 120;
const DEDUP_KEY = "push-dedup:";

const riskyPushCounts = new Map<string, number>();
const recentPushes = new Map<string, number>();
const apnsJwtCache = new Map<string, { token: string; exp: number }>();

export function parsePushUrl(raw: string | null | undefined): [string, string, string] | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (!parts.length) return null;
  const netloc = parsed.host;
  if (netloc.includes("api.day.app")) {
    if (parsed.protocol !== "https:") return null;
    return ["bark", `https://${netloc}`, parts[0]!];
  }
  if (netloc.includes("ntfy") || parts.length === 1) {
    return ["ntfy", `${parsed.protocol}//${netloc}/${parts[0]}`, parts[0]!];
  }
  return ["bark", `${parsed.protocol}//${netloc}`, parts[0]!];
}

export function maskPushUrl(raw: string | null | undefined): string | null {
  const res = parsePushUrl(raw);
  if (!res) return null;
  const [provider, target, key] = res;
  if (provider === "bark") return `${target}/${key.slice(0, 4)}…`;
  return `${target.slice(0, target.length - key.length)}${key.slice(0, 4)}…`;
}

function isPublicIp(raw: string): boolean {
  const ip = raw.split("%", 1)[0]!.toLowerCase();
  const ver = isIP(ip);
  if (ver === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    return true;
  }
  if (ver === 6) {
    if (ip === "::" || ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("ff")) return false;
    return true;
  }
  return false;
}

async function isPublicHost(host: string): Promise<boolean> {
  try {
    if (isIP(host)) return isPublicIp(host);
    const recs = await lookup(host, { all: true });
    return recs.length > 0 && recs.every((r) => isPublicIp(r.address));
  } catch {
    return false;
  }
}

export async function sendBark(
  pushUrl: string,
  title: string,
  body: string,
  opts: { url?: string | null; level?: string } = {},
): Promise<boolean> {
  const parsed = parsePushUrl(pushUrl);
  if (!parsed) return false;
  const [provider, target, key] = parsed;
  const host = new URL(target).hostname;
  if (!(await isPublicHost(host))) return false;
  const level = opts.level ?? "active";

  if (provider === "ntfy") {
    const headers: Record<string, string> = {
      Title: Buffer.from(title, "utf8").toString("latin1"),
      Priority: level === "timeSensitive" ? "urgent" : "default",
      Tags: "robot,memento",
    };
    if (opts.url) headers.Click = opts.url;
    try {
      const resp = await fetch(target, { method: "POST", body: Buffer.from(body, "utf8"), headers, signal: AbortSignal.timeout(10_000) });
      return resp.status === 200 || resp.status === 201;
    } catch {
      return false;
    }
  }

  const payload: Record<string, unknown> = { device_key: key, title, body, group: "Memento", level };
  if (opts.url) payload.url = opts.url;
  try {
    const resp = await fetch(`${target}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    return resp.status === 200;
  } catch {
    return false;
  }
}

async function getApnsJwt(settings: Settings): Promise<string | null> {
  const authKey = settings.apnsAuthKey;
  const keyId = settings.apnsKeyId;
  const teamId = settings.apnsTeamId;
  if (!authKey || !keyId || !teamId) return null;
  const now = Math.floor(Date.now() / 1000);
  const cached = apnsJwtCache.get(keyId);
  if (cached && now < cached.exp) return cached.token;
  let pem = authKey.trim();
  if (!pem.startsWith("-----BEGIN")) {
    try {
      pem = Buffer.from(pem, "base64").toString("utf8");
    } catch {
      /* keep raw */
    }
  }
  try {
    const keyObj = createPrivateKey(pem);
    const token = await new SignJWT({ iss: teamId, iat: now }).setProtectedHeader({ alg: "ES256", kid: keyId }).sign(keyObj);
    apnsJwtCache.set(keyId, { token, exp: now + 3000 });
    return token;
  } catch {
    return null;
  }
}

function http2PostJson(host: string, path: string, headers: Record<string, string>, body: unknown, timeoutMs = 8000): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}`);
    let done = false;
    const finish = (err: Error | null, res?: { status: number; text: string }) => {
      if (done) return;
      done = true;
      client.close();
      if (err) reject(err);
      else resolve(res!);
    };
    const timer = setTimeout(() => finish(new Error("APNs timeout")), timeoutMs);
    client.on("error", (e) => {
      clearTimeout(timer);
      finish(e);
    });
    const req = client.request({ ":method": "POST", ":path": path, "content-type": "application/json", ...headers });
    let status = 0;
    const chunks: Buffer[] = [];
    req.on("response", (h) => {
      status = Number(h[":status"] ?? 0);
    });
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      clearTimeout(timer);
      finish(null, { status, text: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      finish(e);
    });
    req.end(JSON.stringify(body));
  });
}

function filterApnsTokens(tokens: string[]): string[] {
  return [
    ...new Set(
      tokens
        .map((t) => t.trim())
        .filter(
          (t) =>
            Boolean(t) &&
            !t.startsWith("ExponentPushToken") &&
            !t.startsWith("ExpoPushToken") &&
            !t.startsWith("client_") &&
            !t.startsWith("memento_") &&
            !t.startsWith("ios_"),
        ),
    ),
  ];
}

export async function sendApnsPush(
  settings: Settings,
  tokens: string[],
  title: string,
  body: string,
  opts: { url?: string | null; level?: string } = {},
): Promise<boolean> {
  const apnsTokens = filterApnsTokens(tokens);
  if (!apnsTokens.length) return false;
  const jwt = await getApnsJwt(settings);
  if (!jwt) return false;

  const aps: Record<string, unknown> = {
    alert: { title, body },
    sound: "default",
    badge: 1,
    "mutable-content": 1,
    "content-available": 1,
  };
  if (opts.level === "timeSensitive") aps["interruption-level"] = "time-sensitive";
  const payload: Record<string, unknown> = { aps };
  if (opts.url) {
    payload.url = opts.url;
    payload.body = { url: opts.url };
    payload.data = { url: opts.url };
  }
  const headers = {
    authorization: `bearer ${jwt}`,
    "apns-topic": settings.apnsBundleId,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(Math.floor(Date.now() / 1000) + 86400 * 3),
  };
  const hosts = settings.apnsProduction
    ? ["api.push.apple.com", "api.sandbox.push.apple.com"]
    : ["api.sandbox.push.apple.com", "api.push.apple.com"];
  let delivered = 0;
  for (const tok of apnsTokens) {
    for (const host of hosts) {
      try {
        const res = await http2PostJson(host, `/3/device/${tok}`, headers, payload, 10_000);
        if (res.status === 200) {
          delivered++;
          break;
        }
        if (res.status === 400 && res.text.includes("BadDeviceToken")) continue;
      } catch {
        /* try fallback host */
      }
    }
  }
  return delivered > 0;
}

export async function sendApnsLiveActivity(
  settings: Settings,
  db: Db,
  tokens: string[],
  event: string,
  contentState: Record<string, unknown>,
  opts: {
    attributes?: Record<string, unknown>;
    alert?: Record<string, unknown>;
    dismissalDate?: number | null;
    priority?: string;
    userId?: string | null;
  } = {},
): Promise<boolean> {
  const jwt = await getApnsJwt(settings);
  if (!jwt) return false;
  const valid = [...new Set(tokens.map((t) => t.trim()).filter((t) => t.length >= 32 && /^[0-9a-fA-F]+$/.test(t)))];
  if (!valid.length) return false;

  const nowTs = Math.floor(Date.now() / 1000);
  const aps: Record<string, unknown> = { timestamp: nowTs, event, "content-state": contentState };
  if (event === "start" && opts.attributes) {
    aps["attributes-type"] = "MementoTaskAttributes";
    aps.attributes = opts.attributes;
  }
  if (opts.alert) aps.alert = opts.alert;
  if (opts.dismissalDate != null) aps["dismissal-date"] = opts.dismissalDate;

  const headers = {
    authorization: `bearer ${jwt}`,
    "apns-topic": `${settings.apnsBundleId}.push-type.liveactivity`,
    "apns-push-type": "liveactivity",
    "apns-priority": opts.priority ?? "10",
    "apns-expiration": String(nowTs + 3600),
  };
  const hosts = settings.apnsProduction
    ? ["api.push.apple.com", "api.sandbox.push.apple.com"]
    : ["api.sandbox.push.apple.com", "api.push.apple.com"];
  let delivered = 0;
  const dead = new Set<string>();
  for (const tok of valid) {
    for (const host of hosts) {
      try {
        const res = await http2PostJson(host, `/3/device/${tok}`, headers, { aps }, 8000);
        if (res.status === 200) {
          delivered++;
          break;
        }
        if (res.status === 410 || (res.status === 400 && res.text.includes("BadDeviceToken"))) {
          dead.add(tok);
          continue;
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (dead.size && opts.userId) {
    void pruneDeadTokens(db, opts.userId, dead);
  }
  return delivered > 0;
}

async function pruneDeadTokens(db: Db, userId: string, dead: Set<string>) {
  try {
    const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u || !u.notifySettings || typeof u.notifySettings !== "object") return;
    const prefs = { ...(u.notifySettings as Record<string, unknown>) };
    let changed = false;
    const actMap = { ...((prefs.live_activity_tokens as Record<string, string> | undefined) ?? {}) };
    for (const [cid, tok] of Object.entries(actMap)) {
      if (dead.has(tok)) {
        delete actMap[cid];
        changed = true;
      }
    }
    prefs.live_activity_tokens = actMap;
    const startList = Array.isArray(prefs.live_activity_start_tokens) ? (prefs.live_activity_start_tokens as string[]) : [];
    const nextStart = startList.filter((t) => !dead.has(t));
    if (nextStart.length !== startList.length) {
      prefs.live_activity_start_tokens = nextStart;
      changed = true;
    }
    if (changed) {
      await db.update(users).set({ notifySettings: withoutNul(prefs) }).where(eq(users.id, userId));
    }
  } catch {
    /* ignore */
  }
}

/** R-ISLAND-CLEANUP: never let non-terminal Live Activity steps contain completion trigger words. */
export function sanitizeLiveActivityStep(step: string, status = "running", event = "update"): string {
  let text = (step || "").replace(/[\r\n]/g, " ").trim();
  if (event !== "end" && !["done", "error", "cancelled"].includes(status)) {
    text = text.replaceAll("已完成", "已就绪").replaceAll("完成", "就绪").replaceAll("已结束", "收尾中").replaceAll("已停止", "暂停中");
  }
  return [...text].slice(0, 90).join("");
}

export async function sendExpoPush(
  tokens: string[],
  title: string,
  body: string,
  opts: { url?: string | null; level?: string } = {},
): Promise<boolean> {
  const messages = tokens
    .filter((t) => t.startsWith("ExponentPushToken") || t.startsWith("ExpoPushToken"))
    .map((to) => ({
      to,
      title,
      body,
      sound: "default",
      priority: opts.level === "timeSensitive" ? "high" : "default",
      data: opts.url ? { url: opts.url } : {},
      _displayInForeground: true,
    }));
  if (!messages.length) return false;
  try {
    const resp = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(10_000),
    });
    return resp.status === 200;
  } catch {
    return false;
  }
}

function extractCoreBody(body: string): string {
  let core = (body || "").trim();
  const colon = core.indexOf("：");
  if (colon >= 0) core = core.slice(colon + 1).trim();
  const paren = core.indexOf("（期间 ");
  if (paren >= 0) core = core.slice(0, paren).trim();
  return core;
}

async function isDuplicatePush(redis: Redis | null, userId: string, title: string, body: string): Promise<boolean> {
  const cleanTitle = (title || "").trim();
  const cleanBody = (body || "").trim();
  const key = `${userId}:${cleanTitle}:${cleanBody}`;
  const coreBody = extractCoreBody(cleanBody);
  const coreKey = coreBody ? `${userId}:${cleanTitle}:${coreBody}` : key;

  if (redis) {
    try {
      const digest = createHash("sha1").update(coreKey, "utf8").digest("hex");
      const ok = await redis.set(DEDUP_KEY + digest, "1", "EX", DEDUP_WINDOW_SECONDS, "NX");
      return !ok;
    } catch {
      /* fallback */
    }
  }
  const now = Date.now() / 1000;
  for (const [k, ts] of recentPushes) if (now - ts > DEDUP_WINDOW_SECONDS * 2) recentPushes.delete(k);
  const last = recentPushes.get(key);
  if (last !== undefined && now - last < DEDUP_WINDOW_SECONDS) return true;
  const coreLast = recentPushes.get(coreKey);
  if (coreLast !== undefined && now - coreLast < DEDUP_WINDOW_SECONDS) return true;
  recentPushes.set(key, now);
  recentPushes.set(coreKey, now);
  return false;
}

export async function notifyUser(
  deps: { db: Db; settings: Settings; redis: () => Redis | null },
  userId: string | null | undefined,
  kind: string,
  title: string,
  body: string,
  opts: { url?: string | null } = {},
): Promise<boolean> {
  if (!userId) return false;
  const redis = deps.redis();
  if (await isDuplicatePush(redis, userId, title, body)) return true;
  const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
  const prefs = (user?.notifySettings && typeof user.notifySettings === "object" ? user.notifySettings : {}) as Record<string, unknown>;
  const toggleMap: Record<string, string> = {
    risky: "notify_risky",
    health: "notify_health",
    learning: "notify_learning",
    todo: "notify_todo",
  };
  const toggleKey = toggleMap[kind] ?? "notify_task_done";
  if (prefs[toggleKey] === false) return false;
  const level = kind === "risky" ? "timeSensitive" : "active";

  const item = {
    id: randomUUID(),
    kind,
    title,
    body,
    url: opts.url ?? null,
    created_at: new Date().toISOString().replace("Z", "+00:00"),
  };
  if (user) {
    const nextPrefs = { ...prefs };
    const feed = Array.isArray(nextPrefs.recent_notifications) ? [...(nextPrefs.recent_notifications as unknown[])] : [];
    feed.unshift(item);
    nextPrefs.recent_notifications = feed.slice(0, 30);
    await deps.db.update(users).set({ notifySettings: withoutNul(nextPrefs) }).where(eq(users.id, userId)).catch(() => {});
  }
  publishEvent("notification", item, userId);

  const deviceTokens = Array.isArray(prefs.device_tokens) ? (prefs.device_tokens as string[]) : [];
  if (deviceTokens.length) {
    const apnsTokens = filterApnsTokens(deviceTokens);
    const expoTokens = [...new Set(deviceTokens.map((t) => t.trim()).filter((t) => t.startsWith("ExponentPushToken") || t.startsWith("ExpoPushToken")))];
    if (apnsTokens.length) await sendApnsPush(deps.settings, apnsTokens, title, body, { url: opts.url, level });
    else if (expoTokens.length) await sendExpoPush(expoTokens, title, body, { url: opts.url, level });
  }
  if (typeof prefs.bark_url === "string" && prefs.bark_url) {
    await sendBark(prefs.bark_url, title, body, { url: opts.url, level });
  }
  return true;
}

export async function allowRiskyPush(redis: Redis | null, taskId: string): Promise<boolean> {
  if (redis) {
    try {
      const pipe = redis.pipeline();
      pipe.incr(RISKY_KEY + taskId);
      pipe.expire(RISKY_KEY + taskId, 86400);
      const res = await pipe.exec();
      const count = Number(res?.[0]?.[1] ?? 0);
      return count <= RISKY_PUSHES_PER_TASK;
    } catch {
      /* fallback */
    }
  }
  const c = riskyPushCounts.get(taskId) ?? 0;
  if (c >= RISKY_PUSHES_PER_TASK) return false;
  riskyPushCounts.set(taskId, c + 1);
  return true;
}

export function taskLink(settings: Settings, taskId: string): string {
  const base = (settings.publicUrl || "").replace(/\/+$/, "");
  return base ? `${base}/tasks/${taskId}` : `/tasks/${taskId}`;
}

export async function forgetTask(redis: Redis | null, taskId: string): Promise<void> {
  riskyPushCounts.delete(taskId);
  if (redis) await redis.del(RISKY_KEY + taskId).catch(() => {});
}
