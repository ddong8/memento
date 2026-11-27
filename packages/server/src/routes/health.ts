// /health (readiness, and the deploy job's version check) and /health/deep (database and Redis too).
import { sql } from "drizzle-orm";
import { Hono } from "hono";

import type { AppEnv } from "../context";

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get("/", async (c, next) => {
  if (c.var.deps.settings.webUpstream) return next();
  return c.json({ name: "Memento", version: "0.1.0", docs: "/docs" });
});

healthRoutes.get("/health", (c) => c.json({ status: "ok", version: c.var.deps.settings.buildSha }));

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("TimeoutError")), ms))]);

healthRoutes.get("/health/deep", async (c) => {
  const { db, settings } = c.var.deps;
  const checks: Record<string, string> = {};
  const probes: [string, () => Promise<unknown>][] = [["db", () => db.execute(sql`SELECT 1`)]];
  if (settings.redisUrl) {
    probes.push([
      "redis",
      async () => {
        const r = c.var.deps.redis();
        if (!r || (await r.ping()) !== "PONG") throw new Error("RuntimeError");
      },
    ]);
  } else {
    checks.redis = "local";
  }
  if (settings.webUpstream) {
    probes.push([
      "web",
      async () => {
        const r = await fetch(`${settings.webUpstream}/`, { method: "HEAD", redirect: "manual" });
        if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
      },
    ]);
  }
  for (const [name, probe] of probes) {
    try {
      await within(probe(), 5000);
      checks[name] = "ok";
    } catch (e) {
      checks[name] = `error: ${e instanceof Error ? e.message || e.name : "Error"}`;
    }
  }
  const ok = Object.values(checks).every((v) => v === "ok" || v === "local");
  return c.json({ status: ok ? "ok" : "degraded", version: settings.buildSha, ...checks }, ok ? 200 : 503);
});
