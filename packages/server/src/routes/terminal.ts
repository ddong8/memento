// Interactive web terminals backed by node-pty on devices (server/server/api/terminal.py).
import { randomUUID } from "node:crypto";

import { Hono } from "hono";

import { currentUser, type UserRow } from "../auth/current-user";
import type { AppEnv } from "../context";
import { HttpError, parseJsonObject } from "../http";
import { cluster } from "../services/cluster";
import { deviceHasFeature } from "../services/device-reports";
import { wsManager } from "../services/ws-manager";
import { resolveDevice } from "./git-review";

export const TERM_ID_RE = /^term-[A-Za-z0-9_-]{6,64}$/;
const OWNER_KEY = "memento:term:";
const OWNER_TTL = 3600;
const KEEPALIVE_MS = 15_000;
const MAX_INPUT = 64 * 1024;

const localOwners = new Map<string, string>();

async function kvSet(key: string, value: string): Promise<void> {
  const r = cluster.redis;
  if (!r) localOwners.set(key, value);
  else await r.set(key, value, "EX", OWNER_TTL);
}

async function kvGet(key: string): Promise<string | null> {
  const r = cluster.redis;
  if (!r) return localOwners.get(key) ?? null;
  const raw = await r.get(key);
  if (raw !== null) await r.expire(key, OWNER_TTL).catch(() => {});
  return raw;
}

async function kvDel(key: string): Promise<void> {
  const r = cluster.redis;
  if (!r) localOwners.delete(key);
  else await r.del(key);
}

async function remember(termId: string, user: UserRow, candidates: string[]): Promise<void> {
  await kvSet(OWNER_KEY + termId, JSON.stringify({ user: String(user.id), devices: candidates }));
}

async function owned(termId: string, user: UserRow): Promise<string[]> {
  if (!TERM_ID_RE.test(termId)) throw new HttpError(400, "终端编号不合法");
  const raw = await kvGet(OWNER_KEY + termId);
  if (!raw) throw new HttpError(404, "终端已经关闭");
  const info = JSON.parse(raw) as { user?: string; devices?: string[] };
  if (info.user !== String(user.id)) throw new HttpError(404, "终端已经关闭");
  return Array.isArray(info.devices) ? info.devices : [];
}

async function sendToAny(candidates: string[], payload: Record<string, unknown>): Promise<boolean> {
  for (const cand of candidates) {
    if (await wsManager.sendJson(cand, payload)) return true;
  }
  return false;
}

function intInRange(v: unknown, fallback: number | null, field: string, min: number, max: number): number {
  if (v === undefined || v === null) {
    if (fallback !== null) return fallback;
    throw new HttpError(422, [{ type: "missing", loc: ["body", field], msg: "Field required" }]);
  }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(422, [{ type: "int_parsing", loc: ["body", field], msg: `Must be integer in [${min}, ${max}]`, input: v }]);
  }
  return n;
}

export const terminalRoutes = new Hono<AppEnv>();

terminalRoutes.post("/open", async (c) => {
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const deviceId = typeof body.device_id === "string" ? body.device_id : "";
  if (!deviceId) throw new HttpError(422, [{ type: "missing", loc: ["body", "device_id"], msg: "Field required", input: body }]);
  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  const cols = intInRange(body.cols, 80, "cols", 2, 500);
  const rows = intInRange(body.rows, 24, "rows", 2, 500);
  const reqTermId = typeof body.term_id === "string" && body.term_id ? body.term_id : null;

  const [machine, candidates] = await resolveDevice(c.var.deps.db, c.var.deps.settings, deviceId, user);
  if (!deviceHasFeature(machine.name, "terminal", user, c.var.deps.settings)) {
    throw new HttpError(400, "这台设备的 Memento 还不支持终端，升级到 1.0.161 及以上后再试");
  }
  const termId = reqTermId && TERM_ID_RE.test(reqTermId) ? reqTermId : `term-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  if (reqTermId && reqTermId === termId) await owned(termId, user);

  let resp: Record<string, unknown> = { error: "设备不在线", code: "offline" };
  for (const cand of candidates) {
    resp = await wsManager.requestDevice(cand, { type: "term_open", term_id: termId, cwd, cols, rows }, 12);
    if (resp.code !== "offline") break;
  }
  if (resp.code === "offline") throw new HttpError(503, "目标设备当前不在线");
  if (!resp.ok) throw new HttpError(400, String(resp.error || "打开终端失败"));
  await remember(termId, user, candidates);
  return c.json({ term_id: termId });
});

terminalRoutes.get("/:term_id/stream", async (c) => {
  const user = await currentUser(c);
  const termId = c.req.param("term_id");
  await owned(termId, user);
  const q = await wsManager.subscribeTask(termId);
  const encoder = new TextEncoder();
  let closed = false;
  const signal = c.req.raw.signal;
  const onAbort = () => {
    closed = true;
    q.close();
  };
  signal?.addEventListener("abort", onAbort);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (s: string) => {
        if (!closed) controller.enqueue(encoder.encode(s));
      };
      try {
        enqueue(`data: ${JSON.stringify({ type: "ready" })}\n\n`);
        while (!closed) {
          const evt = await q.get(KEEPALIVE_MS);
          if (closed) break;
          if (!evt) {
            enqueue(": keepalive\n\n");
            continue;
          }
          const etype = evt.type;
          if (etype === "task_chunk") {
            enqueue(`data: ${JSON.stringify({ type: "output", data: String(evt.text ?? "") })}\n\n`);
          } else if (etype === "task_event" && (evt.event as Record<string, unknown> | undefined)?.kind === "term_exit") {
            enqueue(`data: ${JSON.stringify({ type: "exit", exit_code: (evt.event as Record<string, unknown>).exit_code ?? null })}\n\n`);
            break;
          }
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      } finally {
        closed = true;
        signal?.removeEventListener("abort", onAbort);
        await wsManager.unsubscribeTask(termId);
      }
    },
    async cancel() {
      closed = true;
      signal?.removeEventListener("abort", onAbort);
      await wsManager.unsubscribeTask(termId);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
});

terminalRoutes.post("/:term_id/input", async (c) => {
  const user = await currentUser(c);
  const termId = c.req.param("term_id");
  const body = await parseJsonObject(c);
  if (typeof body.data !== "string" || body.data.length > MAX_INPUT) {
    throw new HttpError(422, [{ type: "string_type", loc: ["body", "data"], msg: "Invalid data", input: body.data }]);
  }
  const candidates = await owned(termId, user);
  if (!(await sendToAny(candidates, { type: "term_input", term_id: termId, data: body.data }))) {
    throw new HttpError(503, "目标设备当前不在线");
  }
  return c.json({ ok: true });
});

terminalRoutes.post("/:term_id/resize", async (c) => {
  const user = await currentUser(c);
  const termId = c.req.param("term_id");
  const body = await parseJsonObject(c);
  const cols = intInRange(body.cols, null, "cols", 2, 500);
  const rows = intInRange(body.rows, null, "rows", 2, 500);
  const candidates = await owned(termId, user);
  await sendToAny(candidates, { type: "term_resize", term_id: termId, cols, rows });
  return c.json({ ok: true });
});

terminalRoutes.post("/:term_id/close", async (c) => {
  const user = await currentUser(c);
  const termId = c.req.param("term_id");
  const candidates = await owned(termId, user);
  await sendToAny(candidates, { type: "term_close", term_id: termId });
  await kvDel(OWNER_KEY + termId);
  return c.json({ ok: true });
});
