// /api/notify: push settings, device tokens, live activity tokens, feed & test push (server/server/api/notify.py).
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser, type UserRow } from "../auth/current-user";
import type { AppEnv } from "../context";
import { withoutNul } from "../db/client";
import { users } from "../db/pulled/schema";
import { HttpError, parseJsonObject } from "../http";
import { maskPushUrl, notifyUser, parsePushUrl, sendApnsLiveActivity } from "../services/notify";

export const notifyRoutes = new Hono<AppEnv>();

function prefsOf(user: UserRow): Record<string, unknown> {
  return user.notifySettings && typeof user.notifySettings === "object" && !Array.isArray(user.notifySettings)
    ? { ...(user.notifySettings as Record<string, unknown>) }
    : {};
}

function settingsOut(prefs: Record<string, unknown>) {
  const tokens = Array.isArray(prefs.device_tokens) ? prefs.device_tokens : [];
  const barkUrl = typeof prefs.bark_url === "string" ? prefs.bark_url : null;
  return {
    bark_configured: Boolean(barkUrl),
    bark_masked: maskPushUrl(barkUrl),
    device_tokens_count: tokens.length,
    native_configured: tokens.length > 0,
    notify_risky: prefs.notify_risky ?? true,
    notify_task_done: prefs.notify_task_done ?? true,
    notify_health: prefs.notify_health ?? true,
    notify_learning: prefs.notify_learning ?? true,
    notify_todo: prefs.notify_todo ?? true,
  };
}

notifyRoutes.get("/settings", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const prefs = prefsOf(user);
  const ua = c.req.header("user-agent") ?? "";
  if (ua.includes("MementoMobile")) {
    const tokens = Array.isArray(prefs.device_tokens) ? [...(prefs.device_tokens as string[])] : [];
    if (!tokens.length) {
      tokens.push("ios_memento_mobile_device");
      prefs.device_tokens = tokens;
      await db.update(users).set({ notifySettings: withoutNul(prefs) }).where(eq(users.id, user.id));
    }
  }
  return c.json(settingsOut(prefs));
});

notifyRoutes.put("/settings", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const prefs = prefsOf(user);

  if ("bark_url" in body && body.bark_url !== null && body.bark_url !== undefined) {
    if (typeof body.bark_url !== "string") {
      throw new HttpError(422, [{ type: "string_type", loc: ["body", "bark_url"], msg: "Input should be a valid string", input: body.bark_url }]);
    }
    const raw = body.bark_url.trim();
    if (!raw) delete prefs.bark_url;
    else if (!parsePushUrl(raw)) {
      throw new HttpError(400, "不是有效的推送地址。iOS 请使用 https://api.day.app/Key，Android 请使用 https://ntfy.sh/Topic");
    } else prefs.bark_url = raw;
  }

  for (const key of ["notify_risky", "notify_task_done", "notify_health", "notify_learning", "notify_todo"] as const) {
    if (key in body && body[key] !== null && body[key] !== undefined) {
      if (typeof body[key] !== "boolean") {
        throw new HttpError(422, [{ type: "bool_parsing", loc: ["body", key], msg: "Input should be a valid boolean", input: body[key] }]);
      }
      prefs[key] = body[key];
    }
  }

  await db.update(users).set({ notifySettings: withoutNul(prefs) }).where(eq(users.id, user.id));
  return c.json(settingsOut(prefs));
});

notifyRoutes.post("/device-token", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  if (typeof body.token !== "string") {
    throw new HttpError(422, [{ type: "missing" in body ? "string_type" : "missing", loc: ["body", "token"], msg: "Field required", input: body }]);
  }
  const tok = body.token.trim();
  if (!tok) throw new HttpError(400, "Token cannot be empty");

  const prefs = prefsOf(user);
  let tokens = Array.isArray(prefs.device_tokens) ? [...(prefs.device_tokens as string[])] : [];
  const isReal = tok.startsWith("ExponentPushToken") || tok.startsWith("ExpoPushToken") || /^[0-9a-fA-F]{64}$/.test(tok);
  if (isReal) {
    tokens = tokens.filter((t) => !t.startsWith("ios_") && !t.startsWith("memento_") && !t.startsWith("client_"));
  }
  if (!tokens.includes(tok)) tokens.push(tok);
  tokens = [...new Set(tokens)];
  prefs.device_tokens = tokens;
  await db.update(users).set({ notifySettings: withoutNul(prefs) }).where(eq(users.id, user.id));
  return c.json({ status: "ok", registered: true, device_tokens_count: tokens.length });
});

notifyRoutes.delete("/device-token", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  if (typeof body.token !== "string") {
    throw new HttpError(422, [{ type: "missing", loc: ["body", "token"], msg: "Field required", input: body }]);
  }
  const tok = body.token.trim();
  const prefs = prefsOf(user);
  const tokens = Array.isArray(prefs.device_tokens) ? [...(prefs.device_tokens as string[])] : [];
  const idx = tokens.indexOf(tok);
  if (idx >= 0) {
    tokens.splice(idx, 1);
    prefs.device_tokens = tokens;
    await db.update(users).set({ notifySettings: withoutNul(prefs) }).where(eq(users.id, user.id));
  }
  return c.json({ status: "ok", unregistered: true });
});

notifyRoutes.post("/live-activity-token", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const prefs = prefsOf(user);
  let changed = false;

  if (typeof body.push_to_start_token === "string" && body.push_to_start_token.trim()) {
    const pts = body.push_to_start_token.trim();
    const list = Array.isArray(prefs.live_activity_start_tokens) ? [...(prefs.live_activity_start_tokens as string[])] : [];
    if (!list.includes(pts)) {
      list.unshift(pts);
      prefs.live_activity_start_tokens = list.slice(0, 5);
      changed = true;
    }
  }
  if (typeof body.activity_push_token === "string" && typeof body.conversation_id === "string") {
    const actTok = body.activity_push_token.trim();
    const cid = body.conversation_id.trim();
    if (actTok && cid) {
      const actMap = { ...((prefs.live_activity_tokens as Record<string, string> | undefined) ?? {}) };
      actMap[cid] = actTok;
      const keys = Object.keys(actMap);
      if (keys.length > 20) for (const k of keys.slice(0, keys.length - 20)) delete actMap[k];
      prefs.live_activity_tokens = actMap;
      changed = true;
    }
  }
  if (changed) {
    await db.update(users).set({ notifySettings: withoutNul(prefs) }).where(eq(users.id, user.id));
  }
  return c.json({ status: "ok", registered: changed });
});

notifyRoutes.post("/live-activity/clear", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const prefs = prefsOf(user);
  const actMap = (prefs.live_activity_tokens as Record<string, string> | undefined) ?? {};
  const entries = Object.entries(actMap);
  if (entries.length) {
    for (const [, tok] of entries) {
      await sendApnsLiveActivity(
        settings,
        db,
        [tok],
        "end",
        { status: "done", currentStep: "已完成", stepCount: 1 },
        { dismissalDate: 0, priority: "10", userId: user.id },
      ).catch(() => {});
    }
    prefs.live_activity_tokens = {};
    await db.update(users).set({ notifySettings: withoutNul(prefs) }).where(eq(users.id, user.id));
  }
  return c.json({ status: "ok", cleared: entries.length });
});

notifyRoutes.get("/feed", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const since = c.req.query("since") || null;
  const prefs = prefsOf(user);
  const ua = c.req.header("user-agent") ?? "";
  if (ua.includes("MementoMobile")) {
    const tokens = Array.isArray(prefs.device_tokens) ? [...(prefs.device_tokens as string[])] : [];
    if (!tokens.length) {
      tokens.push("ios_memento_mobile_device");
      prefs.device_tokens = tokens;
      await db.update(users).set({ notifySettings: withoutNul(prefs) }).where(eq(users.id, user.id));
    }
  }
  let feed = Array.isArray(prefs.recent_notifications) ? [...(prefs.recent_notifications as Record<string, unknown>[])] : [];
  if (since) feed = feed.filter((n) => String(n.created_at ?? "") > since);
  return c.json(feed);
});

notifyRoutes.post("/test", async (c) => {
  const user = await currentUser(c);
  const ok = await notifyUser(
    c.var.deps,
    user.id,
    "todo",
    "🔔 Memento 本机与全终端原生测试通知",
    "恭喜！您的 Memento 桌面电脑与移动终端原生通知通道已完全通畅！",
    { url: "/profile?tab=account" },
  );
  return c.json({ ok });
});
