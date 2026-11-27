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
import { collectExclusionRoutes } from "./routes/collect-exclusions";
import { conversationRoutes } from "./routes/conversations";
import { dailyRoutes } from "./routes/daily";
import { dashboardRoutes } from "./routes/dashboard";
import { dataIoRoutes } from "./routes/data-io";
import { deviceRoutes } from "./routes/devices";
import { documentRoutes } from "./routes/documents";
import { eventRoutes } from "./routes/events";
import { gitReviewRoutes } from "./routes/git-review";
import { healthRoutes } from "./routes/health";
import { hierarchyRoutes } from "./routes/hierarchy";
import { ingestRoutes } from "./routes/ingest";
import { installRoutes } from "./routes/install";
import { lifeRoutes } from "./routes/life";
import { llmRoutes } from "./routes/llm";
import { mediaRoutes } from "./routes/media";
import { notifyRoutes } from "./routes/notify";
import { pluginRoutes } from "./routes/plugins";
import { previewRoutes } from "./routes/preview";
import { proactiveRoutes } from "./routes/proactive";
import { quotaRoutes } from "./routes/quotas";
import { scheduledTaskRoutes } from "./routes/scheduled-tasks";
import { searchRoutes } from "./routes/search";
import { skillRoutes } from "./routes/skills";
import { taskRoutes } from "./routes/tasks";
import { terminalRoutes } from "./routes/terminal";
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
  "/api/events",
  "/api/notify",
  "/api/profile/llm",
  "/api/daily",
  "/api/life",
  "/api/proactive",
  "/api/data",
  "/api/search",
  "/api/ingest",
  "/api/conversations",
  "/api/collect/exclusions",
  "/api/devices",
  "/api/tasks",
  "/api/terminal",
  "/api/preview",
  "/api/git",
  "/api/agent/quotas",
  "/api/quotas",
  "/agent/quotas",
  "/quotas",
  "/api/scheduled-tasks",
] as const;

function skipStreamMiddleware(path: string): boolean {
  return (
    path === "/api/events/stream" ||
    path.endsWith("/stream") ||
    path.includes("/files/stream") ||
    path.startsWith("/api/preview/t/")
  );
}

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
  app.use("*", async (c, next) => {
    if (skipStreamMiddleware(c.req.path)) return next();
    return compress({ threshold: 1000 })(c, next);
  });
  app.use("*", async (c, next) => {
    // Skip automatic ETag on streams and on /api/devices (devices.ts computes its own MD5 ETag & 304)
    if (skipStreamMiddleware(c.req.path) || c.req.path === "/api/devices") return next();
    return etag()(c, next);
  });
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
  app.route("/api/events", eventRoutes);
  app.route("/api/notify", notifyRoutes);
  app.route("/api/profile/llm", llmRoutes);
  app.route("/api/daily", dailyRoutes);
  app.route("/api/life", lifeRoutes);
  app.route("/api/proactive", proactiveRoutes);
  app.route("/api/data", dataIoRoutes);
  app.route("/api/search", searchRoutes);
  app.route("/api/ingest", ingestRoutes);
  app.route("/api/conversations", conversationRoutes);
  app.route("/api/collect/exclusions", collectExclusionRoutes);
  app.route("/api/devices", deviceRoutes);
  app.route("/api/tasks", taskRoutes);
  app.route("/api/terminal", terminalRoutes);
  app.route("/api/preview", previewRoutes);
  app.route("/api/git", gitReviewRoutes);
  app.route("/api/agent/quotas", quotaRoutes);
  app.route("/api/quotas", quotaRoutes);
  app.route("/agent/quotas", quotaRoutes);
  app.route("/quotas", quotaRoutes);
  app.route("/api/scheduled-tasks", scheduledTaskRoutes);
  app.notFound((c) => c.json({ detail: "Not Found" }, 404));
  app.onError((err, c) => errorResponse(c, err));
  return app;
}

export { HttpError };
