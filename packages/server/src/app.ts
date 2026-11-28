// The Hono app: serves all Memento API routes, and in standalone mode (MEMENTO_WEB_UPSTREAM)
// transparently proxies non-API page & static asset requests to the bundled Next.js server.
import * as http from "node:http";
import * as https from "node:https";

import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { etag } from "hono/etag";

import type { AppEnv, Deps } from "./context";
import { errorResponse, HttpError } from "./http";
import { adminRoutes } from "./routes/admin";
import { agentCapabilitiesRoutes, askRoutes } from "./routes/ask";
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
import { healthOverviewRoutes } from "./routes/health-overview";
import { hierarchyRoutes } from "./routes/hierarchy";
import { ingestRoutes } from "./routes/ingest";
import { installRoutes } from "./routes/install";
import { learningRoutes } from "./routes/learning";
import { lifeRoutes } from "./routes/life";
import { llmRoutes } from "./routes/llm";
import { mediaRoutes } from "./routes/media";
import { memoryRoutes } from "./routes/memory";
import { missionRoutes } from "./routes/missions";
import { notifyRoutes } from "./routes/notify";
import { planRoutes } from "./routes/plans";
import { pluginRoutes } from "./routes/plugins";
import { previewRoutes } from "./routes/preview";
import { proactiveRoutes } from "./routes/proactive";
import { profileRoutes } from "./routes/profile";
import { projectRoutes } from "./routes/projects";
import { quotaRoutes } from "./routes/quotas";
import { relayRoutes } from "./routes/relay";
import { scheduledTaskRoutes } from "./routes/scheduled-tasks";
import { scimRoutes } from "./routes/scim";
import { searchRoutes } from "./routes/search";
import { shareRoutes } from "./routes/share";
import { skillRoutes } from "./routes/skills";
import { ssoRoutes } from "./routes/sso";
import { studioRoutes } from "./routes/studio";
import { taskRoutes } from "./routes/tasks";
import { terminalRoutes } from "./routes/terminal";
import { todoRoutes } from "./routes/todos";
import { publicRoutes, toolRoutes } from "./routes/tools";
import { updateRoutes } from "./routes/updates";

/** Paths this server answers, for the entrance and the contract check (scripts/contract.mts). */
export const MIGRATED_PATHS = [
  "/api/auth",
  "/api/auth/oidc",
  "/api/scim/v2",
  "/api/admin",
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
  "/api/profile",
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
  "/api/ask",
  "/api/agent/capabilities",
  "/api/agent/models",
  "/api/learning",
  "/api/health/overview",
  "/api/projects",
  "/api/memory",
  "/api/share",
  "/api/studio",
  "/api/plans",
  "/api/missions",
  "/api/relay",
] as const;

function skipStreamMiddleware(path: string): boolean {
  return (
    path === "/api/events/stream" ||
    path === "/api/ask" ||
    path.endsWith("/stream") ||
    path.includes("/files/stream") ||
    path.startsWith("/api/preview/t/") ||
    path.startsWith("/api/relay/t/") ||
    path === "/api/studio/assets" ||
    (path.startsWith("/api/studio/tasks/") && path.endsWith("/video")) ||
    (path.startsWith("/api/studio/episodes/") && (path.endsWith("/latest-video") || path.endsWith("/bundle.zip")))
  );
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function isServerOwnedPath(path: string): boolean {
  return (
    path === "/health" ||
    path.startsWith("/health/") ||
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/install" ||
    path.startsWith("/install/") ||
    path === "/install.sh" ||
    path === "/install.ps1" ||
    path === "/agent/quotas" ||
    path.startsWith("/agent/quotas/") ||
    path === "/quotas" ||
    path.startsWith("/quotas/")
  );
}

function proxyToWebUpstream(req: Request, upstreamBase: string): Promise<Response> {
  const incoming = new URL(req.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, upstreamBase);
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    const low = k.toLowerCase();
    if (low === "host" || HOP_BY_HOP.has(low)) return;
    headers[k] = v;
  });
  headers["x-forwarded-host"] = incoming.host;
  headers["x-forwarded-proto"] = incoming.protocol.replace(/:$/, "");

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return (hasBody ? req.arrayBuffer().then((ab) => Buffer.from(ab)) : Promise.resolve(null)).then(
    (bodyBuf) =>
      new Promise<Response>((resolve) => {
        const mod = target.protocol === "https:" ? https : http;
        if (bodyBuf) headers["content-length"] = String(bodyBuf.byteLength);
        const upReq = mod.request(
          target,
          { method: req.method, headers, timeout: 60_000 },
          (upRes) => {
            const outHeaders = new Headers();
            for (const [k, v] of Object.entries(upRes.headers)) {
              if (!v || HOP_BY_HOP.has(k.toLowerCase())) continue;
              if (Array.isArray(v)) {
                for (const item of v) outHeaders.append(k, item);
              } else {
                outHeaders.set(k, v);
              }
            }
            const status = upRes.statusCode ?? 502;
            const bodyless = req.method === "HEAD" || status === 204 || status === 304;
            if (bodyless) {
              upRes.resume();
              resolve(new Response(null, { status, headers: outHeaders }));
              return;
            }
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                upRes.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
                upRes.on("end", () => controller.close());
                upRes.on("error", (err) => controller.error(err));
              },
              cancel() {
                upRes.destroy();
              },
            });
            resolve(new Response(stream, { status, headers: outHeaders }));
          },
        );
        upReq.on("timeout", () => {
          upReq.destroy(new Error("Web upstream timeout"));
        });
        upReq.on("error", (err) => {
          resolve(
            new Response(`Web upstream unavailable: ${err.message}`, {
              status: 502,
              headers: { "content-type": "text/plain; charset=utf-8" },
            }),
          );
        });
        if (bodyBuf && bodyBuf.byteLength > 0) upReq.write(bodyBuf);
        upReq.end();
      }),
  );
}

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  const webUpstream = deps.settings.webUpstream;
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
    if (skipStreamMiddleware(c.req.path) || (webUpstream && !isServerOwnedPath(c.req.path))) return next();
    return compress({ threshold: 1000 })(c, next);
  });
  app.use("*", async (c, next) => {
    // Skip automatic ETag on streams, /api/devices, /api/ask/conversations/:id, and proxied web pages
    if (
      skipStreamMiddleware(c.req.path) ||
      c.req.path === "/api/devices" ||
      c.req.path.startsWith("/api/ask/conversations/") ||
      (webUpstream && !isServerOwnedPath(c.req.path))
    ) {
      return next();
    }
    return etag()(c, next);
  });
  app.route("/", healthRoutes);
  app.route("/", installRoutes);
  app.route("/api/auth/oidc", ssoRoutes);
  app.route("/api/auth", authRoutes);
  app.route("/api/scim/v2", scimRoutes);
  app.route("/api/admin", adminRoutes);
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
  app.route("/api/profile", profileRoutes);
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
  app.route("/api/ask", askRoutes);
  app.route("/api/agent", agentCapabilitiesRoutes);
  app.route("/api/learning", learningRoutes);
  app.route("/api/health", healthOverviewRoutes);
  app.route("/api/projects", projectRoutes);
  app.route("/api/memory", memoryRoutes);
  app.route("/api/share", shareRoutes);
  app.route("/api/studio", studioRoutes);
  app.route("/api/plans", planRoutes);
  app.route("/api/missions", missionRoutes);
  app.route("/api/relay", relayRoutes);
  if (webUpstream) {
    app.all("*", (c, next) => {
      if (isServerOwnedPath(c.req.path)) return next();
      return proxyToWebUpstream(c.req.raw, webUpstream);
    });
  }
  app.notFound((c) => c.json({ detail: "Not Found" }, 404));
  app.onError((err, c) => errorResponse(c, err));
  return app;
}

export { HttpError };
