// /api/proactive: proactive agent settings & test brief/reflection endpoints (server/server/api/proactive.py).
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser } from "../auth/current-user";
import type { AppEnv } from "../context";
import { withoutNul } from "../db/client";
import { users } from "../db/pulled/schema";
import { parseJsonObject } from "../http";
import { DEFAULT_PROACTIVE_SETTINGS, getProactiveSettings, sendEveningReflection, sendMorningBrief } from "../services/pulse";

export const proactiveRoutes = new Hono<AppEnv>();

proactiveRoutes.get("/settings", async (c) => {
  const user = await currentUser(c);
  return c.json(getProactiveSettings(user));
});

proactiveRoutes.put("/settings", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const merged: Record<string, unknown> = {
    ...getProactiveSettings(user),
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : DEFAULT_PROACTIVE_SETTINGS.enabled,
    morning_brief_enabled:
      body.morning_brief_enabled !== undefined ? Boolean(body.morning_brief_enabled) : DEFAULT_PROACTIVE_SETTINGS.morning_brief_enabled,
    morning_brief_time:
      body.morning_brief_time !== undefined ? String(body.morning_brief_time) : DEFAULT_PROACTIVE_SETTINGS.morning_brief_time,
    evening_reflection_enabled:
      body.evening_reflection_enabled !== undefined
        ? Boolean(body.evening_reflection_enabled)
        : DEFAULT_PROACTIVE_SETTINGS.evening_reflection_enabled,
    evening_reflection_time:
      body.evening_reflection_time !== undefined ? String(body.evening_reflection_time) : DEFAULT_PROACTIVE_SETTINGS.evening_reflection_time,
    device_alert_enabled:
      body.device_alert_enabled !== undefined ? Boolean(body.device_alert_enabled) : DEFAULT_PROACTIVE_SETTINGS.device_alert_enabled,
    quiet_hours_start:
      body.quiet_hours_start !== undefined ? String(body.quiet_hours_start) : DEFAULT_PROACTIVE_SETTINGS.quiet_hours_start,
    quiet_hours_end:
      body.quiet_hours_end !== undefined ? String(body.quiet_hours_end) : DEFAULT_PROACTIVE_SETTINGS.quiet_hours_end,
    timezone_offset_hours:
      body.timezone_offset_hours !== undefined ? Number(body.timezone_offset_hours) : DEFAULT_PROACTIVE_SETTINGS.timezone_offset_hours,
    auto_approve_safe:
      body.auto_approve_safe !== undefined ? Boolean(body.auto_approve_safe) : DEFAULT_PROACTIVE_SETTINGS.auto_approve_safe,
  };
  await db.update(users).set({ proactiveSettings: withoutNul(merged) }).where(eq(users.id, user.id));
  return c.json({ status: "ok", settings: merged });
});

proactiveRoutes.post("/test-morning-brief", async (c) => {
  const user = await currentUser(c);
  const prefs = getProactiveSettings(user);
  const offsetHours = Number(prefs.timezone_offset_hours ?? 8);
  const userNow = new Date(Date.now() + offsetHours * 3600_000);
  void sendMorningBrief(c.var.deps, user, userNow).catch(() => {});
  return c.json({ status: "ok", message: "Morning brief triggered" });
});

proactiveRoutes.post("/test-evening-reflection", async (c) => {
  const user = await currentUser(c);
  const prefs = getProactiveSettings(user);
  const offsetHours = Number(prefs.timezone_offset_hours ?? 8);
  const userNow = new Date(Date.now() + offsetHours * 3600_000);
  const body = await sendEveningReflection(c.var.deps, user, userNow);
  return c.json({
    status: body ? "ok" : "empty",
    message: body || "今天还没有会话、新记忆、纠正或待办，没有可推送的内容。",
  });
});
