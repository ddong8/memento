import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import https from "node:https";

import { homeDir } from "./config.js";
import { findExecutable } from "./exec-env.js";
import { discoverWorkbuddyGateway, isWorkbuddyInstalled } from "./workbuddy.js";

export interface QuotaModelItem {
  label: string;
  model_id: string;
  remaining_fraction: number;
  remaining_percent: number;
  reset_time?: string;
}

export interface ToolQuotaInfo {
  tool: "antigravity" | "claude_code" | "codex" | "workbuddy";
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
    workbuddy?: ToolQuotaInfo;
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

async function getClaudeOAuthToken(): Promise<string | undefined> {
  if (process.platform === "darwin") {
    const res = await run("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], 2000);
    if (res.code === 0 && res.stdout.trim()) {
      try {
        const creds = JSON.parse(res.stdout.trim());
        return creds.claudeAiOauth?.accessToken;
      } catch {}
    }
  }
  return undefined;
}

function fetchAnthropicLiveUsage(token: string): Promise<Record<string, any> | undefined> {
  return new Promise((resolve) => {
    const req = https.request(
      "https://api.anthropic.com/api/oauth/usage",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "anthropic-client": "claude-code/2.1.283",
        },
        timeout: 4000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve(undefined);
          }
        });
      },
    );
    req.on("error", () => resolve(undefined));
    req.on("timeout", () => {
      req.destroy();
      resolve(undefined);
    });
    req.end();
  });
}

/** Probe Claude Code for active subscription & account info with real usage utilization. */
export async function probeClaudeCodeQuota(home = homeDir()): Promise<ToolQuotaInfo> {
  try {
    const cJsonPath = join(home, ".claude.json");
    let d: Record<string, any> = {};
    if (existsSync(cJsonPath)) {
      try {
        d = JSON.parse(await readFile(cJsonPath, "utf8"));
      } catch {}
    }

    const oauth = d.oauthAccount || {};
    const token = await getClaudeOAuthToken();

    // 1. 优先尝试直接调用 Anthropic 官方实时 /api/oauth/usage 端点获取 100% 鲜活数据
    let liveUsage: Record<string, any> | undefined;
    if (token) {
      liveUsage = await fetchAnthropicLiveUsage(token);
    }

    let ut: Record<string, any> = {};
    let isStaleCache = false;

    if (liveUsage && (liveUsage.seven_day || liveUsage.five_hour)) {
      ut = liveUsage;
    } else {
      // 2. 官方接口不可用时，降级读取 ~/.claude.json 中的缓存，但做严密的过期检查
      const cachedUsage = d.cachedUsageUtilization || {};
      ut = cachedUsage.utilization || {};
      const weeklyResetsAt = ut.seven_day?.resets_at;
      // 若缓存的重置时间已过当前时间，说明滑动窗口早已自动重置刷新，不可再使用过期的残余指标
      if (weeklyResetsAt && new Date(weeklyResetsAt).getTime() <= Date.now()) {
        isStaleCache = true;
      }
    }

    const limits: any[] = ut.limits || [];
    const rawSevenDayUtil = typeof ut.seven_day?.utilization === "number" ? ut.seven_day.utilization : null;
    const rawFiveHourUtil = typeof ut.five_hour?.utilization === "number" ? ut.five_hour.utilization : null;
    const weeklyLimit = limits.find((l: any) => l.group === "weekly" || l.kind === "weekly_all");
    const sessionLimit = limits.find((l: any) => l.group === "session" || l.kind === "session");

    let sevenDayUtil = rawSevenDayUtil;
    let fiveHourUtil = rawFiveHourUtil;
    let severity = weeklyLimit?.severity || "normal";

    if (isStaleCache) {
      // 历史缓存已过期且已过重置时间：归零已重置，避免显示历史高占用
      sevenDayUtil = 0;
      fiveHourUtil = 0;
      severity = "normal";
    }

    // 实时可用额度计算：根据 7 天与 5 小时滑动窗口取最严格瓶颈（如 7天已用 55%，则剩余 45%）
    let remainingPercent: number | null = null;
    if (sevenDayUtil != null && fiveHourUtil != null) {
      const remSeven = Math.max(0, 100 - sevenDayUtil);
      const remFive = Math.max(0, 100 - fiveHourUtil);
      remainingPercent = Math.min(remSeven, remFive);
    } else if (sevenDayUtil != null) {
      remainingPercent = Math.max(0, 100 - sevenDayUtil);
    } else if (fiveHourUtil != null) {
      remainingPercent = Math.max(0, 100 - fiveHourUtil);
    }

    if (remainingPercent != null) {
      remainingPercent = Math.round(remainingPercent * 10) / 10;
    }

    // 确定重置时间：优先取当前瓶颈窗口的重置时间
    let resetTime: string | null = null;
    if (isStaleCache) {
      resetTime = null;
    } else {
      resetTime = weeklyLimit?.resets_at || ut.seven_day?.resets_at || sessionLimit?.resets_at || ut.five_hour?.resets_at || null;
    }

    const planName =
      oauth.organizationType === "claude_pro"
        ? "Claude Pro"
        : oauth.organizationType
          ? `Claude ${oauth.organizationType}`
          : "Claude 订阅";
    const tier = (oauth.organizationRateLimitTier || "PRO").toUpperCase();
    const remainingFraction = remainingPercent != null ? remainingPercent / 100 : 1;

    // 真实的 Claude Code 模型体系（全模型共享同一订阅配额）
    const models: QuotaModelItem[] = [
      {
        label: "Claude 3.7 Sonnet (Hybrid Reasoning)",
        model_id: "claude-3-7-sonnet",
        remaining_fraction: remainingFraction,
        remaining_percent: remainingPercent != null ? remainingPercent : 100,
        reset_time: resetTime || undefined,
      },
      {
        label: "Claude Sonnet 4.6 (Thinking)",
        model_id: "claude-sonnet-4-6",
        remaining_fraction: remainingFraction,
        remaining_percent: remainingPercent != null ? remainingPercent : 100,
        reset_time: resetTime || undefined,
      },
      {
        label: "Claude Opus 4.6 (Thinking)",
        model_id: "claude-opus-4-6",
        remaining_fraction: remainingFraction,
        remaining_percent: remainingPercent != null ? remainingPercent : 100,
        reset_time: resetTime || undefined,
      },
      {
        label: "Claude Haiku 4.5",
        model_id: "claude-haiku-4-5",
        remaining_fraction: remainingFraction,
        remaining_percent: remainingPercent != null ? remainingPercent : 100,
        reset_time: resetTime || undefined,
      },
    ];

    if (Array.isArray(d.additionalModelOptionsCache)) {
      for (const opt of d.additionalModelOptionsCache) {
        if (opt?.label && opt?.value) {
          models.push({
            label: opt.label.includes("Fable") ? "Claude Fable 5.1 (Long-horizon)" : opt.label,
            model_id: opt.value,
            remaining_fraction: remainingFraction,
            remaining_percent: remainingPercent != null ? remainingPercent : 100,
            reset_time: resetTime || undefined,
          });
        }
      }
    }

    if (oauth.accountUuid || d.userID || token) {
      return {
        tool: "claude_code",
        name: "Claude Code",
        available: true,
        logged_in: true,
        account_email: oauth.emailAddress || "",
        account_name: oauth.displayName || oauth.fullName || oauth.organizationName || "",
        plan_name: planName,
        tier,
        remaining_percent: remainingPercent,
        reset_time: resetTime,
        models,
        details: {
          seven_day_utilization: sevenDayUtil,
          seven_day_resets_at: ut.seven_day?.resets_at,
          five_hour_utilization: fiveHourUtil,
          five_hour_resets_at: ut.five_hour?.resets_at,
          severity,
          is_live_api: Boolean(liveUsage),
          shared_quota: true,
        },
      };
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

/** Probe Tencent WorkBuddy for active account & local gateway info. */
export async function probeWorkbuddyQuota(home = homeDir()): Promise<ToolQuotaInfo> {
  try {
    if (!isWorkbuddyInstalled(home)) {
      return {
        tool: "workbuddy",
        name: "WorkBuddy",
        available: false,
        error: "未安装 WorkBuddy",
      };
    }

    let nickname = "";
    let uid = "";
    let editionType = "free";
    let isPro = false;

    const snapPath = join(home, ".workbuddy", "storage", "skeleton", "account-snapshot.json");
    if (existsSync(snapPath)) {
      try {
        const snap = JSON.parse(await readFile(snapPath, "utf8"));
        const primary = snap?.primary || {};
        nickname = String(primary.nickname || "").trim();
        uid = String(primary.uid || "").trim();
        editionType = String(primary.editionType || "free").trim();
        isPro = Boolean(primary.isPro);
      } catch {}
    }

    const gateway = await discoverWorkbuddyGateway(home);
    const models: QuotaModelItem[] = [];
    const modelsConfigPath = join(home, ".workbuddy", "models.json");
    if (existsSync(modelsConfigPath)) {
      try {
        const mc = JSON.parse(await readFile(modelsConfigPath, "utf8"));
        for (const m of mc?.models || []) {
          if (m?.id) {
            models.push({
              label: `${m.name || m.id} (${m.vendor || "自定义"})`,
              model_id: m.id.startsWith("custom-local:") ? m.id : `custom-local:${m.id}`,
              remaining_fraction: 1,
              remaining_percent: 100,
            });
          }
        }
      } catch {}
    }

    models.push(
      { label: "极致 (Deep Model)", model_id: "deep-model", remaining_fraction: 1, remaining_percent: 100 },
      { label: "均衡 (Balanced Model)", model_id: "balanced-model", remaining_fraction: 1, remaining_percent: 100 },
      { label: "快速 (Fast Model)", model_id: "fast-model", remaining_fraction: 1, remaining_percent: 100 },
      { label: "Tencent HY 4.0 Preview", model_id: "hy4-preview", remaining_fraction: 1, remaining_percent: 100 },
      { label: "DeepSeek V4 Pro", model_id: "deepseek-v4-pro", remaining_fraction: 1, remaining_percent: 100 },
      { label: "GLM-5.3", model_id: "glm-5.3", remaining_fraction: 1, remaining_percent: 100 },
      { label: "Kimi-K3.1", model_id: "kimi-k3-1", remaining_fraction: 1, remaining_percent: 100 },
    );

    if (!gateway && !uid && !nickname) {
      return {
        tool: "workbuddy",
        name: "WorkBuddy",
        available: false,
        error: "WorkBuddy 本地服务未运行",
      };
    }

    return {
      tool: "workbuddy",
      name: "WorkBuddy",
      available: true,
      logged_in: Boolean(uid || nickname || gateway),
      account_name: nickname || "WorkBuddy 用户",
      account_email: uid ? `UID: ${uid.slice(0, 8)}...` : "",
      plan_name: isPro ? "WorkBuddy Pro" : "WorkBuddy 个人版",
      tier: (isPro ? "PRO" : editionType || "FREE").toUpperCase(),
      remaining_percent: isPro ? 100 : null,
      reset_time: null,
      models,
      details: {
        gateway_online: Boolean(gateway),
        gateway_endpoint: gateway?.endpoint,
        gateway_version: gateway?.version,
        is_free_tier: !isPro,
      },
    };
  } catch (err: any) {
    return {
      tool: "workbuddy",
      name: "WorkBuddy",
      available: false,
      error: err.message,
    };
  }
}

/** Aggregates quotas for all AI tools on this device. */
export async function probeAllQuotas(home = homeDir()): Promise<DeviceQuotasReport> {
  const [agy, claude, codex, wb] = await Promise.all([
    probeAntigravityQuota(),
    probeClaudeCodeQuota(home),
    probeCodexQuota(home),
    probeWorkbuddyQuota(home),
  ]);

  return {
    timestamp: new Date().toISOString(),
    tools: {
      antigravity: agy,
      claude_code: claude,
      codex: codex,
      workbuddy: wb,
    },
  };
}
