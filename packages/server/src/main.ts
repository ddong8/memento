// Entry point: node dist/main.mjs (packages/server/Dockerfile), or inside the desktop app later (P7).
import type { Server as HttpServer } from "node:http";

import { serve } from "@hono/node-server";

import { createApp } from "./app";
import { listenForBusts } from "./cache";
import { loadSettings, validateProduction } from "./config";
import { createDb } from "./db/client";
import { closeRedis, redisClient } from "./redis";
import { attachDeviceWebSocket } from "./routes/tasks";
import { cluster } from "./services/cluster";
import { startScheduledTaskRunner, stopScheduledTaskRunner } from "./services/scheduled-tasks";

const settings = loadSettings();
validateProduction(settings);
const { sql, db } = createDb(settings.databaseUrl);
const deps = { settings, db, redis: () => redisClient(settings.redisUrl) };
const app = createApp(deps);
const busts = listenForBusts(settings.redisUrl);
await cluster.start(settings.redisUrl);
startScheduledTaskRunner(db);

const server = serve({ fetch: app.fetch, hostname: settings.host, port: settings.port }, (info) => {
  console.log(`memento server (ts) ${settings.buildSha} listening on ${info.address}:${info.port}`);
});
const wss = attachDeviceWebSocket(server as HttpServer, deps);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: closing`);
  wss.close();
  server.close();
  await Promise.allSettled([stopScheduledTaskRunner(), cluster.stop(), sql.end({ timeout: 10 }), closeRedis(), busts?.quit()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
