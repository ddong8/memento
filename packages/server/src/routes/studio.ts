// /api/studio: gateway proxy to filmkit studio engine, streaming media/videos & publish-to-chat
// (server/server/api/studio.py).
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { currentUser, currentUserOrCollector, userFromToken, verifyCollectorTokenValue, type UserRow } from "../auth/current-user";
import { cacheDeletePrefix } from "../cache";
import type { AppEnv } from "../context";
import { HttpError, parseJsonObject } from "../http";
import { appendConversationTurns, getOrCreateConversation } from "../services/ask-store";
import { isPluginReady, resolveStudioConnection } from "../services/plugins";
import { signVideoUrl, storeVideoBytes } from "../services/storage";

export const studioRoutes = new Hono<AppEnv>();

const SAFE_ID_RE = /^[A-Za-z0-9_\-.:]{1,80}$/;

function checkId(value: string, label = "id"): string {
  if (!SAFE_ID_RE.test(value || "")) throw new HttpError(400, `非法的 ${label}`);
  return value;
}

function filmkitHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {};
  if (token) h.Authorization = `Bearer ${token}`;
  if (extra) Object.assign(h, extra);
  return h;
}

async function requireStudio(c: Context<AppEnv>): Promise<{ user: UserRow; base: string; token: string }> {
  const user = await currentUser(c);
  const [base, token] = resolveStudioConnection(c.var.deps.settings, user);
  return { user, base, token };
}

async function requireAgentDevice(c: Context<AppEnv>): Promise<{ user: UserRow; base: string; token: string }> {
  const user = await currentUserOrCollector(c);
  const [base, token] = resolveStudioConnection(c.var.deps.settings, user);
  return { user, base, token };
}

async function requireMediaUser(c: Context<AppEnv>): Promise<{ user: UserRow; base: string; token: string }> {
  const auth = c.req.header("authorization");
  const qToken = c.req.query("token")?.trim();
  const collector = c.req.header("x-collector-token");
  let user: UserRow;
  if (auth && auth.startsWith("Bearer ")) {
    user = await userFromToken(c, auth.slice(7));
  } else if (qToken) {
    user = await userFromToken(c, qToken);
  } else if (collector) {
    user = await verifyCollectorTokenValue(c, collector);
  } else {
    throw new HttpError(401, "Missing authorization");
  }
  const [base, token] = resolveStudioConnection(c.var.deps.settings, user);
  return { user, base, token };
}

async function proxyJson(
  base: string,
  token: string,
  method: string,
  path: string,
  opts: { payload?: unknown; params?: Record<string, string>; extraHeaders?: Record<string, string>; timeoutSec?: number } = {},
): Promise<unknown> {
  let url = `${base}${path}`;
  if (opts.params && Object.keys(opts.params).length) {
    url += `?${new URLSearchParams(opts.params).toString()}`;
  }
  const headers = filmkitHeaders(token, opts.extraHeaders);
  if (opts.payload !== undefined) headers["content-type"] = "application/json";

  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: opts.payload !== undefined ? JSON.stringify(opts.payload) : undefined,
      signal: AbortSignal.timeout((opts.timeoutSec ?? 120) * 1000),
    });
  } catch (e) {
    const err = e as Error & { name?: string; cause?: { code?: string } };
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new HttpError(504, "演播台引擎请求超时");
    }
    if (err.cause?.code === "ECONNREFUSED" || /ECONNREFUSED|connect/i.test(String(err.message))) {
      throw new HttpError(503, "演播台正在更新或重启，通常 1 分钟内恢复，请稍后重试");
    }
    throw new HttpError(502, `演播台引擎通信失败: ${err.message}`);
  }

  const text = await resp.text();
  if (resp.status >= 400) {
    let detail: unknown = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && "detail" in parsed) detail = parsed.detail;
    } catch {
      /* keep raw */
    }
    throw new HttpError(resp.status as ContentfulStatusCode, detail);
  }
  if (!text) return { ok: true };
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function readOptJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  return parseJsonObject(c).catch(() => ({}));
}

function publicAssetHeaders(c: Context<AppEnv>): Record<string, string> {
  let pub = (c.var.deps.settings.publicUrl || "").trim().replace(/\/+$/, "");
  if (!pub) {
    const url = new URL(c.req.url);
    const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "") || "https";
    const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() || c.req.header("host") || "";
    if (host) pub = `${proto}://${host}`;
  }
  const h: Record<string, string> = {};
  if (pub) h["X-Public-Asset-Base"] = `${pub}/api/studio/assets`;
  const auth = (c.req.header("authorization") || "").trim();
  if (auth) h["X-Public-Asset-Auth"] = auth;
  return h;
}

// ---- Health & Compute ----
studioRoutes.get("/health", async (c) => {
  const user = await currentUser(c);
  let base: string;
  let token: string;
  try {
    [base, token] = resolveStudioConnection(c.var.deps.settings, user);
  } catch (e) {
    const detail = e instanceof HttpError ? String(e.detail) : String(e);
    return c.json({
      online: false,
      installed: isPluginReady(c.var.deps.settings, user, "studio"),
      configured: false,
      filmkit_url: "",
      compute: null,
      error: detail,
    });
  }
  try {
    const r = await fetch(`${base}/health`, { headers: filmkitHeaders(token), signal: AbortSignal.timeout(5000) });
    if (r.status !== 200) {
      return c.json({ online: false, installed: true, configured: true, filmkit_url: base, error: `HTTP ${r.status}` });
    }
    let compute: unknown = null;
    try {
      const rc = await fetch(`${base}/api/studio/compute/status`, { headers: filmkitHeaders(token), signal: AbortSignal.timeout(5000) });
      if (rc.status === 200) compute = ((await rc.json()) as { compute?: unknown })?.compute ?? null;
    } catch {
      /* ignore */
    }
    return c.json({ online: true, installed: true, configured: true, filmkit_url: base, compute, error: "" });
  } catch (e) {
    return c.json({ online: false, installed: true, configured: true, filmkit_url: base, compute: null, error: String(e) });
  }
});

studioRoutes.get("/compute/status", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "GET", "/api/studio/compute/status", { timeoutSec: 15 }));
});

studioRoutes.get("/compute/account", async (c) => {
  const { base, token } = await requireStudio(c);
  const refresh = (c.req.query("refresh") ?? "").toLowerCase() === "true" || c.req.query("refresh") === "1";
  return c.json(await proxyJson(base, token, "GET", "/api/studio/compute/account", { params: { refresh: refresh ? "true" : "false" }, timeoutSec: 45 }));
});

studioRoutes.post("/compute/sessions/stop", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", "/api/studio/compute/sessions/stop", { payload: await readOptJson(c), timeoutSec: 150 }));
});

studioRoutes.post("/compute/start", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", "/api/studio/compute/start", { payload: await readOptJson(c), timeoutSec: 30 }));
});

studioRoutes.post("/compute/stop", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", "/api/studio/compute/stop", { timeoutSec: 150 }));
});

studioRoutes.post("/compute/extend", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", "/api/studio/compute/extend", { payload: await readOptJson(c), timeoutSec: 15 }));
});

studioRoutes.post("/compute/bind", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", "/api/studio/compute/bind", { payload: await readOptJson(c), timeoutSec: 20 }));
});

// ---- Projects, Characters, Voices & BGM ----
studioRoutes.get("/presets", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "GET", "/api/studio/presets"));
});

studioRoutes.get("/projects", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "GET", "/api/studio/projects"));
});

studioRoutes.post("/projects", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", "/api/studio/projects", { payload: await readOptJson(c) }));
});

studioRoutes.get("/projects/:pid", async (c) => {
  const { base, token } = await requireStudio(c);
  const pid = checkId(c.req.param("pid"), "project_id");
  const projsRes = (await proxyJson(base, token, "GET", "/api/studio/projects")) as { projects?: { id?: string }[] };
  const proj = (projsRes.projects ?? []).find((p) => p.id === pid);
  if (!proj) throw new HttpError(404, "项目不存在");
  const charsRes = (await proxyJson(base, token, "GET", `/api/studio/projects/${pid}/characters`)) as { characters?: unknown[] };
  const epsRes = (await proxyJson(base, token, "GET", `/api/studio/projects/${pid}/episodes`)) as { episodes?: unknown[] };
  return c.json({ project: proj, characters: charsRes.characters ?? [], episodes: epsRes.episodes ?? [] });
});

studioRoutes.get("/projects/:pid/characters", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "GET", `/api/studio/projects/${checkId(c.req.param("pid"), "project_id")}/characters`));
});

studioRoutes.get("/projects/:pid/episodes", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "GET", `/api/studio/projects/${checkId(c.req.param("pid"), "project_id")}/episodes`));
});

studioRoutes.delete("/projects/:pid", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "DELETE", `/api/studio/projects/${checkId(c.req.param("pid"), "project_id")}`));
});

studioRoutes.post("/projects/:pid/characters", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", `/api/studio/projects/${checkId(c.req.param("pid"), "project_id")}/characters`, { payload: await readOptJson(c) }));
});

studioRoutes.patch("/characters/:cid", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "PATCH", `/api/studio/characters/${checkId(c.req.param("cid"), "character_id")}`, { payload: await readOptJson(c) }));
});

studioRoutes.delete("/characters/:cid", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "DELETE", `/api/studio/characters/${checkId(c.req.param("cid"), "character_id")}`));
});

studioRoutes.get("/voices", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "GET", "/api/studio/voices"));
});

studioRoutes.post("/voices/preview", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", "/api/studio/voices/preview", { payload: await readOptJson(c), timeoutSec: 90 }));
});

studioRoutes.get("/bgm", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "GET", "/api/studio/bgm"));
});

studioRoutes.post("/bgm/generate", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", "/api/studio/bgm/generate", { payload: await readOptJson(c), timeoutSec: 240 }));
});

// ---- Episodes & Shots ----
studioRoutes.post("/projects/:pid/episodes", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", `/api/studio/projects/${checkId(c.req.param("pid"), "project_id")}/episodes`, { payload: await readOptJson(c) }));
});

studioRoutes.get("/episodes/:eid", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "GET", `/api/studio/episodes/${checkId(c.req.param("eid"), "episode_id")}`));
});

studioRoutes.patch("/episodes/:eid", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "PATCH", `/api/studio/episodes/${checkId(c.req.param("eid"), "episode_id")}`, { payload: await readOptJson(c) }));
});

studioRoutes.post("/episodes/:eid/breakdown", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", `/api/studio/episodes/${checkId(c.req.param("eid"), "episode_id")}/ai-breakdown`, { payload: await readOptJson(c), timeoutSec: 180 }));
});

studioRoutes.post("/episodes/:eid/sync-audio-durations", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", `/api/studio/episodes/${checkId(c.req.param("eid"), "episode_id")}/sync-audio-durations`, { timeoutSec: 240 }));
});

studioRoutes.post("/episodes/:eid/render", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", `/api/studio/episodes/${checkId(c.req.param("eid"), "episode_id")}/render`, { timeoutSec: 60 }));
});

studioRoutes.post("/episodes/:eid/shots", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", `/api/studio/episodes/${checkId(c.req.param("eid"), "episode_id")}/shots`, { payload: await readOptJson(c) }));
});

studioRoutes.patch("/shots/:sid", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "PATCH", `/api/studio/shots/${checkId(c.req.param("sid"), "shot_id")}`, { payload: await readOptJson(c) }));
});

studioRoutes.delete("/shots/:sid", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "DELETE", `/api/studio/shots/${checkId(c.req.param("sid"), "shot_id")}`));
});

studioRoutes.post("/shots/:sid/generate", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", `/api/studio/shots/${checkId(c.req.param("sid"), "shot_id")}/generate`, { payload: await readOptJson(c), timeoutSec: 240 }));
});

studioRoutes.post("/shots/:sid/pick", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", `/api/studio/shots/${checkId(c.req.param("sid"), "shot_id")}/pick`, { payload: await readOptJson(c) }));
});

studioRoutes.post("/shots/:sid/tts-preview", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", `/api/studio/shots/${checkId(c.req.param("sid"), "shot_id")}/tts-preview`, { timeoutSec: 120 }));
});

studioRoutes.post("/shots/:sid/animate", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", `/api/studio/shots/${checkId(c.req.param("sid"), "shot_id")}/animate`, { timeoutSec: 600 }));
});

studioRoutes.post("/shots/:sid/use-prev-last-frame", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", `/api/studio/shots/${checkId(c.req.param("sid"), "shot_id")}/use-prev-last-frame`, { timeoutSec: 60 }));
});

studioRoutes.post("/shots/:sid/lipsync", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", `/api/studio/shots/${checkId(c.req.param("sid"), "shot_id")}/lipsync`, { timeoutSec: 600 }));
});

studioRoutes.post("/episodes/:eid/batch-generate", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", `/api/studio/episodes/${checkId(c.req.param("eid"), "episode_id")}/batch-generate`, { payload: await readOptJson(c), timeoutSec: 30 }));
});

studioRoutes.post("/episodes/:eid/batch-animate", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", `/api/studio/episodes/${checkId(c.req.param("eid"), "episode_id")}/batch-animate`, { payload: await readOptJson(c), timeoutSec: 30 }));
});

studioRoutes.get("/episodes/:eid/batch-status", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "GET", `/api/studio/episodes/${checkId(c.req.param("eid"), "episode_id")}/batch-status`, { timeoutSec: 15 }));
});

studioRoutes.get("/tasks/:task_id", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "GET", `/api/tasks/${checkId(c.req.param("task_id"), "task_id")}`));
});

// ---- Asset & Video Streaming Proxies ----
studioRoutes.get("/assets", async (c) => {
  const { base, token } = await requireMediaUser(c);
  const path = c.req.query("path") || "";
  if (!path || path.length > 400) throw new HttpError(422, [{ type: "string_too_short", loc: ["query", "path"], msg: "1..400", input: path }]);
  const range = c.req.header("range");
  let resp: Response;
  try {
    resp = await fetch(`${base}/api/assets?${new URLSearchParams({ path }).toString()}`, {
      headers: filmkitHeaders(token, range ? { Range: range } : undefined),
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    throw new HttpError(502, `演播台素材拉取失败: ${(e as Error).message}`);
  }
  if (resp.status >= 400) throw new HttpError(resp.status as ContentfulStatusCode, "素材不存在或不可访问");
  const outHeaders = new Headers();
  for (const hk of ["content-type", "content-range", "accept-ranges", "content-length"]) {
    const v = resp.headers.get(hk);
    if (v) outHeaders.set(hk, v);
  }
  if (!outHeaders.has("content-type")) outHeaders.set("content-type", "application/octet-stream");
  outHeaders.set("cache-control", "private, max-age=300");
  return new Response(resp.body, { status: resp.status, headers: outHeaders });
});

studioRoutes.get("/tasks/:task_id/video", async (c) => {
  const { base, token } = await requireMediaUser(c);
  const tid = checkId(c.req.param("task_id"), "task_id");
  const range = c.req.header("range");
  let resp: Response;
  try {
    resp = await fetch(`${base}/api/tasks/${tid}/video`, {
      headers: filmkitHeaders(token, range ? { Range: range } : undefined),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    throw new HttpError(502, `视频流拉取失败: ${(e as Error).message}`);
  }
  if (resp.status >= 400) throw new HttpError(resp.status as ContentfulStatusCode, "成片视频尚未就绪");
  const outHeaders = new Headers();
  for (const hk of ["content-range", "accept-ranges", "content-length", "etag", "last-modified", "content-type"]) {
    const v = resp.headers.get(hk);
    if (v) outHeaders.set(hk, v);
  }
  if (!outHeaders.has("content-type")) outHeaders.set("content-type", "video/mp4");
  if (!outHeaders.has("etag")) outHeaders.set("etag", `"studio-task-${tid}"`);
  outHeaders.set("cache-control", "private, max-age=604800, immutable");
  return new Response(resp.body, { status: resp.status, headers: outHeaders });
});

studioRoutes.get("/episodes/:eid/stream-status", async (c) => {
  const { base, token } = await requireStudio(c);
  try {
    return c.json(await proxyJson(base, token, "GET", `/api/studio/episodes/${checkId(c.req.param("eid"), "episode_id")}/stream-video`, { params: { check: "true" }, timeoutSec: 20 }));
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return c.json({ ready: false, variant: "" });
    throw e;
  }
});

studioRoutes.get("/episodes/:eid/latest-video", async (c) => {
  const { base, token } = await requireMediaUser(c);
  const eid = checkId(c.req.param("eid"), "episode_id");
  const v = c.req.query("v");
  const quality = c.req.query("quality");
  const range = c.req.header("range");
  const detail = (await proxyJson(base, token, "GET", `/api/studio/episodes/${eid}`)) as {
    episode?: { last_task_id?: string; slug?: string };
    project?: { slug?: string };
  };
  const ep = detail.episode ?? {};
  const proj = detail.project ?? {};
  const tid = (ep.last_task_id || "").trim();
  const slugName = `${proj.slug || ""}_${ep.slug || ""}`.replace(/^_+|_+$/g, "");
  const headers = filmkitHeaders(token, range ? { Range: range } : undefined);

  const candidates: string[] = [];
  if (quality?.trim() === "stream") candidates.push(`${base}/api/studio/episodes/${eid}/stream-video`);
  if (tid) candidates.push(`${base}/api/tasks/${tid}/video`);
  if (slugName) {
    candidates.push(`${base}/api/studio/episodes/${eid}/video`);
    candidates.push(`${base}/api/assets?${new URLSearchParams({ path: `films/${slugName}/${slugName}_final.mp4` }).toString()}`);
  }

  for (const url of candidates) {
    try {
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
      if (resp.status === 200 || resp.status === 206) {
        const outHeaders = new Headers();
        for (const hk of ["content-range", "accept-ranges", "content-length", "etag", "last-modified", "content-type"]) {
          const val = resp.headers.get(hk);
          if (val) outHeaders.set(hk, val);
        }
        if (!outHeaders.has("content-type")) outHeaders.set("content-type", "video/mp4");
        const versionTag = tid || slugName || eid;
        const variant = url.endsWith("/stream-video") ? "-stream" : "";
        if (!outHeaders.has("etag")) outHeaders.set("etag", `"studio-ep-${eid}-${versionTag}${variant}"`);
        outHeaders.set("cache-control", v && tid && v.trim() === tid ? "private, max-age=604800, immutable" : "private, max-age=3600");
        return new Response(resp.body, { status: resp.status, headers: outHeaders });
      }
      await resp.body?.cancel();
    } catch {
      continue;
    }
  }
  throw new HttpError(404, "该剧集尚未渲染出可播放成片");
});

studioRoutes.post("/episodes/:eid/publish-to-chat", async (c) => {
  const { db, settings } = c.var.deps;
  const redis = c.var.deps.redis();
  const { user, base, token } = await requireStudio(c);
  const eid = checkId(c.req.param("eid"), "episode_id");
  const body = await readOptJson(c);

  const detail = (await proxyJson(base, token, "GET", `/api/studio/episodes/${eid}`)) as {
    episode?: { title?: string; slug?: string; last_task_id?: string };
    project?: { id?: string; name?: string; slug?: string };
    shots?: { duration?: number }[];
  };
  const ep = detail.episode ?? {};
  const proj = detail.project ?? {};
  const shots = detail.shots ?? [];
  const projName = (proj.name || "未命名项目").trim();
  const epTitle = (ep.title || "成片").trim();
  const slugName = `${proj.slug || "studio"}_${ep.slug || "ep"}`.replace(/^_+|_+$/g, "");
  const tid = String(body.task_id || ep.last_task_id || "").trim();

  const candidates: string[] = [];
  if (tid) candidates.push(`${base}/api/tasks/${checkId(tid, "task_id")}/video`);
  candidates.push(`${base}/api/studio/episodes/${eid}/video`);
  candidates.push(`${base}/api/assets?${new URLSearchParams({ path: `films/${slugName}/${slugName}_final.mp4` }).toString()}`);

  let mp4Bytes: Buffer | null = null;
  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers: filmkitHeaders(token), signal: AbortSignal.timeout(180_000) });
      if (r.status === 200) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 4096) {
          mp4Bytes = buf;
          break;
        }
      }
    } catch {
      continue;
    }
  }
  if (!mp4Bytes) throw new HttpError(404, "未找到该剧集的已渲染 MP4 成片，请先点击合成母带");

  const canonicalUrl = await storeVideoBytes(settings, user.id, `${slugName}_final.mp4`, mp4Bytes, "video/mp4");
  const signedUrl = signVideoUrl(canonicalUrl, settings.secretKey);
  const totalSec = shots.reduce((s, sh) => s + Number(sh.duration || 0), 0);
  const displayTitle = `《${projName}》${epTitle}`;
  const sizeMb = mp4Bytes.length / (1024 * 1024);
  const userPrompt = String(body.note || "").trim() || `从演播台发布成片：${displayTitle}`;
  const assistantMd =
    `演播台成片已归档，可直接在对话内播放、全屏或缓存（${shots.length} 镜 · 约 ${totalSec.toFixed(1)}s · ${sizeMb.toFixed(1)} MB）：\n\n` +
    `![${displayTitle}](${canonicalUrl})\n\n` +
    `- 在演播台继续精修：[${displayTitle}](/studio?project=${proj.id || ""}&episode=${eid})`;

  const conv = await getOrCreateConversation(db, user, {
    conversationId: typeof body.conversation_id === "string" ? body.conversation_id : null,
    title: `演播台成片 · ${displayTitle}`,
    config: { execution_mode: "ai" },
  });
  await appendConversationTurns(db, conv.id, {
    settings,
    userId: user.id,
    question: userPrompt,
    answer: assistantMd,
  });
  await cacheDeletePrefix(redis, "ask_conv_").catch(() => {});

  return c.json({
    ok: true,
    conversation_id: conv.id,
    conversation_title: conv.title,
    title: displayTitle,
    video_url: signedUrl,
    canonical_video_url: canonicalUrl,
    size_bytes: mp4Bytes.length,
  });
});

// ---- Settings, Story Confirm, Upscale & Multi-Platform Publish ----
studioRoutes.get("/settings", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "GET", "/api/studio/settings", { timeoutSec: 15 }));
});

studioRoutes.put("/settings", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "PUT", "/api/studio/settings", { payload: await readOptJson(c), timeoutSec: 15 }));
});

studioRoutes.post("/episodes/:eid/confirm-story", async (c) => {
  const { base, token } = await requireStudio(c);
  const body = await readOptJson(c);
  return c.json(
    await proxyJson(base, token, "POST", `/api/studio/episodes/${checkId(c.req.param("eid"), "episode_id")}/confirm-story`, {
      payload: Object.keys(body).length ? body : { confirmed: true },
      timeoutSec: 15,
    }),
  );
});

studioRoutes.post("/episodes/:eid/batch-upscale", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", `/api/studio/episodes/${checkId(c.req.param("eid"), "episode_id")}/batch-upscale`, { payload: await readOptJson(c), timeoutSec: 30 }));
});

studioRoutes.get("/publish/platforms", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "GET", "/api/studio/publish/platforms", { timeoutSec: 15 }));
});

studioRoutes.post("/publish/agent/heartbeat", async (c) => {
  const { base, token } = await requireAgentDevice(c);
  return c.json(await proxyJson(base, token, "POST", "/api/studio/publish/agent/heartbeat", { payload: await readOptJson(c), timeoutSec: 15 }));
});

studioRoutes.post("/publish/agent/claim", async (c) => {
  const { base, token } = await requireAgentDevice(c);
  return c.json(await proxyJson(base, token, "POST", "/api/studio/publish/agent/claim", { payload: await readOptJson(c), timeoutSec: 15 }));
});

studioRoutes.post("/publish/agent/report", async (c) => {
  const { base, token } = await requireAgentDevice(c);
  return c.json(await proxyJson(base, token, "POST", "/api/studio/publish/agent/report", { payload: await readOptJson(c), timeoutSec: 15 }));
});

studioRoutes.post("/publish/agent/login", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", "/api/studio/publish/agent/login", { payload: await readOptJson(c), timeoutSec: 20 }));
});

studioRoutes.get("/episodes/:eid/publish", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "GET", `/api/studio/episodes/${checkId(c.req.param("eid"), "episode_id")}/publish`, { timeoutSec: 30 }));
});

studioRoutes.post("/episodes/:eid/publish/prepare", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", `/api/studio/episodes/${checkId(c.req.param("eid"), "episode_id")}/publish/prepare`, { payload: await readOptJson(c), timeoutSec: 240 }));
});

studioRoutes.patch("/publish/jobs/:jid", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "PATCH", `/api/studio/publish/jobs/${checkId(c.req.param("jid"), "job_id")}`, { payload: await readOptJson(c), timeoutSec: 30 }));
});

studioRoutes.delete("/publish/jobs/:jid", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "DELETE", `/api/studio/publish/jobs/${checkId(c.req.param("jid"), "job_id")}`, { timeoutSec: 30 }));
});

studioRoutes.post("/publish/jobs/:jid/dispatch", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(
    await proxyJson(base, token, "POST", `/api/studio/publish/jobs/${checkId(c.req.param("jid"), "job_id")}/dispatch`, {
      payload: await readOptJson(c),
      extraHeaders: publicAssetHeaders(c),
      timeoutSec: 30,
    }),
  );
});

studioRoutes.post("/episodes/:eid/publish/dispatch-batch", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(
    await proxyJson(base, token, "POST", `/api/studio/episodes/${checkId(c.req.param("eid"), "episode_id")}/publish/dispatch-batch`, {
      payload: await readOptJson(c),
      extraHeaders: publicAssetHeaders(c),
      timeoutSec: 60,
    }),
  );
});

studioRoutes.get("/publish/jobs/:jid/sync", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "GET", `/api/studio/publish/jobs/${checkId(c.req.param("jid"), "job_id")}/sync`, { timeoutSec: 15 }));
});

studioRoutes.post("/publish/jobs/:jid/confirm", async (c) => {
  const { base, token } = await requireStudio(c);
  return c.json(await proxyJson(base, token, "POST", `/api/studio/publish/jobs/${checkId(c.req.param("jid"), "job_id")}/confirm`, { payload: {}, timeoutSec: 15 }));
});

studioRoutes.get("/episodes/:eid/publish/bundle.zip", async (c) => {
  const { base, token } = await requireMediaUser(c);
  const eid = checkId(c.req.param("eid"), "episode_id");
  let resp: Response;
  try {
    resp = await fetch(`${base}/api/studio/episodes/${eid}/publish/bundle.zip`, {
      headers: filmkitHeaders(token),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw new HttpError(502, `拉取多平台分发包失败: ${(e as Error).message}`);
  }
  if (resp.status >= 400) throw new HttpError(resp.status as ContentfulStatusCode, "尚未生成多平台发布包");
  const outHeaders = new Headers();
  outHeaders.set("content-type", "application/zip");
  const cd = resp.headers.get("content-disposition");
  outHeaders.set("content-disposition", cd || `attachment; filename="${eid}_publish_bundle.zip"`);
  const cl = resp.headers.get("content-length");
  if (cl) outHeaders.set("content-length", cl);
  return new Response(resp.body, { status: resp.status, headers: outHeaders });
});
