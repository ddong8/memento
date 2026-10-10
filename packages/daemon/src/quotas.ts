import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import ssl from "node:tls";
import https from "node:https";

import { homeDir } from "./config.js";
import { findExecutable } from "./exec-env.js";

export interface QuotaModelItem {
  label: string;
  model_id: string;
  remaining_fraction: number;
  remaining_percent: number;
  reset_time?: string;
}

export interface ToolQuotaInfo {
  tool: "antigravity" | "claude_code" | "codex";
  name: string;
  available: boolean;
  logged_in?: boolean;
  account_email?: string;
  account_name?: string;
  plan_name?: string;
  tier?: string;
  remaining_percent?: number | null;
  reset_time?: string | null;
  models?: QuotaModelItem[];
  error?: string;
}

export interface DeviceQuotasReport {
  device_id?: string;
  device_name?: string;
  timestamp: string;
  tools: {
    antigravity?: ToolQuotaInfo;
    claude_code?: ToolQuotaInfo;
    codex?: ToolQuotaInfo;
  };
}

function run(cmd: string, args: string[], timeout = 6000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve({ code: err ? 1 : 0, stdout: String(stdout || "") }),
    );
  });
}

/** Probe Antigravity Language Server for live user quotas. */
export async function probeAntigravityQuota(): Promise<ToolQuotaInfo> {
  try {
    let pid: string | undefined;
    let csrf: string | undefined;

    if (process.platform === "darwin" || process.platform === "linux") {
      const psRes = await run("ps", ["-eo", "pid,command"], 4000);
      for (const line of psRes.stdout.split("\n")) {
        if (line.includes("language_server") && line.includes("antigravity") && !line.includes("grep")) {
          pid = /^\s*(\d+)/.exec(line)?.[1];
          csrf = /--csrf_token\s+(\S+)/.exec(line)?.[1];
          break;
        }
      }
    }

    if (!pid || !csrf) {
      return {
        tool: "antigravity",
        name: "Google Antigravity",
        available: false,
        error: "Antigravity 服务未运行",
      };
    }

    let ports: number[] = [];
    if (process.platform === "darwin" || process.platform === "linux") {
      const lsofRes = await run("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pid], 3000);
      for (const line of lsofRes.stdout.split("\n")) {
        const m = /TCP\s+(?:127\.0\.0\.1|localhost|\*):(\d+)\s+\(LISTEN\)/.exec(line);
        if (m) ports.push(parseInt(m[1]!, 10));
      }
    }

    for (const port of ports) {
      try {
        const raw = await new Promise<string>((resolve, reject) => {
          const req = https.request(
            {
              hostname: "127.0.0.1",
              port,
              path: "/exa.language_server_pb.LanguageServerService/GetUserStatus",
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-codeium-csrf-token": csrf,
              },
              rejectUnauthorized: false,
              timeout: 3000,
            },
            (res) => {
              let buf = "";
              res.on("data", (c) => (buf += c));
              res.on("end", () => resolve(buf));
            },
          );
          req.on("error", reject);
          req.on("timeout", () => {
            req.destroy();
            reject(new Error("timeout"));
          });
          req.write("{}");
          req.end();
        });

        const data = JSON.parse(raw);
        const us = data.userStatus;
        if (!us) continue;

        const rawModels: any[] = us.cascadeModelConfigData?.clientModelConfigs || [];
        const models: QuotaModelItem[] = [];
        for (const m of rawModels) {
          const qi = m.quotaInfo;
          if (qi && typeof qi.remainingFraction === "number") {
            models.push({
              label: m.label || m.modelId || "Model",
              model_id: m.modelId || "",
              remaining_fraction: qi.remainingFraction,
              remaining_percent: Math.round(qi.remainingFraction * 1000) / 10,
              reset_time: qi.resetTime,
            });
          }
        }

        const primary = models[0];
        return {
          tool: "antigravity",
          name: "Google Antigravity",
          available: true,
          logged_in: true,
          account_name: us.name || "Google 用户",
          account_email: us.email || "",
          plan_name: us.userTier?.name || us.planStatus?.planInfo?.planName || "Google AI Pro",
          tier: us.planStatus?.planInfo?.teamsTier || "PRO",
          remaining_percent: primary ? primary.remaining_percent : 100,
          reset_time: primary ? primary.reset_time : null,
          models,
        };
      } catch {
        // next port
      }
    }

    return {
      tool: "antigravity",
      name: "Google Antigravity",
      available: false,
      error: "无法连接 Antigravity 语言服务端口",
    };
  } catch (err: any) {
    return {
      tool: "antigravity",
      name: "Google Antigravity",
      available: false,
      error: err.message,
    };
  }
}

/** Probe Claude Code for active subscription & account info. */
export async function probeClaudeCodeQuota(home = homeDir()): Promise<ToolQuotaInfo> {
  try {
    const claudeBin = await findExecutable(["claude", "claude-code"]);
    if (claudeBin) {
      const res = await run(claudeBin, ["auth", "status"], 4000);
      if (res.code === 0 && res.stdout.includes("{")) {
        try {
          const parsed = JSON.parse(res.stdout);
          const subType = (parsed.subscriptionType || "pro").toUpperCase();
          return {
            tool: "claude_code",
            name: "Claude Code",
            available: true,
            logged_in: Boolean(parsed.loggedIn),
            account_email: parsed.email || "",
            account_name: parsed.orgName || parsed.email || "",
            plan_name: `Claude ${subType}`,
            tier: subType,
            remaining_percent: parsed.loggedIn ? 100 : 0,
            reset_time: null,
            models: [
              { label: "Claude Sonnet 4.6 (Thinking)", model_id: "claude-sonnet-4-6", remaining_fraction: 1, remaining_percent: 100 },
              { label: "Claude Opus 4.6", model_id: "claude-opus-4-6", remaining_fraction: 1, remaining_percent: 100 },
              { label: "Claude Haiku 4.5", model_id: "claude-haiku-4-5", remaining_fraction: 1, remaining_percent: 100 },
            ],
          };
        } catch {}
      }
    }

    // Fallback: inspect ~/.claude.json
    const cJsonPath = join(home, ".claude.json");
    if (existsSync(cJsonPath)) {
      const raw = await readFile(cJsonPath, "utf8");
      const d = JSON.parse(raw);
      return {
        tool: "claude_code",
        name: "Claude Code",
        available: true,
        logged_in: true,
        account_email: d.email || "",
        plan_name: "Claude Pro",
        tier: "PRO",
        remaining_percent: 100,
        models: [
          { label: "Claude Sonnet 4.6 (Thinking)", model_id: "claude-sonnet-4-6", remaining_fraction: 1, remaining_percent: 100 },
          { label: "Claude Opus 4.6", model_id: "claude-opus-4-6", remaining_fraction: 1, remaining_percent: 100 },
          { label: "Claude Haiku 4.5", model_id: "claude-haiku-4-5", remaining_fraction: 1, remaining_percent: 100 },
        ],
      };
    }

    return {
      tool: "claude_code",
      name: "Claude Code",
      available: false,
      error: "未检测到 Claude Code 登录凭据",
    };
  } catch (err: any) {
    return {
      tool: "claude_code",
      name: "Claude Code",
      available: false,
      error: err.message,
    };
  }
}

/** Probe OpenAI Codex for active subscription & account info. */
export async function probeCodexQuota(home = homeDir()): Promise<ToolQuotaInfo> {
  try {
    const authPath = join(home, ".codex", "auth.json");
    if (existsSync(authPath)) {
      const raw = await readFile(authPath, "utf8");
      const d = JSON.parse(raw);
      const token = d.tokens?.id_token || d.tokens?.access_token;
      let email = "";
      let name = "";
      let planType = "Free";

      if (token && token.includes(".")) {
        try {
          const parts = token.split(".");
          let b64 = parts[1]!;
          b64 += "=".repeat((4 - (b64.length % 4)) % 4);
          const claims = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
          email = claims.email || "";
          name = claims.name || "";
          const authInfo = claims["https://api.openai.com/auth"];
          if (authInfo && authInfo.chatgpt_plan_type) {
            planType = authInfo.chatgpt_plan_type;
          }
        } catch {}
      }

      const planDisplay = planType.charAt(0).toUpperCase() + planType.slice(1);
      return {
        tool: "codex",
        name: "OpenAI Codex",
        available: true,
        logged_in: true,
        account_email: email,
        account_name: name || email,
        plan_name: `ChatGPT ${planDisplay}`,
        tier: planType.toUpperCase(),
        remaining_percent: 100,
        models: [
          { label: "GPT-5 (Codex Reasoning)", model_id: "gpt-5-codex", remaining_fraction: 1, remaining_percent: 100 },
          { label: "GPT-5 mini", model_id: "gpt-5-mini", remaining_fraction: 1, remaining_percent: 100 },
          { label: "o3-mini (High Effort)", model_id: "o3-mini", remaining_fraction: 1, remaining_percent: 100 },
        ],
      };
    }

    return {
      tool: "codex",
      name: "OpenAI Codex",
      available: false,
      error: "未找到 Codex 授权凭据",
    };
  } catch (err: any) {
    return {
      tool: "codex",
      name: "OpenAI Codex",
      available: false,
      error: err.message,
    };
  }
}

/** Aggregates quotas for all three AI tools on this device. */
export async function probeAllQuotas(home = homeDir()): Promise<DeviceQuotasReport> {
  const [agy, claude, codex] = await Promise.all([
    probeAntigravityQuota(),
    probeClaudeCodeQuota(home),
    probeCodexQuota(home),
  ]);

  return {
    timestamp: new Date().toISOString(),
    tools: {
      antigravity: agy,
      claude_code: claude,
      codex: codex,
    },
  };
}
