import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import https from "node:https";

import { homeDir } from "./config.js";
import { executionEnvironment, findExecutable } from "./exec-env.js";
import { discoverWorkbuddyGateway, isWorkbuddyInstalled } from "./workbuddy.js";

export interface QuotaModelItem {
  label: string;
  model_id: string;
  remaining_fraction?: number | null;
  remaining_percent?: number | null;
  status_text?: string;
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
  quota_type?: "percentage" | "dynamic_rate_limit" | "token_payg" | "unlimited" | "gateway";
  quota_desc?: string;
  probe_source?: string;
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
            const pct = Math.round(fraction * 1000) / 10;
            models.push({
              label: m.label || m.modelId || "Model",
              model_id: m.modelId || "",
              remaining_fraction: fraction,
              remaining_percent: pct,
              status_text: pct === 100 ? "满额 (未消耗)" : `${pct}% 剩余`,
              reset_time: qi.resetTime,
            });
          } else {
            models.push({
              label: m.label || m.modelId || "Model",
              model_id: m.modelId || "",
              remaining_fraction: null,
              remaining_percent: null,
              status_text: "无配额限制",
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
          quota_type: "percentage",
          quota_desc: "Google AI Pro 阶梯算力池 (按模型计费)",
          probe_source: "本地 Language Server RPC",
          remaining_percent: primary?.remaining_percent ?? null,
          reset_time: primary?.reset_time ?? null,
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

/**
 * The keychain item Claude Code keeps its login in. A custom CLAUDE_CONFIG_DIR gets an item of its
 * own, suffixed with the first 8 hex chars of the dir's sha256 (as Claude Code itself names it).
 */
export function claudeCredentialService(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const dir = override !== undefined ? override : env.CLAUDE_CONFIG_DIR;
  if (!dir) return "Claude Code-credentials";
  return `Claude Code-credentials-${createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8)}`;
}

/** The keychain account Claude Code files its login under. */
export function claudeCredentialAccount(env: NodeJS.ProcessEnv = process.env): string {
  let name: string;
  try {
    name = env.USER || userInfo().username;
  } catch {
    return "claude-code-user";
  }
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : "claude-code-user";
}

/**
 * The access token in Claude Code's stored login, while it is still valid. Read only: an expired
 * token is left for Claude Code to refresh. Its refresh tokens are single use, so redeeming one
 * here would leave Claude Code holding a dead one and sign it out ("OAuth session expired and
 * could not be refreshed").
 */
export function usableClaudeAccessToken(creds: unknown, now = Date.now()): string | undefined {
  const oauth = (creds as { claudeAiOauth?: Record<string, unknown> } | null)?.claudeAiOauth;
  const token = oauth?.accessToken;
  if (typeof token !== "string" || !token) return undefined;
  const expiresAt = oauth?.expiresAt ?? oauth?.accessTokenExpiresAt;
  if (typeof expiresAt === "number" && expiresAt - 60_000 <= now) return undefined;
  return token;
}

async function readClaudeCredentials(env: NodeJS.ProcessEnv): Promise<unknown> {
  if (process.platform === "darwin") {
    const res = await run(
      "security",
      ["find-generic-password", "-a", claudeCredentialAccount(env), "-s", claudeCredentialService(env), "-w"],
      2000,
    );
    if (res.code === 0 && res.stdout.trim()) {
      try {
        return JSON.parse(res.stdout.trim());
      } catch {}
    }
  }
  // Linux and Windows, or a Mac without a usable keychain: Claude Code's plaintext store.
  const dir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR || join(homeDir(), ".claude");
  try {
    return JSON.parse(await readFile(join(dir, ".credentials.json"), "utf8"));
  } catch {
    return undefined;
  }
}

async function getClaudeOAuthToken(): Promise<string | undefined> {
  return usableClaudeAccessToken(await readClaudeCredentials(await executionEnvironment()));
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
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-client": "claude-code/2.1.283",
        },
        timeout: 4000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            resolve({ error: "unauthorized", statusCode: res.statusCode });
            return;
          }
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

/**
 * Claude Code's own model aliases: it resolves each one to the current version for the account's
 * provider and updates them over time (code.claude.com/docs/en/model-config), so no version is written here.
 */
const CLAUDE_MODEL_ALIASES: Array<{ label: string; model_id: string }> = [
  { label: "best（可用的最强模型）", model_id: "best" },
  { label: "opus（最新 Opus）", model_id: "opus" },
  { label: "sonnet（最新 Sonnet）", model_id: "sonnet" },
  { label: "haiku（Haiku）", model_id: "haiku" },
  { label: "opusplan（规划用 Opus，执行用 Sonnet）", model_id: "opusplan" },
];

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

    const sJsonPath = join(home, ".claude", "settings.json");
    let sJson: Record<string, any> = {};
    if (existsSync(sJsonPath)) {
      try {
        sJson = JSON.parse(await readFile(sJsonPath, "utf8"));
      } catch {}
    }

    const oauth = d.oauthAccount || {};
    const token = home === homeDir() ? await getClaudeOAuthToken() : undefined;

    // 1. 优先尝试直接调用 Anthropic 官方实时 /api/oauth/usage 端点获取 100% 鲜活数据
    let liveUsage: Record<string, any> | undefined;
    if (token) {
      liveUsage = await fetchAnthropicLiveUsage(token);
      if (liveUsage && (liveUsage.error === "unauthorized" || liveUsage.statusCode === 401)) {
        return {
          tool: "claude_code",
          name: "Claude Code",
          available: false,
          logged_in: false,
          account_email: oauth.accountEmailAddress,
          error: "Claude Code 登录已失效 (401 凭据过期)，请在终端运行 claude 重新登录",
        };
      }
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

    const sEnv = sJson.env || {};
    const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY || sEnv.ANTHROPIC_API_KEY || sEnv.ANTHROPIC_AUTH_TOKEN);
    const planName = hasApiKey
      ? (sEnv.ANTHROPIC_BASE_URL ? "Claude (网关/API 模式)" : "Claude (API Key 模式)")
      : oauth.billingType === "apple_subscription"
        ? "Claude Pro (Apple 订阅)"
        : oauth.billingType === "stripe_subscription"
          ? "Claude Pro (Stripe 订阅)"
          : oauth.organizationType === "claude_pro"
            ? "Claude Pro"
            : oauth.organizationType
              ? `Claude ${oauth.organizationType}`
              : "Claude 订阅";
    const tier = hasApiKey ? "API_KEY" : (oauth.organizationRateLimitTier || "PRO").toUpperCase();
    const remainingFraction = remainingPercent != null ? remainingPercent / 100 : null;

    // 真实的 Claude Code 模型体系（全模型共享同一订阅配额）
    const modelStatusText = hasApiKey
      ? "Token 计费可用"
      : remainingPercent != null
        ? `${remainingPercent}% 共享剩余`
        : "随账号限额 (正常可用)";

    const models: QuotaModelItem[] = [];

    // 动态提取 Claude CLI 本地缓存的真实模型选项 (例如 ~/.claude.json 中的 additionalModelOptionsCache)
    if (Array.isArray(d.additionalModelOptionsCache)) {
      for (const opt of d.additionalModelOptionsCache) {
        if (opt?.label && opt?.value && !models.some((m) => m.model_id === opt.value)) {
          const descClean = opt.description ? ` (${String(opt.description).split("·")[0]!.trim()})` : "";
          models.push({
            label: `${opt.label}${descClean}`,
            model_id: opt.value,
            remaining_fraction: remainingFraction,
            remaining_percent: remainingPercent,
            status_text: modelStatusText,
            reset_time: resetTime || undefined,
          });
        }
      }
    }

    // Claude Code 自带的别名，由它自己解析成该账号可用的当前版本，这里不写任何版本号
    for (const alias of CLAUDE_MODEL_ALIASES) {
      if (!models.some((m) => m.model_id === alias.model_id)) {
        models.push({
          ...alias,
          remaining_fraction: remainingFraction,
          remaining_percent: remainingPercent,
          status_text: modelStatusText,
          reset_time: resetTime || undefined,
        });
      }
    }

    // 本地 settings.json 配置的当前首选模型置顶高亮
    if (sJson.model) {
      const existingIdx = models.findIndex((m) => m.model_id === sJson.model);
      if (existingIdx !== -1) {
        const item = models.splice(existingIdx, 1)[0]!;
        models.unshift({
          ...item,
          label: `${item.label} (当前默认配置)`,
        });
      } else {
        models.unshift({
          label: `${sJson.model} (本地默认配置)`,
          model_id: sJson.model,
          remaining_fraction: remainingFraction,
          remaining_percent: remainingPercent,
          status_text: modelStatusText,
          reset_time: resetTime || undefined,
        });
      }
    }

    if (oauth.accountUuid || d.userID || token || hasApiKey) {
      return {
        tool: "claude_code",
        name: "Claude Code",
        available: true,
        logged_in: true,
        account_email: oauth.emailAddress || (hasApiKey ? "API_KEY 授权" : ""),
        account_name: oauth.displayName || oauth.fullName || oauth.organizationName || "",
        plan_name: planName,
        tier,
        quota_type: hasApiKey ? "token_payg" : "dynamic_rate_limit",
        quota_desc: hasApiKey
          ? "API Key 授权 (按 Token 计费，不设会话窗口限制)"
          : (remainingPercent != null
              ? "Anthropic 5小时会话 / 7天滑动窗口"
              : "Anthropic 滑动窗口 (根据使用频次与官方队列动态重置)"),
        probe_source: liveUsage
          ? "Anthropic OAuth 实时用量 API"
          : (hasApiKey ? (sEnv.ANTHROPIC_BASE_URL ? `反向网关 (${sEnv.ANTHROPIC_BASE_URL})` : "环境变量 ANTHROPIC_API_KEY") : "~/.claude.json 本地授权凭据"),
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
          has_api_key_override: hasApiKey,
          custom_gateway: sEnv.ANTHROPIC_BASE_URL || null,
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
          quota_type: "dynamic_rate_limit",
          quota_desc: "Claude 会话限流动态调度",
          probe_source: "claude CLI 运行时",
          remaining_percent: null,
          models: CLAUDE_MODEL_ALIASES.map((a) => ({ ...a, remaining_fraction: null, remaining_percent: null, status_text: "可用" })),
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

/** Whether a JWT's exp has passed; false when it can't be read (not evidence of being signed out). */
function jwtExpired(jwt: string | undefined): boolean {
  if (!jwt || !jwt.includes(".")) return false;
  try {
    const b64 = jwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" && claims.exp * 1000 < Date.now();
  } catch {
    return false;
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
      // Lifetimes (checked on a real auth.json): id_token 1 h, access_token 240 h; the CLI refreshes both on
      // its next run, so an expired one only means signed out when there's no refresh_token to renew it with.
      const accessToken: string | undefined = d.tokens?.access_token;
      const canRefresh = Boolean(d.tokens?.refresh_token);
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

      const hasApiKey = Boolean(d.OPENAI_API_KEY || process.env.OPENAI_API_KEY);
      if (!canRefresh && jwtExpired(accessToken) && !hasApiKey) {
        return {
          tool: "codex",
          name: "OpenAI Codex",
          available: false,
          logged_in: false,
          account_email: email,
          account_name: name || email,
          error: "Codex 登录已失效 (Token 已过期)，请在终端运行 codex 重新登录",
        };
      }
      const isFree = planType.toLowerCase() === "free";
      const planDisplay = planType.charAt(0).toUpperCase() + planType.slice(1);

      // 从真实 models_cache.json 提取模型清单
      const modelsCachePath = join(home, ".codex", "models_cache.json");
      const models: QuotaModelItem[] = [];
      const modelStatus = hasApiKey
        ? "API Key 按量计费"
        : isFree
          ? "免费通道排队中"
          : "Plus 动态保障";

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
                remaining_fraction: null,
                remaining_percent: null,
                status_text: modelStatus,
              });
            }
          }
        } catch {}
      }

      return {
        tool: "codex",
        name: "OpenAI Codex",
        available: true,
        logged_in: true,
        account_email: email,
        account_name: name || email || "OpenAI 用户",
        plan_name: hasApiKey ? "OpenAI API Key" : `ChatGPT ${planDisplay}`,
        tier: hasApiKey ? "API_KEY" : planType.toUpperCase(),
        quota_type: hasApiKey ? "token_payg" : "dynamic_rate_limit",
        quota_desc: hasApiKey
          ? "OpenAI API Key 按量计费 (按 Token 消耗实时扣费)"
          : isFree
            ? "ChatGPT Free 动态速率限制 (高峰期受限)"
            : "ChatGPT Plus 动态速率限制 (3小时滑动窗口限频保障)",
        probe_source: hasApiKey ? "OPENAI_API_KEY" : "~/.codex/auth.json (ChatGPT Plus OAuth)",
        remaining_percent: null,
        reset_time: null,
        models,
        details: {
          is_free_tier: isFree,
          has_api_key: hasApiKey,
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
        const parsed = JSON.parse(await readFile(modelsConfigPath, "utf8"));
        const list = Array.isArray(parsed) ? parsed : (parsed?.models || []);
        for (const m of list) {
          if (m?.id) {
            models.push({
              label: `${m.name || m.id}${m.vendor ? ` (${m.vendor})` : ""}`,
              model_id: m.id.startsWith("custom-local:") ? m.id : `custom-local:${m.id}`,
              remaining_fraction: null,
              remaining_percent: null,
              status_text: "自定义端点直连",
            });
          }
        }
      } catch {}
    }

    const defaultModelStatus = gateway
      ? "网关直连可用"
      : isPro
        ? "Pro 权益可用"
        : "免费额度可用";

    models.push(
      { label: "极致 (Deep Model)", model_id: "deep-model", remaining_fraction: null, remaining_percent: null, status_text: defaultModelStatus },
      { label: "均衡 (Balanced Model)", model_id: "balanced-model", remaining_fraction: null, remaining_percent: null, status_text: defaultModelStatus },
      { label: "快速 (Fast Model)", model_id: "fast-model", remaining_fraction: null, remaining_percent: null, status_text: defaultModelStatus },
      { label: "Tencent HY 4.0 Preview", model_id: "hy4-preview", remaining_fraction: null, remaining_percent: null, status_text: defaultModelStatus },
      { label: "DeepSeek V4 Pro", model_id: "deepseek-v4-pro", remaining_fraction: null, remaining_percent: null, status_text: defaultModelStatus },
      { label: "GLM-5.3", model_id: "glm-5.3", remaining_fraction: null, remaining_percent: null, status_text: defaultModelStatus },
      { label: "Kimi-K3.1", model_id: "kimi-k3-1", remaining_fraction: null, remaining_percent: null, status_text: defaultModelStatus },
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
      quota_type: gateway ? "gateway" : "unlimited",
      quota_desc: gateway
        ? "WorkBuddy 本地网关直连 (无远程配额限制)"
        : (isPro ? "WorkBuddy Pro 尊享配额通道" : "WorkBuddy 个人版 (免费动态调用)"),
      probe_source: gateway ? "本地网关 ACP 守护进程" : "~/.workbuddy/account-snapshot.json",
      remaining_percent: null,
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

let cachedQuotasReport: { report: DeviceQuotasReport; expiresAt: number; home: string } | null = null;

/** Aggregates quotas for all AI tools on this device with fast-path in-memory caching. */
export async function probeAllQuotas(home = homeDir(), options?: { force?: boolean }): Promise<DeviceQuotasReport> {
  const now = Date.now();
  if (!options?.force && cachedQuotasReport && cachedQuotasReport.home === home && cachedQuotasReport.expiresAt > now) {
    return cachedQuotasReport.report;
  }

  const [agy, claude, codex, wb] = await Promise.all([
    probeAntigravityQuota(),
    probeClaudeCodeQuota(home),
    probeCodexQuota(home),
    probeWorkbuddyQuota(home),
  ]);

  const report: DeviceQuotasReport = {
    timestamp: new Date().toISOString(),
    tools: {
      antigravity: agy,
      claude_code: claude,
      codex: codex,
      workbuddy: wb,
    },
  };

  cachedQuotasReport = { report, expiresAt: now + 5000, home };
  return report;
}

