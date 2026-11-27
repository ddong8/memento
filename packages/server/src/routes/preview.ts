// Sandboxed dev-server HTTP preview proxy over device WebSockets (server/server/api/preview.py).
import { randomBytes } from "node:crypto";

import { Hono } from "hono";

import { currentUser, type UserRow } from "../auth/current-user";
import type { AppEnv, Deps } from "../context";
import { HttpError, parseJsonObject, queryRequiredString } from "../http";
import { cluster } from "../services/cluster";
import { deviceHasFeature } from "../services/device-reports";
import { wsManager } from "../services/ws-manager";
import { resolveDevice } from "./git-review";

const TOKEN_KEY = "memento:preview:";
const TOKEN_TTL = 2 * 3600;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const localTokens = new Map<string, string>();
const PASS_REQ = new Set(["accept", "accept-language", "content-type", "cache-control", "if-none-match", "if-modified-since", "range", "x-requested-with"]);
const DROP_RES = new Set(["content-security-policy", "x-frame-options", "set-cookie", "strict-transport-security", "access-control-allow-origin"]);

const HTML_ATTR_RE = /(\s(?:src|href|action|poster|data-src)\s*=\s*["'])\/(?!\/)/gi;
const JS_IMPORT_RE = /((?:\bfrom|\bimport)\s*\(?\s*["'])\/(?!\/)/g;
const CSS_URL_RE = /(url\(\s*["']?)\/(?!\/)/g;
const CSS_IMPORT_RE = /(@import\s+["'])\/(?!\/)/g;

async function kvSet(key: string, value: string): Promise<void> {
  const r = cluster.redis;
  if (!r) localTokens.set(key, value);
  else await r.set(key, value, "EX", TOKEN_TTL);
}

async function kvGet(key: string): Promise<string | null> {
  const r = cluster.redis;
  if (!r) return localTokens.get(key) ?? null;
  return r.get(key);
}

async function ask(candidates: string[], payload: Record<string, unknown>, timeoutSec: number): Promise<Record<string, unknown>> {
  let resp: Record<string, unknown> = { error: "设备不在线", code: "offline" };
  for (const cand of candidates) {
    resp = await wsManager.requestDevice(cand, payload, timeoutSec);
    if (resp.code !== "offline") break;
  }
  return resp;
}

async function resolvePreviewDevice(deps: Deps, deviceId: string, user: UserRow): Promise<string[]> {
  const [machine, candidates] = await resolveDevice(deps.db, deps.settings, deviceId, user);
  if (!deviceHasFeature(machine.name, "preview", user, deps.settings)) {
    throw new HttpError(400, "这台设备的 Memento 还不支持预览，升级到 1.0.165 及以上后再试");
  }
  return candidates;
}

export function rewritePaths(body: string, contentType: string, prefix: string): string {
  const ct = (contentType || "").toLowerCase();
  let out = body;
  if (ct.includes("html")) {
    out = out.replace(HTML_ATTR_RE, `$1${prefix}`);
    out = out.replace(JS_IMPORT_RE, `$1${prefix}`);
    out = out.replace(CSS_URL_RE, `$1${prefix}`);
  } else if (ct.includes("javascript") || ct.includes("ecmascript")) {
    out = out.replace(JS_IMPORT_RE, `$1${prefix}`);
  } else if (ct.includes("css")) {
    out = out.replace(CSS_URL_RE, `$1${prefix}`);
    out = out.replace(CSS_IMPORT_RE, `$1${prefix}`);
  }
  return out;
}

export function rewriteLocation(location: string, port: number, prefix: string): string {
  let loc = location;
  for (const origin of [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://0.0.0.0:${port}`]) {
    if (loc.startsWith(origin)) {
      loc = loc.slice(origin.length) || "/";
      break;
    }
  }
  if (loc.startsWith("/") && !loc.startsWith("//")) return prefix + loc.slice(1);
  return loc;
}

export const previewRoutes = new Hono<AppEnv>();

previewRoutes.get("/ports", async (c) => {
  const user = await currentUser(c);
  const deviceId = queryRequiredString(c, "device_id");
  const candidates = await resolvePreviewDevice(c.var.deps, deviceId, user);
  const resp = await ask(candidates, { type: "preview_ports_req" }, 10);
  if (resp.code === "offline") throw new HttpError(503, "目标设备当前不在线");
  if (!resp.ok) throw new HttpError(400, String(resp.error || "读取端口失败"));
  return c.json({ ports: Array.isArray(resp.ports) ? resp.ports : [] });
});

previewRoutes.post("/session", async (c) => {
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const deviceId = typeof body.device_id === "string" ? body.device_id : "";
  if (!deviceId) throw new HttpError(422, [{ type: "missing", loc: ["body", "device_id"], msg: "Field required" }]);
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(422, [{ type: "int_parsing", loc: ["body", "port"], msg: "Port must be 1..65535", input: body.port }]);
  }
  const candidates = await resolvePreviewDevice(c.var.deps, deviceId, user);
  const token = randomBytes(24).toString("base64url");
  await kvSet(TOKEN_KEY + token, JSON.stringify({ user: String(user.id), devices: candidates, port }));
  return c.json({ token, url: `/api/preview/t/${token}/` });
});

async function handleProxy(token: string, tailPath: string, req: Request): Promise<Response> {
  if (!TOKEN_RE.test(token)) throw new HttpError(404, "Not Found");
  const raw = await kvGet(TOKEN_KEY + token);
  if (!raw) {
    return new Response("预览已过期，回到 Memento 重新打开预览", {
      status: 410,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const info = JSON.parse(raw) as { port: number; devices?: string[] };
  const port = Number(info.port);
  const prefix = `/api/preview/t/${token}/`;
  const url = new URL(req.url);
  const target = `/${tailPath}${url.search || ""}`;
  const reqHeaders: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    if (PASS_REQ.has(k.toLowerCase())) reqHeaders[k] = v;
  });
  const bodyBuf = req.method === "GET" || req.method === "HEAD" ? Buffer.alloc(0) : Buffer.from(await req.arrayBuffer());
  const payload: Record<string, unknown> = {
    type: "preview_http_req",
    port,
    method: req.method,
    path: target,
    headers: reqHeaders,
    ...(bodyBuf.length ? { body_b64: bodyBuf.toString("base64") } : {}),
  };
  const resp = await ask(Array.isArray(info.devices) ? info.devices : [], payload, 30);
  if (!resp.ok) {
    const status = resp.code === "offline" ? 503 : 502;
    return new Response(String(resp.error || "预览请求失败"), {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  let content: Uint8Array = Buffer.from(String(resp.body_b64 ?? ""), "base64");
  const outHeaders = new Headers();
  const rawHeaders = (resp.headers && typeof resp.headers === "object" ? resp.headers : {}) as Record<string, string>;
  let ctype = "";
  let locationVal: string | null = null;
  for (const [k, v] of Object.entries(rawHeaders)) {
    const low = k.toLowerCase();
    if (DROP_RES.has(low) || low === "content-length" || low === "transfer-encoding") continue;
    if (low === "content-type") ctype = String(v);
    if (low === "location") {
      locationVal = String(v);
      continue;
    }
    outHeaders.set(k, String(v));
  }
  const ctypeLow = ctype.toLowerCase();
  if (ctypeLow.includes("html") || ctypeLow.includes("javascript") || ctypeLow.includes("ecmascript") || ctypeLow.includes("css")) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      content = Buffer.from(rewritePaths(text, ctype, prefix), "utf8");
    } catch {
      /* binary / non-utf8 */
    }
  }
  if (locationVal !== null) outHeaders.set("location", rewriteLocation(locationVal, port, prefix));
  outHeaders.set("content-security-policy", "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads");
  outHeaders.set("access-control-allow-origin", "*");
  outHeaders.set("cache-control", "no-store");
  return new Response(Buffer.from(content), { status: Number(resp.status || 200), headers: outHeaders });
}

previewRoutes.all("/t/:token/*", async (c) => {
  const token = c.req.param("token");
  const marker = `/t/${token}/`;
  const idx = c.req.path.indexOf(marker);
  const tail = idx >= 0 ? c.req.path.slice(idx + marker.length) : "";
  return handleProxy(token, tail, c.req.raw);
});

previewRoutes.all("/t/:token", async (c) => {
  const token = c.req.param("token");
  return handleProxy(token, "", c.req.raw);
});
