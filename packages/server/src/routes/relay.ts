// /api/relay: stateless blind HTTPS reverse tunnel endpoints for standalone desktop <-> mobile access.
// Zero database tables, zero user data persisted on the relay server.
import type { Server as HttpServer } from "node:http";

import { Hono } from "hono";
import type { WebSocketServer } from "ws";

import type { AppEnv } from "../context";
import { relayTunnels } from "../services/relay-tunnel";

export const relayRoutes = new Hono<AppEnv>();

relayRoutes.get("/health", (c) =>
  c.json({
    status: "ok",
    stateless: true,
    active_local_tunnels: relayTunnels.localCount,
  }),
);

// Forward /api/relay/t/:tunnelId and /api/relay/t/:tunnelId/* verbatim to the connected desktop.
relayRoutes.all("/t/:tunnelId", async (c) => {
  const tunnelId = c.req.param("tunnelId");
  const u = new URL(c.req.url);
  return relayTunnels.forwardHttp(tunnelId, c.req.raw, `/${u.search}`);
});

relayRoutes.all("/t/:tunnelId/*", async (c) => {
  const tunnelId = c.req.param("tunnelId");
  const u = new URL(c.req.url);
  const prefix = `/api/relay/t/${encodeURIComponent(tunnelId)}`;
  const rawPrefix = `/api/relay/t/${tunnelId}`;
  let subPath = "/";
  if (u.pathname.startsWith(rawPrefix)) {
    subPath = u.pathname.slice(rawPrefix.length) || "/";
  } else if (u.pathname.startsWith(prefix)) {
    subPath = u.pathname.slice(prefix.length) || "/";
  }
  if (!subPath.startsWith("/")) subPath = `/${subPath}`;
  return relayTunnels.forwardHttp(tunnelId, c.req.raw, `${subPath}${u.search}`);
});

export function attachRelayWebSocket(server: HttpServer): WebSocketServer {
  return relayTunnels.attachWebSocket(server);
}
