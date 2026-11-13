import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { parseNetstatListeningPorts, parseWindowsLanguageServer, refreshAntigravityMcpServers, WINDOWS_LS_REPORT } from "../src/antigravity.js";

const powershell = ["pwsh", "powershell"].find((exe) => spawnSync(exe, ["-NoProfile", "-Command", "exit 0"]).status === 0);
import { isModelLimited } from "../src/model-limits.js";
import { probeAntigravityQuota } from "../src/quotas.js";

describe("Antigravity language server on Windows", () => {
  it("reads the process, its CSRF token and listening ports from the PowerShell query", () => {
    const stdout =
      "\uFEFF" +
      JSON.stringify({
        ProcessId: 4321,
        ExecutablePath: "C:\\Users\\张三\\AppData\\Local\\Programs\\Antigravity\\resources\\bin\\language_server.exe",
        CommandLine:
          '"C:\\Users\\张三\\AppData\\Local\\Programs\\Antigravity\\resources\\bin\\language_server.exe" --standalone --override_ide_name antigravity --csrf_token abc-123 --app_data_dir antigravity',
        Ports: "51234,51235",
      }) +
      "\r\n";
    expect(parseWindowsLanguageServer(stdout)).toEqual({
      pid: "4321",
      csrf: "abc-123",
      binary: "C:\\Users\\张三\\AppData\\Local\\Programs\\Antigravity\\resources\\bin\\language_server.exe",
      ports: [51234, 51235],
    });
  });

  it.skipIf(!powershell)("prints the process as ASCII-only JSON that round-trips a Chinese user folder", () => {
    const binary = "C:\\Users\\张三😀\\AppData\\Local\\Programs\\Antigravity\\resources\\bin\\language_server.exe";
    const fake =
      `$p = [pscustomobject]@{ ProcessId = 4321; ExecutablePath = '${binary}'; ` +
      `CommandLine = '"${binary}" --override_ide_name antigravity --csrf_token abc-123' }; `;
    const out = execFileSync(powershell!, ["-NoProfile", "-NonInteractive", "-Command", fake + WINDOWS_LS_REPORT], { encoding: "utf8" });
    expect(/^[\x00-\x7F]*$/.test(out)).toBe(true);
    // No Get-NetTCPConnection here: ports are left to the netstat fallback
    expect(parseWindowsLanguageServer(out)).toEqual({ pid: "4321", csrf: "abc-123", binary, ports: [] });
    expect(execFileSync(powershell!, ["-NoProfile", "-NonInteractive", "-Command", "$p = $null; " + WINDOWS_LS_REPORT], { encoding: "utf8" })).toBe("");
  }, 30_000); // a cold PowerShell start takes seconds on a shared CI runner

  it("finds nothing when Antigravity isn't running", () => {
    expect(parseWindowsLanguageServer("")).toEqual({ ports: [] });
    expect(parseWindowsLanguageServer("Get-CimInstance : Access denied")).toEqual({ ports: [] });
  });

  it("takes only the server's own listening ports from netstat, in any Windows language", () => {
    const netstat = [
      "",
      "活动连接",
      "",
      "  协议  本地地址          外部地址        状态           PID",
      "  TCP    127.0.0.1:51234        0.0.0.0:0              LISTENING       123",
      "  TCP    127.0.0.1:51235        0.0.0.0:0              ABHÖREN         123",
      "  TCP    [::1]:51236            [::]:0                 LISTENING       123",
      "  TCP    127.0.0.1:51234        127.0.0.1:60000        ESTABLISHED     123",
      "  TCP    127.0.0.1:12399        0.0.0.0:0              LISTENING       1234",
      "  TCP    127.0.0.1:61230        0.0.0.0:0              LISTENING       9123",
      "  UDP    0.0.0.0:123            *:*                                    123",
    ].join("\r\n");
    expect(parseNetstatListeningPorts(netstat, "123")).toEqual([51234, 51235, 51236]);
  });
});

describe("Antigravity quota", () => {
  const csrf = "token-ok";
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url !== "/exa.language_server_pb.LanguageServerService/GetUserStatus" || req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      if (req.headers["x-codeium-csrf-token"] !== csrf) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          userStatus: {
            name: "Test User",
            email: "test@example.com",
            userTier: { name: "Google AI Pro" },
            planStatus: { planInfo: { teamsTier: "PRO" } },
            cascadeModelConfigData: {
              clientModelConfigs: [
                { label: "Gemini 3.8 Flash", modelId: "flash", quotaInfo: { remainingFraction: 0.42, resetTime: "2026-10-29T00:00:00Z" } },
                { label: "Gemini 3.8 Pro", modelId: "pro", quotaInfo: { remainingFraction: 1 } },
                { label: "Unmetered", modelId: "free" },
                // Spent: proto3 JSON leaves the 0 fraction out, only the reset time is there (11-12 Gemini 4 Argon)
                { label: "Gemini 4 Argon (Medium)", modelId: "gemini-4-argon-medium", quotaInfo: { resetTime: "2099-01-01T00:00:00Z" } },
                { label: "Gemini 4 Carbon", modelId: "gemini-4-carbon-disabled", disabled: true, quotaInfo: {} },
              ],
            },
          },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("reads per-model quotas from the server the lookup found", async () => {
    const quota = await probeAntigravityQuota(async () => ({ port, csrf }));
    expect(quota.available).toBe(true);
    expect(quota.account_email).toBe("test@example.com");
    expect(quota.remaining_percent).toBe(42);
    expect(quota.models?.map((m) => [m.model_id, m.remaining_percent])).toEqual([
      ["flash", 42],
      ["pro", 100],
      ["free", null],
      ["gemini-4-argon-medium", 0],
    ]);
    // The spent model is skipped by later runs until it resets
    expect(isModelLimited("antigravity", "gemini-4-argon-high")).toBe(true);
    expect(isModelLimited("antigravity", "flash")).toBe(false);
  });

  it("looks the server up again when the remembered one stops answering", async () => {
    const calls: unknown[] = [];
    const quota = await probeAntigravityQuota(async (options) => {
      calls.push(options);
      return options?.forceRefresh ? { port, csrf } : { port, csrf: "rotated" };
    });
    expect(calls).toEqual([undefined, { forceRefresh: true }]);
    expect(quota.available).toBe(true);
  });

  it("says the service isn't running when there is no language server", async () => {
    const quota = await probeAntigravityQuota(async () => undefined, async () => undefined);
    expect(quota).toMatchObject({ available: false, error: "Antigravity 本地服务未运行" });
  });

  it("reads quotas through the agy CLI's login when the app isn't running", async () => {
    const quota = await probeAntigravityQuota(async () => undefined, async () => ({
      tool: "antigravity",
      name: "Google Antigravity",
      available: true,
      remaining_percent: 100,
      probe_source: "agy 命令行登录",
    }));
    expect(quota).toMatchObject({ available: true, remaining_percent: 100, probe_source: "agy 命令行登录" });
  });
});

describe("Antigravity MCP reload", () => {
  const csrf = "token-ok";
  let server: Server;
  let port: number;
  let refreshed = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url !== "/exa.language_server_pb.LanguageServerService/RefreshMcpServers" || req.method !== "POST") return void res.writeHead(404).end();
      if (req.headers["x-codeium-csrf-token"] !== csrf) return void res.writeHead(401).end();
      refreshed++;
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("asks the running app to load its MCP config again, looking it up afresh when the remembered token is stale", async () => {
    expect(await refreshAntigravityMcpServers(async () => ({ port, csrf }))).toBe(true);
    const calls: unknown[] = [];
    expect(
      await refreshAntigravityMcpServers(async (options) => {
        calls.push(options);
        return options?.forceRefresh ? { port, csrf } : { port, csrf: "rotated" };
      }),
    ).toBe(true);
    expect(calls).toEqual([undefined, { forceRefresh: true }]);
    expect(refreshed).toBe(2);
  });

  it("does nothing when the app isn't running", async () => {
    const calls: unknown[] = [];
    expect(await refreshAntigravityMcpServers(async (options) => (calls.push(options), undefined))).toBe(false);
    expect(calls).toEqual([undefined]);
  });
});
