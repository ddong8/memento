// /api/plugins: plugin marketplace catalog, install/uninstall, sealed config & health test (server/server/api/plugins.py).
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser } from "../auth/current-user";
import type { AppEnv } from "../context";
import { withoutNul } from "../db/client";
import { users } from "../db/pulled/schema";
import { HttpError, parseJsonObject, parseOptionalJsonObject } from "../http";
import {
  CATALOG_BY_ID,
  getUserPluginsPayload,
  isPluginConfigured,
  nowIso,
  sanitizeAndSealConfig,
  serverHasStudioEngine,
} from "../services/plugins";
import { reveal } from "../services/secret-box";

export const pluginRoutes = new Hono<AppEnv>();

function ensurePluginExists(pluginId: string) {
  const spec = CATALOG_BY_ID[pluginId];
  if (!spec) throw new HttpError(404, `插件不存在: ${pluginId}`);
  return spec;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

pluginRoutes.get("/", async (c) => {
  const user = await currentUser(c);
  return c.json(getUserPluginsPayload(c.var.deps.settings, user));
});

pluginRoutes.post("/:pluginId/install", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const pluginId = c.req.param("pluginId");
  ensurePluginExists(pluginId);

  const req = (await parseOptionalJsonObject(c)) ?? {};
  const rawCfg = "config" in req && req.config !== undefined ? req.config : {};
  if (!rawCfg || typeof rawCfg !== "object" || Array.isArray(rawCfg)) {
    throw new HttpError(422, [{ type: "dict_type", loc: ["body", "config"], msg: "Input should be a valid dictionary", input: rawCfg }]);
  }
  const enabled = "enabled" in req && req.enabled !== undefined ? Boolean(req.enabled) : true;

  const allSettings = { ...asObj(user.pluginSettings) };
  const existing = { ...asObj(allSettings[pluginId]) };
  const prevCfg = asObj(existing.config);

  const incomingCfg = { ...(rawCfg as Record<string, unknown>) };
  if (pluginId === "studio" && !Object.keys(incomingCfg).length && !Object.keys(prevCfg).length && serverHasStudioEngine(settings)) {
    incomingCfg.use_server_default = true;
  }

  const sealedCfg = sanitizeAndSealConfig(settings, pluginId, incomingCfg, prevCfg);
  const ts = nowIso();
  allSettings[pluginId] = {
    installed: true,
    enabled,
    config: sealedCfg,
    installed_at: existing.installed_at || ts,
    updated_at: ts,
  };

  const [updated] = await db
    .update(users)
    .set({ pluginSettings: withoutNul(allSettings) })
    .where(eq(users.id, user.id))
    .returning();
  return c.json(getUserPluginsPayload(settings, updated ?? { ...user, pluginSettings: allSettings }));
});

pluginRoutes.patch("/:pluginId/config", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const pluginId = c.req.param("pluginId");
  ensurePluginExists(pluginId);

  const body = await parseJsonObject(c);
  const hasConfig = "config" in body && body.config !== null && body.config !== undefined;
  if (hasConfig && (typeof body.config !== "object" || Array.isArray(body.config))) {
    throw new HttpError(422, [{ type: "dict_type", loc: ["body", "config"], msg: "Input should be a valid dictionary", input: body.config }]);
  }

  const allSettings = { ...asObj(user.pluginSettings) };
  const existing = { ...asObj(allSettings[pluginId]) };
  if (!existing.installed) throw new HttpError(400, "请先安装该插件再进行配置");

  const prevCfg = asObj(existing.config);
  const nextCfg = hasConfig ? sanitizeAndSealConfig(settings, pluginId, body.config as Record<string, unknown>, prevCfg) : prevCfg;
  const nextEnabled = body.enabled === null || body.enabled === undefined ? Boolean(existing.enabled ?? true) : Boolean(body.enabled);

  allSettings[pluginId] = {
    ...existing,
    installed: true,
    enabled: nextEnabled,
    config: nextCfg,
    updated_at: nowIso(),
  };

  const [updated] = await db
    .update(users)
    .set({ pluginSettings: withoutNul(allSettings) })
    .where(eq(users.id, user.id))
    .returning();
  return c.json(getUserPluginsPayload(settings, updated ?? { ...user, pluginSettings: allSettings }));
});

pluginRoutes.post("/:pluginId/test", async (c) => {
  const { settings } = c.var.deps;
  const user = await currentUser(c);
  const pluginId = c.req.param("pluginId");
  ensurePluginExists(pluginId);

  const body = await parseOptionalJsonObject(c);
  const allSettings = asObj(user.pluginSettings);
  const existing = asObj(allSettings[pluginId]);
  const prevCfg = asObj(existing.config);
  const incoming = body && body.config !== null && body.config !== undefined ? asObj(body.config) : null;
  const merged = incoming ? sanitizeAndSealConfig(settings, pluginId, incoming, prevCfg) : prevCfg;

  if (!isPluginConfigured(settings, pluginId, merged)) {
    return c.json({ ok: false, latency_ms: 0, message: "请先填写必填的服务地址后再测试连接" });
  }

  const t0 = performance.now();
  if (pluginId === "studio") {
    let base: string;
    let token: string;
    if (merged.use_server_default && serverHasStudioEngine(settings)) {
      base = (settings.studioFilmkitUrl || "").trim().replace(/\/+$/, "");
      token = (settings.studioFilmkitToken || "").trim();
    } else {
      base = String(merged.filmkit_url ?? "").trim().replace(/\/+$/, "");
      token = typeof merged.filmkit_token === "string" && merged.filmkit_token ? reveal(merged.filmkit_token, settings) : "";
    }
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    try {
      const r = await fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(8000) });
      const ms = Math.floor(performance.now() - t0);
      if (r.status === 200) return c.json({ ok: true, latency_ms: ms, message: `演播台引擎连接正常 (${ms} ms)` });
      return c.json({ ok: false, latency_ms: ms, message: `演播台引擎返回 HTTP ${r.status}` });
    } catch (e) {
      const ms = Math.floor(performance.now() - t0);
      return c.json({ ok: false, latency_ms: ms, message: `无法连接演播台引擎: ${(e as Error).message || e}` });
    }
  }

  if (pluginId === "wechat_publish") {
    const base = String(merged.api_base_url ?? "").trim().replace(/\/+$/, "");
    const token = typeof merged.api_token === "string" && merged.api_token ? reveal(merged.api_token, settings) : "";
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    try {
      let r = await fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(8000) });
      if (r.status === 404) r = await fetch(`${base}/`, { headers, signal: AbortSignal.timeout(8000) });
      const ms = Math.floor(performance.now() - t0);
      if (r.status < 500) return c.json({ ok: true, latency_ms: ms, message: `公众号推送服务可达 (HTTP ${r.status}, ${ms} ms)` });
      return c.json({ ok: false, latency_ms: ms, message: `服务异常返回 HTTP ${r.status}` });
    } catch (e) {
      const ms = Math.floor(performance.now() - t0);
      return c.json({ ok: false, latency_ms: ms, message: `无法连接推送服务: ${(e as Error).message || e}` });
    }
  }

  return c.json({ ok: false, latency_ms: 0, message: "暂不支持测试该插件" });
});

pluginRoutes.delete("/:pluginId", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const pluginId = c.req.param("pluginId");
  ensurePluginExists(pluginId);

  const allSettings = { ...asObj(user.pluginSettings) };
  if (pluginId in allSettings) {
    delete allSettings[pluginId];
    const [updated] = await db
      .update(users)
      .set({ pluginSettings: withoutNul(allSettings) })
      .where(eq(users.id, user.id))
      .returning();
    return c.json(getUserPluginsPayload(settings, updated ?? { ...user, pluginSettings: allSettings }));
  }
  return c.json(getUserPluginsPayload(settings, user));
});
