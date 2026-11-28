// System health overview route (/api/health/overview) (server/server/api/health.py).
import { Hono } from "hono";

import { currentUser } from "../auth/current-user";
import type { AppEnv } from "../context";
import { buildOverview } from "../services/health-service";

export const healthOverviewRoutes = new Hono<AppEnv>();

healthOverviewRoutes.get("/overview", async (c) => {
  const { db, redis, settings } = c.var.deps;
  const user = await currentUser(c);
  return c.json(await buildOverview(db, redis(), user, settings));
});
