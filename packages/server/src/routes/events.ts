// /api/events/stream: real-time SSE stream (server/server/api/events.py).
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { decodeToken } from "../auth/jwt";
import type { AppEnv } from "../context";
import { users } from "../db/pulled/schema";
import { HttpError, normalizeUuid } from "../http";
import { parseEventId, subscribeStream } from "../services/sse";

export const eventRoutes = new Hono<AppEnv>();

eventRoutes.get("/stream", async (c) => {
  const { db, settings } = c.var.deps;
  let token = c.req.query("token") ?? null;
  const auth = c.req.header("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) token = auth.slice(7).trim();
  if (!token) throw new HttpError(401, "Missing token");

  const payload = await decodeToken(token, settings.secretKey, settings.algorithm);
  const userId = payload.sub;
  if (!userId) throw new HttpError(401, "Invalid token payload");
  const uid = normalizeUuid(userId);
  if (!uid) throw new HttpError(401, "User not found or inactive");

  const [u] = await db.select({ status: users.status }).from(users).where(eq(users.id, uid)).limit(1);
  if (!u || u.status !== "active") throw new HttpError(401, "User not found or inactive");

  const since = parseEventId(c.req.header("last-event-id"));
  const stream = subscribeStream(String(userId), since, c.req.raw.signal);
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
});
