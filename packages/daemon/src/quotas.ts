import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
  details?: Record<string, unknown>;
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
        error: "Antigravity 本地服务未运行",
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
            const fraction = Math.max(0, Math.min(1, qi.remainingFraction));
            models.push({
              label: m.label || m.modelId || "Model",
              model_id: m.modelId || "",
              remaining_fraction: fraction,
              remaining_percent: Math.round(fraction * 1000) / 10,
              reset_time: qi.resetTime,
            });
          }
        }

        // 确定主力模型的真实剩余配额：优先选择推荐模型或最常用的 Flash/Pro 模型
        let primary = models.find((m) => m.label.includes("3.8 Flash") || m.label.includes("Flash (Medium)"));
        if (!primary) primary = models[0];

        const planStatus = us.planStatus || {};
        const planInfo = planStatus.planInfo || {};

        return {
          tool: "antigravity",
          name: "Google Antigravity",
          available: true,
          logged_in: true,
          account_name: us.name || "Google 用户",
          account_email: us.email || "",
          plan_name: us.userTier?.name || planInfo.planName || "Google AI Pro",
          tier: planInfo.teamsTier || "PRO",
          remaining_percent: primary ? primary.remaining_percent : null,
          reset_time: primary ? primary.reset_time : null,
          models,
          details: {
            available_prompt_credits: planStatus.availablePromptCredits,
            monthly_prompt_credits: planInfo.monthlyPromptCredits,
            available_flow_credits: planStatus.availableFlowCredits,
            monthly_flow_credits: planInfo.monthlyFlowCredits,
          },
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

/** Probe Claude Code for active subscription & account info with real usage utilization. */
export async function probeClaudeCodeQuota(home = homeDir()): Promise<ToolQuotaInfo> {
  try {
    const cJsonPath = join(home, ".claude.json");
    if (existsSync(cJsonPath)) {
      try {
        const raw = await readFile(cJsonPath, "utf8");
        const d = JSON.parse(raw);
        const oauth = d.oauthAccount || {};
        const usage = d.cachedUsageUtilization || {};
        const ut = usage.utilization || {};
        const limits: any[] = ut.limits || [];

        const sevenDayUtil = typeof ut.seven_day?.utilization === "number" ? ut.seven_day.utilization : null;
        const fiveHourUtil = typeof ut.five_hour?.utilization === "number" ? ut.five_hour.utilization : null;
        const weeklyLimit = limits.find((l: any) => l.group === "weekly" || l.kind === "weekly_all");
        const sessionLimit = limits.find((l: any) => l.group === "session" || l.kind === "session");

        // 真实剩余额度计算：依据最严格的滑动窗口用量（如7天消耗97%，则剩余3%）
        let remainingPercent: number | null = null;
        if (sevenDayUtil != null) {
          remainingPercent = Math.max(0, Math.min(100, Math.round((100 - sevenDayUtil) * 10) / 10));
        } else if (fiveHourUtil != null) {
          remainingPercent = Math.max(0, Math.min(100, Math.round((100 - fiveHourUtil) * 10) / 10));
        }

        const resetTime = weeklyLimit?.resets_at || ut.seven_day?.resets_at || sessionLimit?.resets_at || null;
        const planName =
          oauth.organizationType === "claude_pro"
            ? "Claude Pro"
            : oauth.organizationType
              ? `Claude ${oauth.organizationType}`
              : "Claude 订阅";
        const tier = (oauth.organizationRateLimitTier || "PRO").toUpperCase();

        const fraction = remainingPercent != null ? remainingPercent / 100 : 1;
        const models: QuotaModelItem[] = [
          {
            label: "Claude Sonnet 4.6 (Thinking)",
            model_id: "claude-sonnet-4-6",
            remaining_fraction: fraction,
            remaining_percent: remainingPercent != null ? remainingPercent : 100,
            reset_time: resetTime,
          },
          {
            label: "Claude Opus 4.6",
            model_id: "claude-opus-4-6",
            remaining_fraction: fraction,
            remaining_percent: remainingPercent != null ? remainingPercent : 100,
            reset_time: resetTime,
          },
          {
            label: "Claude Haiku 4.5",
            model_id: "claude-haiku-4-5",
            remaining_fraction: 1,
            remaining_percent: 100,
          },
        ];

        return {
          tool: "claude_code",
          name: "Claude Code",
          available: true,
          logged_in: Boolean(oauth.accountUuid || d.userID),
          account_email: oauth.emailAddress || "",
          account_name: oauth.displayName || oauth.fullName || oauth.organizationName || "",
          plan_name: planName,
          tier,
          remaining_percent: remainingPercent,
          reset_time: resetTime,
          models,
          details: {
            seven_day_utilization: sevenDayUtil,
            five_hour_utilization: fiveHourUtil,
            severity: weeklyLimit?.severity || "normal",
            has_available_subscription: d.hasAvailableSubscription,
          },
        };
      } catch (err: any) {
        // fallback to CLI probe
      }
    }

    const claudeBin = await findExecutable(["claude", "claude-code"]);
    if (claudeBin) {
      const res = await run(claudeBin, ["auth", "status"], 4000);
      if (res.code === 0 && res.stdout.includes("{")) {
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
          remaining_percent: null,
          models: [
            { label: "Claude Sonnet 4.6 (Thinking)", model_id: "claude-sonnet-4-6", remaining_fraction: 1, remaining_percent: 100 },
            { label: "Claude Opus 4.6", model_id: "claude-opus-4-6", remaining_fraction: 1, remaining_percent: 100 },
          ],
        };
      }
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

      // 从真实 models_cache.json 提取模型清单
      const modelsCachePath = join(home, ".codex", "models_cache.json");
      const models: QuotaModelItem[] = [];
      if (existsSync(modelsCachePath)) {
        try {
          const mc = JSON.parse(await readFile(modelsCachePath, "utf8"));
          const rawModels = mc.models || [];
          for (const rm of rawModels) {
            const mId = rm.slug || rm.id || "";
            const mTitle = rm.title || rm.display_name || mId;
            if (mId) {
              models.push({
                label: mTitle,
                model_id: mId,
                remaining_fraction: 1,
                remaining_percent: 100,
              });
            }
          }
        } catch {}
      }

      const planDisplay = planType.charAt(0).toUpperCase() + planType.slice(1);
      const isFree = planType.toLowerCase() === "free";

      return {
        tool: "codex",
        name: "OpenAI Codex",
        available: true,
        logged_in: true,
        account_email: email,
        account_name: name || email || "OpenAI 用户",
        plan_name: `ChatGPT ${planDisplay}`,
        tier: planType.toUpperCase(),
        // Free 计划按动态速率轮转，无静态百分比，标记 null 避免虚报 100%
        remaining_percent: isFree ? null : 100,
        reset_time: null,
        models:
          models.length > 0
            ? models
            : [
                { label: "GPT-6 (Luna)", model_id: "gpt-6-luna", remaining_fraction: 1, remaining_percent: 100 },
                { label: "GPT-5.6 (Terra)", model_id: "gpt-5.6-terra", remaining_fraction: 1, remaining_percent: 100 },
              ],
        details: {
          is_free_tier: isFree,
        },
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
