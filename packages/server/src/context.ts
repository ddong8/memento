// What every route gets: settings, the database, Redis, and helpers for the request at hand.
import type { Context } from "hono";
import type { Redis } from "ioredis";

import type { AuditRequest } from "./audit";
import { clientIp } from "./client-ip";
import type { Settings } from "./config";
import type { Db } from "./db/client";

export interface Deps {
  settings: Settings;
  db: Db;
  redis: () => Redis | null;
}

export type AppEnv = { Variables: { deps: Deps }; Bindings: { incoming?: { socket?: { remoteAddress?: string } } } };

export function requestIp(c: Context<AppEnv>): string | null {
  return clientIp(c.req.raw.headers, c.env?.incoming?.socket?.remoteAddress ?? null);
}

export function auditRequest(c: Context<AppEnv>): AuditRequest {
  return { ip: requestIp(c), userAgent: c.req.header("user-agent") ?? null, path: c.req.path, method: c.req.method };
}
