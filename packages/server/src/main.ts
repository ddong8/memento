// Entry point: node dist/main.mjs (packages/server/Dockerfile), or inside the desktop app later (P7).
import { serve } from "@hono/node-server";

import { createApp } from "./app";
import { listenForBusts } from "./cache";
import { loadSettings, validateProduction } from "./config";
import { createDb } from "./db/client";
import { closeRedis, redisClient } from "./redis";
import { cluster } from "./services/cluster";

const settings = loadSettings();
validateProduction(settings);
const { sql, db } = createDb(settings.databaseUrl);
const app = createApp({ settings, db, redis: () => redisClient(settings.redisUrl) });
const busts = listenForBusts(settings.redisUrl);
await cluster.start(settings.redisUrl);

const server = serve({ fetch: app.fetch, hostname: settings.host, port: settings.port }, (info) => {
  console.log(`memento server (ts) ${settings.buildSha} listening on ${info.address}:${info.port}`);
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: closing`);
  server.close();
  await Promise.allSettled([cluster.stop(), sql.end({ timeout: 10 }), closeRedis(), busts?.quit()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
