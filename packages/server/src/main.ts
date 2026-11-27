// Entry point: node dist/main.mjs (packages/server/Dockerfile), or inside the desktop app later (P7).
import type { Server as HttpServer } from "node:http";

import { serve } from "@hono/node-server";

import { createApp } from "./app";
import { listenForBusts } from "./cache";
import { loadSettings, parseBool, validateProduction } from "./config";
import { createDb } from "./db/client";
import { checkSchemaReady, runAllMigrations } from "./db/migrate";
import { closeRedis, redisClient } from "./redis";
import { attachDeviceWebSocket, registerMindResonanceInjector, registerTaskFinishedHook } from "./routes/tasks";
import { askRuns } from "./services/ask-runs";
import { recoverFinishedTaskHook } from "./services/ask-store";
import { cluster } from "./services/cluster";
import { renderMindResonanceMarkdown, senseResonance, startDynamicScenarioReloader, stopDynamicScenarioReloader } from "./services/mind-resonance-service";
import { wakeForTask } from "./services/mission-service";
import { startPlanRunner, stopPlanRunner } from "./services/plan-service";
import { startProactivePulse, stopProactivePulse } from "./services/pulse-runner";
import { startScheduledTaskRunner, stopScheduledTaskRunner } from "./services/scheduled-tasks";
import { scheduler } from "./services/scheduler";
import { sealExisting } from "./services/secret-box";

const settings = loadSettings();
validateProduction(settings);
const { sql, db } = createDb(settings.databaseUrl);
if (parseBool(process.env.MEMENTO_SKIP_DDL_MIGRATIONS, false)) {
  await checkSchemaReady(sql).catch((err) => {
    console.warn("[db] schema readiness check warning:", (err as Error).message);
  });
} else {
  const ver = await runAllMigrations(sql);
  console.log(`[db] migrations ready (${ver})`);
}
await sealExisting(db, settings).catch(() => {});
const deps = { settings, db, redis: () => redisClient(settings.redisUrl) };
askRuns.bindDeps(deps);
registerTaskFinishedHook(async (d, taskId, watched) => {
  await recoverFinishedTaskHook(d.db, taskId, watched);
  await wakeForTask(d, taskId).catch(() => {});
});
registerMindResonanceInjector(async (d, user, query, project) => {
  const res = await senseResonance(d, deps.redis(), user, { query, project, action: "agent" });
  return renderMindResonanceMarkdown(res);
});
const app = createApp(deps);
const busts = listenForBusts(settings.redisUrl);
await cluster.start(settings.redisUrl);
startScheduledTaskRunner(db);
startDynamicScenarioReloader(db);
scheduler.start(deps);
if (settings.enableScheduler) {
  startProactivePulse(deps);
  startPlanRunner(deps);
}

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
  stopDynamicScenarioReloader();
  stopProactivePulse();
  scheduler.stop();
  await Promise.allSettled([askRuns.drain(), stopPlanRunner(), stopScheduledTaskRunner(), cluster.stop(), sql.end({ timeout: 10 }), closeRedis(), busts?.quit()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
