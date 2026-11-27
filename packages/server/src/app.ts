// The Hono app: the routes moved over from server/ (Python) so far, behind the same middleware behavior
// (CORS by the configured origin regex, gzip, ETags on GET). Which paths it serves in production is decided
// by the entrance (deploy/k8s/ingress.yaml); everything else still goes to the Python server.
import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { etag } from "hono/etag";

import type { AppEnv, Deps } from "./context";
import { errorResponse, HttpError } from "./http";
import { authRoutes } from "./routes/auth";
import { dashboardRoutes } from "./routes/dashboard";
import { documentRoutes } from "./routes/documents";
import { healthRoutes } from "./routes/health";
import { hierarchyRoutes } from "./routes/hierarchy";
import { installRoutes } from "./routes/install";
import { mediaRoutes } from "./routes/media";
import { pluginRoutes } from "./routes/plugins";
import { skillRoutes } from "./routes/skills";
import { todoRoutes } from "./routes/todos";
import { publicRoutes, toolRoutes } from "./routes/tools";
import { updateRoutes } from "./routes/updates";

/** Paths this server answers, for the entrance and the contract check (scripts/contract.mts). */
export const MIGRATED_PATHS = [
  "/api/auth/login",
  "/api/auth/refresh",
  "/api/auth/token-exchange",
  "/api/auth/registration-mode",
  "/api/auth/me",
  "/api/todos",
  "/api/tools",
  "/api/public",
  "/api/dashboard",
  "/api/hierarchy",
  "/api/documents",
  "/api/media",
  "/api/skills",
  "/api/plugins",
  "/api/system/update",
  "/install",
] as const;

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  let originRe: RegExp;
  try {
    originRe = new RegExp(`^(?:${deps.settings.corsAllowOriginRegex})$`);
  } catch {
    originRe = /^$/;
  }
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
    // Which server answered: the deploy job checks the migrated paths are live on this build
    c.header("x-memento-server", `ts ${deps.settings.buildSha}`);
  });
  app.use("*", cors({ origin: (origin) => (origin && originRe.test(origin) ? origin : null), credentials: true, allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allowHeaders: [], maxAge: 600 }));
  app.use("*", compress({ threshold: 1000 }));
  app.use("*", etag());
  app.route("/", healthRoutes);
  app.route("/", installRoutes);
  app.route("/api/auth", authRoutes);
  app.route("/api/todos", todoRoutes);
  app.route("/api/tools", toolRoutes);
  app.route("/api/public", publicRoutes);
  app.route("/api/dashboard", dashboardRoutes);
  app.route("/api/hierarchy", hierarchyRoutes);
  app.route("/api/documents", documentRoutes);
  app.route("/api/media", mediaRoutes);
  app.route("/api/skills", skillRoutes);
  app.route("/api/plugins", pluginRoutes);
  app.route("/api/system/update", updateRoutes);
  app.notFound((c) => c.json({ detail: "Not Found" }, 404));
  app.onError((err, c) => errorResponse(c, err));
  return app;
}

export { HttpError };
