#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { RemoteClient } from "./remote.js";
import { createServer } from "./server.js";

/**
 * memento-mcp: Memento memory for AI tools over stdio.
 *
 *   memento-mcp                              server URL and device token from ~/.memento/collector.json
 *   memento-mcp --server URL --token TOKEN   a collector token or a JWT
 *
 * MEMENTO_SERVER_URL / MEMENTO_SERVER_TOKEN / MEMENTO_COLLECTOR_CONFIG work too.
 */
/**
 * Where the Memento app keeps this device's sign-in. The same home as the daemon's (packages/daemon
 * config.ts): on Windows USERPROFILE, since a HOME set by Git Bash or MSYS points somewhere else;
 * on macOS the real home also from inside an app sandbox.
 */
export function collectorConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.MEMENTO_COLLECTOR_CONFIG) return env.MEMENTO_COLLECTOR_CONFIG;
  let home = platform === "win32" ? env.USERPROFILE || env.HOME || homedir() : env.HOME || homedir();
  if (platform === "darwin" && home.includes("/Library/Containers/")) home = home.split("/Library/Containers/")[0] || home;
  return join(home, ".memento", "collector.json");
}

const configPath = () => collectorConfigPath();

async function readCollectorConfig(): Promise<{ server?: string; token?: string }> {
  try {
    const data = JSON.parse(await readFile(configPath(), "utf8")) as { server_url?: string; token?: string };
    return { server: data.server_url || undefined, token: data.token || undefined };
  } catch {
    return {};
  }
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq?.slice(name.length + 1);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const cfg = await readCollectorConfig();
  const server = flag(argv, "--server") || process.env.MEMENTO_SERVER_URL || cfg.server || "https://mem.ihasy.com";
  const token = flag(argv, "--token") || process.env.MEMENTO_SERVER_TOKEN || cfg.token;
  if (!token) {
    console.error("memento-mcp: no token. Sign in with the Memento app (it writes ~/.memento/collector.json), or pass --server URL --token TOKEN.");
    process.exit(1);
  }
  const remote = new RemoteClient(server, token, async () => (await readCollectorConfig()).token);
  const mcp = createServer(remote);
  await mcp.connect(new StdioServerTransport());
}

const invoked = (() => {
  if (process.env.MEMENTO_MCP_EMBEDDED) return false;
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
