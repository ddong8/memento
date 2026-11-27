// Ask API: RAG, AI Orchestrator, direct device agent SSE streaming, background run lifecycle & capabilities
// (server/server/api/ask.py).
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser, type UserRow } from "../auth/current-user";
import type { AppEnv, Deps } from "../context";
import { withoutNul } from "../db/client";
import { askConversations } from "../db/pulled/schema";
import { HttpError, parseJsonObject, queryInt } from "../http";
import { addFollowup, peekFollowups, popFollowups, removeFollowup } from "../services/ask-followups";
import { buildMessages, classifyContinuation } from "../services/ask-prompt";
import { retrieveDocuments } from "../services/ask-retrieval";
import { askRuns, type RunStreamFactory } from "../services/ask-runs";
import { appendConversationTurns, getOrCreateConversation, inferConversationConfig, resolveConcreteDeviceForConv } from "../services/ask-store";
import { directAgentStream, runResponse, SSE_HEADERS } from "../services/ask-stream";
import { streamChatCompletion } from "../services/ai-provider";
import { getCachedDeviceCapabilities, getCachedDeviceQuotas } from "../services/device-reports";
import {
  cleanGuardrailOutput,
  extractLiveCorrectionRules,
  getSessionLiveRules,
  getUserDurableCorrections,
  saveSessionLiveRules,
} from "../services/mind-resonance-service";
import { runAgentLoop } from "../services/orchestrator";
import type { CompactState, HistoryTurn } from "../services/orchestrator-context";
import { getPublishedProfile } from "../services/profile-read";
import { wsManager } from "../services/ws-manager";
import { askConversationRoutes, bustConvList, CHECKPOINT_CONFIG_KEY } from "./ask-conversations";

const DIRECT_AGENT_MODES = new Set(["claude", "codex", "antigravity", "workbuddy", "shell"]);

export const FALLBACK_AGENT_CAPABILITIES: Record<string, Record<string, unknown>> = {
  codex: {
    tool: "codex",
    models: [
      { id: "", name: "⚡ 默认模型 (跟随客户端/CLI配置)", desc: "使用本地 Codex 客户端配置的默认模型", is_default: true },
      { id: "gpt-6-astra", name: "GPT-6-Astra (最新旗舰)", desc: "前沿深度多步推理模型，复杂编码首选" },
      { id: "gpt-reserve", name: "GPT-Reserve (极速主力)", desc: "高性价比快速编码与日常任务" },
      { id: "gpt-5.6-sol", name: "GPT-5.6-Sol (日常主力)", desc: "可靠的主力 Agent 编码模型" },
      { id: "gpt-5.6-terra", name: "GPT-5.6-Terra", desc: "均衡的高性价比日常模型" },
      { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", desc: "极速响应日常编码模型" },
      { id: "gpt-5.5", name: "GPT-5.5 (经典稳定)", desc: "经典全能编码与推理模型" },
      { id: "o3", name: "o3 (深度思维)", desc: "OpenAI 深度思维链" },
      { id: "o4-mini", name: "o4-mini", desc: "轻量高速响应" },
    ],
    default_model: "gpt-5.6-sol",
    supports_effort: true,
    default_effort: "medium",
    effort_options: [
      { id: "", name: "⚡ 默认 Effort (跟随配置)", desc: "使用本地配置的 reasoning_effort" },
      { id: "low", name: "Low (快速 / 低思考量)", desc: "轻量思考，极速响应，节省 Token" },
      { id: "medium", name: "Medium (标准思考量)", desc: "平衡速度与推理质量，适合日常编程" },
      { id: "high", name: "High (深度推理 / 高思考量)", desc: "深入思维链，攻坚复杂架构与疑难排错" },
    ],
  },
  claude: {
    tool: "claude",
    models: [
      { id: "", name: "⚡ 默认模型 (跟随客户端/CLI配置)", desc: "使用本地 Claude 客户端配置默认模型", is_default: true },
      { id: "opus", name: "opus (官方动态最新 Opus 别名)", desc: "官方推荐别名，极高智能与超长上下文 (当前自动映射 Claude Opus 5.5)" },
      { id: "sonnet", name: "sonnet (官方动态最新 Sonnet 别名)", desc: "官方推荐别名，自动指向最新主力 (当前自动映射 Claude Sonnet 5.5)" },
      { id: "fable", name: "fable (官方动态最新 Fable 别名)", desc: "官方推荐别名，最强智能体与高阶科学推理 (当前为 Claude Fable 5.1)" },
      { id: "opus[1m]", name: "opus[1m] (100万上下文增强版)", desc: "Claude Opus 深度思维 / 100万 Token 超大上下文" },
      { id: "haiku", name: "haiku (官方动态最新 Haiku 别名)", desc: "官方推荐别名，极速轻量 (当前为 Claude Haiku 4.5)" },
      { id: "claude-opus-5-5", name: "claude-opus-5-5 (Claude Opus 5.5)", desc: "顶尖旗舰架构设计与前沿复杂多步推理 (最新顶级旗舰)" },
      { id: "claude-sonnet-5-5", name: "claude-sonnet-5-5 (Claude Sonnet 5.5)", desc: "最新前沿主力编码与多模态推理模型 (最新主力)" },
      { id: "opus-5.5", name: "opus-5.5 (Claude Opus 5.5 简写)", desc: "Claude Opus 5.5 快速别名" },
      { id: "sonnet-5.5", name: "sonnet-5.5 (Claude Sonnet 5.5 简写)", desc: "Claude Sonnet 5.5 快速别名" },
      { id: "claude-fable-5-1", name: "claude-fable-5-1 (Claude Fable 5.1)", desc: "官方最强智能体与高阶科学推理模型 (顶尖旗舰)" },
      { id: "claude-opus-5", name: "claude-opus-5 (Claude Opus 5)", desc: "官方顶级旗舰架构设计与复杂推演 (当前旗舰)" },
      { id: "claude-sonnet-5", name: "claude-sonnet-5 (Claude Sonnet 5)", desc: "官方最新主力编码与推理模型 (当前主力)" },
      { id: "claude-opus-4-8", name: "claude-opus-4-8 (Claude Opus 4.8)", desc: "高阶复杂推理模型" },
      { id: "claude-opus-4-6", name: "claude-opus-4-6 (Claude Opus 4.6)", desc: "前沿架构分析与深度推演模型" },
      { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6 (Claude Sonnet 4.6)", desc: "前沿高效编码与推理模型" },
      { id: "claude-opus-4-5-20251101", name: "claude-opus-4-5-20251101 (Claude Opus 4.5)", desc: "高阶深度思维与复杂推演模型" },
      { id: "claude-sonnet-4-5-20250929", name: "claude-sonnet-4-5-20250929 (Claude Sonnet 4.5)", desc: "前沿多步推理与编码模型" },
      { id: "claude-haiku-4-5-20251001", name: "claude-haiku-4-5-20251001 (Claude Haiku 4.5)", desc: "毫秒级响应极速轻量模型" },
      { id: "claude-opus-4-1-20250805", name: "claude-opus-4-1-20250805 (Claude Opus 4.1)", desc: "顶级复杂推理与工程攻坚" },
      { id: "claude-3-7-sonnet-20250219", name: "claude-3-7-sonnet-20250219 (Claude 3.7 Sonnet)", desc: "经典混合推理与编码模型 (早期版本)" },
      { id: "claude-3-5-sonnet-20241022", name: "claude-3-5-sonnet-20241022 (Claude 3.5 Sonnet)", desc: "经典高性价比编码模型" },
      { id: "claude-3-5-haiku-20241022", name: "claude-3-5-haiku-20241022 (Claude 3.5 Haiku)", desc: "极速轻量日常模型" },
    ],
    default_model: "opus",
    supports_effort: true,
    default_effort: "max",
    effort_options: [
      { id: "", name: "⚡ 默认 Effort (跟随配置)", desc: "使用本地配置的 effortLevel" },
      { id: "low", name: "Low (快速 / 低思考量)", desc: "轻量思考，极速响应，节省 Token" },
      { id: "medium", name: "Medium (标准思考量)", desc: "平衡速度与推理质量，适合日常编程" },
      { id: "high", name: "High (深度推理 / 高思考量)", desc: "深入思维链，攻坚复杂架构与排错" },
      { id: "max", name: "Max (最大思考量)", desc: "顶级复杂任务深度多步探索" },
    ],
  },
  antigravity: {
    tool: "antigravity",
    models: [
      { id: "", name: "⚡ 默认模型 (跟随客户端配置: Gemini 4 Argon)", desc: "使用当前 Antigravity 客户端配置的默认模型", is_default: true },
      { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium) · New", desc: "最新 Gemini 4 Argon 主力模型 (Antigravity 默认推荐)" },
      { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High) · New", desc: "Gemini 4 Argon 高思考量深度推理模型" },
      { id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low) · New", desc: "Gemini 4 Argon 轻量极速响应模型" },
      { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", desc: "高智能极速响应模型 (无配额限制)" },
      { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", desc: "极速日常编码与高吞吐分析 (无配额限制)" },
      { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", desc: "轻量超低延迟模型 (无配额限制)" },
      { id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High) · New", desc: "原生嵌入 Antigravity 的顶级旗舰推理模型" },
      { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium) · New", desc: "Claude Opus 5.5 均衡深度思维模型" },
      { id: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low) · New", desc: "Claude Opus 5.5 快速推理模型" },
      { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High) · New", desc: "原生嵌入 Antigravity 的最新高阶编码模型" },
      { id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium) · New", desc: "Claude Sonnet 5.5 日常主力编码模型" },
      { id: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low) · New", desc: "Claude Sonnet 5.5 极速响应模型" },
      { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", desc: "开源高性价比大模型" },
      { id: "pro", name: "pro (官方动态 Pro 旗舰阶梯)", desc: "标准 Pro 阶梯 (自动映射最新 Gemini 4 Argon / Claude Opus 5.5)" },
      { id: "flash", name: "flash (官方动态 Flash 极速阶梯)", desc: "标准 Flash 阶梯 (自动映射最新 Gemini 3.8 Flash)" },
      { id: "flash_lite", name: "flash_lite (官方动态超轻量阶梯)", desc: "超轻量阶梯" },
    ],
    default_model: "gemini-4-argon-medium",
    supports_effort: false,
    default_effort: "",
    effort_options: [],
  },
  workbuddy: {
    tool: "workbuddy",
    models: [
      { id: "", name: "⚡ 默认模型 (跟随 WorkBuddy 配置)", desc: "使用当前 WorkBuddy 客户端配置的默认模型", is_default: true },
      { id: "fast-model", name: "快速", desc: "优先响应速度，适合简单任务与快速问答" },
      { id: "balanced-model", name: "均衡", desc: "兼顾速度与质量，适合大多数日常工作" },
      { id: "deep-model", name: "极致", desc: "优先深度与准确性，适合复杂分析和高要求任务" },
      { id: "hy4-preview", name: "Hy4 preview", desc: "混元思考模型，具有增强的推理能力" },
      { id: "hy3", name: "Hy3", desc: "混元思考模型，具有增强的推理能力" },
      { id: "hy3-x", name: "Hy3", desc: "混元思考模型，具有增强的推理能力" },
      { id: "step-5-preview", name: "Step-5-Preview", desc: "阶跃 StepFun 面向真实任务的新一代旗舰基模" },
      { id: "space-bunny", name: "Space-Bunny", desc: "推理速度极快，编码能力强劲，并支持原生多模态输入的匿名大模型" },
      { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", desc: "DeepSeek V4.1 Flash，支持 1M 上下文" },
      { id: "glm-5.3", name: "GLM-5.3", desc: "旗舰模型，擅长复杂软件工程与长程 Agent 任务" },
      { id: "glm-5.3-flash", name: "GLM-5.3-Flash", desc: "原生多模态模型，擅长视觉理解与专业任务" },
      { id: "glm-5.2", name: "GLM-5.2", desc: "1M 上下文，擅长长程任务" },
      { id: "glm-5.1", name: "GLM-5.1", desc: "能力均衡，适合日常使用" },
      { id: "glm-5v-turbo", name: "GLM-5v-Turbo", desc: "原生多模态模型" },
      { id: "minimax-m3.1-flash", name: "MiniMax-M3.1-Flash", desc: "原生多模态，擅长 office、agentic、编程任务" },
      { id: "minimax-m3", name: "MiniMax-M3", desc: "原生多模态，擅长代码、智能体任务" },
      { id: "kimi-k3.1-pro", name: "Kimi-K3.1-Pro", desc: "Kimi 全新旗舰模型，办公、代码、3D 创作与长程 Agent" },
      { id: "kimi-k3-1", name: "Kimi-K3", desc: "擅长处理复杂的长程自主任务，前端开发能力突出" },
      { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview", desc: "擅长处理复杂的长程自主任务" },
      { id: "deepseek-v4-pro", name: "Deepseek-V4-Pro", desc: "DeepSeek 旗舰模型，支持 1M 上下文窗口" },
      { id: "mimo-v2.6-pro", name: "Xiaomi MiMo-V2.6-Pro", desc: "旗舰推理模型，面向专业、长程、复杂工作流" },
    ],
    default_model: "",
    supports_effort: true,
    default_effort: "medium",
    effort_options: [
      { id: "", name: "⚡ 默认思考量 (跟随 WorkBuddy 配置)", desc: "使用当前模型默认思考深度" },
      { id: "minimal", name: "Minimal (极简思考)", desc: "最低思考开销，极速直出" },
      { id: "low", name: "Low (低思考量)", desc: "轻量思考，快速响应" },
      { id: "medium", name: "Medium (中等思考量)", desc: "平衡推理速度与深度" },
      { id: "high", name: "High (高思考量)", desc: "深入推理，适合复杂编码" },
      { id: "xhigh", name: "XHigh (超高思考量)", desc: "高强度多步逻辑推演" },
      { id: "max", name: "Max (最大思考量)", desc: "全量深度思维链探索" },
    ],
  },
};

const LEGACY_AGY_IDS = new Set(["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.1-pro", "claude-sonnet-4-6", "claude-opus-4-6", "gpt-oss-120b"]);

export async function resolveAgentCapabilities(
  deps: Deps,
  user: UserRow,
  tool: string,
  deviceId: string | null,
  fresh: string | null,
): Promise<Record<string, unknown>> {
  const toolKey = (tool || "codex").toLowerCase().trim();
  if (fresh && ["1", "true", "yes"].includes(fresh.toLowerCase()) && wsManager.hasOnlineDevices()) {
    await wsManager.broadcast({ type: "get_agent_capabilities" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 350));
  }

  const live = getCachedDeviceCapabilities(deviceId, toolKey, user, deps.settings);
  const quotasReport = getCachedDeviceQuotas(deviceId, user, deps.settings);
  const quotaToolKey = toolKey === "claude" || toolKey === "claude_code" ? "claude_code" : toolKey;
  const quotaTools = (quotasReport?.tools && typeof quotasReport.tools === "object" ? quotasReport.tools : {}) as Record<string, unknown>;
  const quotaTool = (quotaTools[quotaToolKey] && typeof quotaTools[quotaToolKey] === "object" ? quotaTools[quotaToolKey] : {}) as Record<string, unknown>;
  const quotaModels = Array.isArray(quotaTool.models) ? (quotaTool.models as Record<string, unknown>[]) : null;

  let baseCaps: Record<string, unknown> | null = live && Array.isArray(live.models) && live.models.length ? live : null;
  if (!baseCaps && toolKey === "antigravity" && quotaModels?.length) {
    baseCaps = { ...FALLBACK_AGENT_CAPABILITIES.antigravity };
  }

  if (baseCaps) {
    let normModels: Record<string, unknown>[] = [];
    for (const m of (baseCaps.models as unknown[]) || []) {
      if (m && typeof m === "object") normModels.push({ ...(m as Record<string, unknown>) });
      else if (typeof m === "string") normModels.push({ id: m, name: m, desc: "" });
    }
    if (toolKey === "antigravity" && quotaModels?.length) {
      const details = (quotaTool.details && typeof quotaTool.details === "object" ? quotaTool.details : {}) as Record<string, unknown>;
      const defaultLabel = String(details.default_model_label || quotaModels[0]?.label || "");
      const defaultId = String(details.default_model_id || quotaModels[0]?.model_id || "");
      const merged: Record<string, unknown>[] = [
        {
          id: "",
          name: defaultLabel ? `⚡ 默认模型 (跟随客户端配置: ${defaultLabel})` : "⚡ 默认模型 (跟随 Antigravity 客户端配置)",
          desc: defaultId ? `当前 Antigravity 客户端默认配置: ${defaultLabel} (${defaultId})` : "使用当前 Antigravity 客户端默认模型",
          is_default: true,
        },
      ];
      const seen = new Set<string>([""]);
      for (const qm of quotaModels) {
        const mid = String(qm.model_id ?? "").trim();
        const label = String(qm.label || mid).trim();
        if (!mid || seen.has(mid)) continue;
        seen.add(mid);
        const statusTxt = String(qm.status_text || "实时可用").trim();
        merged.push({
          id: mid,
          name: mid === defaultId ? `${label} (当前客户端配置)` : label,
          desc: `${statusTxt} (Antigravity 实时同步)`,
        });
      }
      for (const ex of normModels) {
        const eid = String(ex.id ?? "").trim();
        if (!eid || seen.has(eid) || LEGACY_AGY_IDS.has(eid)) continue;
        seen.add(eid);
        merged.push(ex);
      }
      normModels = merged;
    }
    const copy: Record<string, unknown> = { ...baseCaps, models: normModels };
    if (toolKey === "antigravity" && quotaModels?.length) {
      const details = (quotaTool.details && typeof quotaTool.details === "object" ? quotaTool.details : {}) as Record<string, unknown>;
      copy.default_model = details.default_model_id || quotaModels[0]?.model_id || copy.default_model || "";
    }
    return copy;
  }

  return (
    FALLBACK_AGENT_CAPABILITIES[toolKey] ?? {
      tool: toolKey,
      models: [{ id: "", name: "⚡ 默认模型 (跟随客户端/CLI配置)", desc: "使用客户端配置默认模型", is_default: true }],
      default_model: "",
      supports_effort: false,
      default_effort: "",
      effort_options: [],
    }
  );
}

export const askRoutes = new Hono<AppEnv>();

// Mount conversation CRUD routes under /api/ask
askRoutes.route("/", askConversationRoutes);

askRoutes.post("/warmup", async (c) => {
  const deps = c.get("deps");
  const user = await currentUser(c);
  await Promise.allSettled([getPublishedProfile(deps.db, user), getUserDurableCorrections(deps.redis(), user.id)]);
  return c.json({ warmed: true, timestamp: new Date().toISOString() });
});

askRoutes.get("/runs", async (c) => {
  const user = await currentUser(c);
  const recent = queryInt(c, "recent", 0, { ge: 0, le: 86400 });
  const all = await askRuns.listForUser(user.id, recent <= 0);
  if (recent <= 0) return c.json(all);
  const cutoff = Date.now() / 1000 - recent;
  return c.json(all.filter((r) => !r.done || (r.finished_at !== null && r.finished_at >= cutoff)));
});

askRoutes.get("/runs/active", async (c) => {
  const user = await currentUser(c);
  return c.json({ runs: await askRuns.listForUser(user.id, true) });
});

askRoutes.get("/conversations/:conv_id/run", async (c) => {
  const user = await currentUser(c);
  const convId = c.req.param("conv_id");
  const run = await askRuns.getForConversation(convId);
  if (!run || run.userId !== user.id) throw new HttpError(404, "no run");
  return c.json(run.summary());
});

askRoutes.get("/conversations/:conv_id/stream", async (c) => {
  const user = await currentUser(c);
  const convId = c.req.param("conv_id");
  const after = queryInt(c, "after", 0, { ge: 0, le: 100_000 });
  const run = await askRuns.getForConversation(convId);
  if (!run || run.userId !== user.id) throw new HttpError(404, "no run");

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of run.stream(after, c.req.raw.signal)) {
          controller.enqueue(encoder.encode(frame));
        }
      } catch {
        /* client disconnected */
      } finally {
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      }
    },
  });
  return new Response(body, { status: 200, headers: SSE_HEADERS });
});

askRoutes.post("/conversations/:conv_id/followups", async (c) => {
  const user = await currentUser(c);
  const convId = c.req.param("conv_id");
  const body = await parseJsonObject(c);
  const text = String(body.text ?? "");
  return c.json({ queued: await addFollowup(user.id, convId, text) });
});

askRoutes.get("/conversations/:conv_id/followups", async (c) => {
  const user = await currentUser(c);
  const convId = c.req.param("conv_id");
  const takeRaw = (c.req.query("take") || "").toLowerCase();
  const take = takeRaw === "true" || takeRaw === "1" || takeRaw === "yes";
  const items = take ? await popFollowups(user.id, convId) : await peekFollowups(user.id, convId);
  return c.json({ items });
});

askRoutes.delete("/conversations/:conv_id/followups", async (c) => {
  const user = await currentUser(c);
  const convId = c.req.param("conv_id");
  const body = await parseJsonObject(c);
  const text = String(body.text ?? "");
  return c.json({ removed: await removeFollowup(user.id, convId, text) });
});

askRoutes.post("/conversations/:conv_id/cancel", async (c) => {
  const deps = c.get("deps");
  const user = await currentUser(c);
  const convId = c.req.param("conv_id");
  askRuns.bindDeps(deps);
  const res = await askRuns.cancel(convId, user.id);
  if (!res.cancelled) throw new HttpError(404, "no running task");
  return c.json({ status: "cancelling" });
});

askRoutes.get("/capabilities", async (c) => {
  const deps = c.get("deps");
  const user = await currentUser(c);
  return c.json(await resolveAgentCapabilities(deps, user, c.req.query("tool") || "codex", c.req.query("device_id") || null, c.req.query("fresh") || null));
});

askRoutes.get("/agent/capabilities", async (c) => {
  const deps = c.get("deps");
  const user = await currentUser(c);
  return c.json(await resolveAgentCapabilities(deps, user, c.req.query("tool") || "codex", c.req.query("device_id") || null, c.req.query("fresh") || null));
});

askRoutes.post("/", async (c) => {
  const deps = c.get("deps");
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const question = String(body.question ?? "").trim();
  if (!question) throw new HttpError(400, "question is required");

  const requestId = typeof body.request_id === "string" && body.request_id.trim() ? body.request_id.trim() : null;
  const executionMode = String(body.execution_mode ?? "ai").trim().toLowerCase() || "ai";
  const deviceIdRaw = typeof body.device_id === "string" ? body.device_id.trim() : "";
  const cwd = typeof body.cwd === "string" ? body.cwd.trim() || null : null;
  const model = typeof body.model === "string" ? body.model.trim() || null : null;
  const sessionId = typeof body.session_id === "string" ? body.session_id.trim() || null : null;
  const permissionMode = typeof body.permission_mode === "string" ? body.permission_mode.trim() || "full" : "full";
  const projectId = typeof body.project_id === "string" ? body.project_id.trim() || null : null;
  const images = Array.isArray(body.images) ? body.images.filter((x): x is string => typeof x === "string") : [];

  const reqConfig: Record<string, unknown> = {
    execution_mode: executionMode,
    ...(body.model !== undefined ? { model: body.model } : {}),
    ...(body.effort !== undefined ? { effort: body.effort } : {}),
    ...(body.permission_mode !== undefined ? { permission_mode: body.permission_mode } : {}),
    ...(body.project_id !== undefined ? { project_id: body.project_id } : {}),
    ...(body.session_id !== undefined ? { session_id: body.session_id } : {}),
    ...(body.worktree !== undefined ? { worktree: Boolean(body.worktree) } : {}),
    ...(body.source_device_id !== undefined ? { source_device_id: body.source_device_id } : {}),
    ...(body.compact_mode !== undefined ? { compact_mode: Boolean(body.compact_mode) } : {}),
  };

  const conv = await getOrCreateConversation(deps.db, user, {
    conversationId: typeof body.conversation_id === "string" ? body.conversation_id : null,
    title: question.slice(0, 60),
    deviceId: deviceIdRaw || null,
    cwd,
    config: reqConfig,
  });
  const convId = conv.id;
  const convTitle = conv.title;
  const effCfg = inferConversationConfig(conv);
  const effMode = String(effCfg.execution_mode || executionMode || "ai").toLowerCase();

  // Extract live correction directives from user prompt
  const liveExtracted = extractLiveCorrectionRules(question);
  const liveRules = liveExtracted.length
    ? await saveSessionLiveRules(deps.redis(), user.id, convId, liveExtracted)
    : await getSessionLiveRules(deps.redis(), user.id, convId);

  // Mode 1: Direct remote agent / shell execution
  if (DIRECT_AGENT_MODES.has(effMode)) {
    const resolved = await resolveConcreteDeviceForConv(deps.db, user, deviceIdRaw || null, conv);
    const targetDevice = resolved.deviceId || deviceIdRaw;
    if (!targetDevice) throw new HttpError(400, "直接调度本地智能体模式必须指定目标设备 (device_id)");
    const effCwd = cwd || conv.cwd || (typeof effCfg.cwd === "string" ? effCfg.cwd : null);
    const effSid = sessionId ?? (typeof effCfg.session_id === "string" && effCfg.session_id ? effCfg.session_id : null);
    const effort = typeof body.effort === "string" ? body.effort.trim() || null : typeof effCfg.effort === "string" ? effCfg.effort || null : null;
    const fork = typeof body.fork === "boolean" ? body.fork : null;
    const worktree = typeof body.worktree === "boolean" ? body.worktree : Boolean(effCfg.worktree);
    const timeoutSeconds = typeof body.timeout_seconds === "number" && Number.isFinite(body.timeout_seconds) ? body.timeout_seconds : undefined;
    const userCreatedAt = new Date().toISOString();

    const factory: RunStreamFactory = async function* (runDeps, runUser, signal) {
      yield `data: ${JSON.stringify({ type: "conversation_id", id: convId, title: convTitle, execution_mode: effMode, user_created_at: userCreatedAt })}\n\n`;
      for await (const frame of directAgentStream(
        runDeps,
        runUser,
        {
          convId,
          convTitle,
          question,
          device: targetDevice,
          executionMode: effMode === "shell" ? "shell" : effMode,
          action: effMode === "shell" ? "shell" : "agent",
          cwd: effCwd,
          sessionId: effSid,
          permissionMode,
          model,
          effort,
          projectId,
          fork,
          worktree,
          timeoutSeconds,
          images,
          liveRules,
          checkpoint: { user_created_at: userCreatedAt },
        },
        signal,
      )) {
        yield frame;
      }
      await bustConvList(runDeps, runUser.id);
    };

    return runResponse(deps, convId, user, question, requestId, factory, {
      executionMode: effMode,
      model,
      deviceName: resolved.deviceName || targetDevice,
      title: convTitle,
      images,
      resume: {
        kind: "direct_agent",
        kwargs: {
          conv_id: convId,
          conv_title: convTitle,
          question,
          device: targetDevice,
          execution_mode: effMode,
          cwd: effCwd,
          session_id: effSid,
          permission_mode: permissionMode,
          model,
          effort,
          project_id: projectId,
        },
      },
      signal: c.req.raw.signal,
    });
  }

  // Mode 2: Multi-tool AI Orchestrator (default "ai" or "agent")
  const turns = Array.isArray(conv.turns) ? (conv.turns as HistoryTurn[]) : [];
  if (effMode === "ai" || effMode === "agent" || body.use_agent !== false) {
    const factory: RunStreamFactory = async function* (runDeps, runUser, signal) {
      const started = Date.now();
      const userCreatedAt = new Date().toISOString();
      yield `data: ${JSON.stringify({ type: "conversation_id", id: convId, title: convTitle, execution_mode: "ai", user_created_at: userCreatedAt })}\n\n`;

      let answer = "";
      let thinking = "";
      let toolCalls: Record<string, unknown>[] = [];
      let steps: Record<string, unknown>[] = [];
      let sources: Record<string, unknown>[] = [];
      let assistantAt = new Date().toISOString();
      let durationMs = 0;

      try {
        const gen = runAgentLoop(runDeps, runUser, {
          question,
          history: turns,
          compactState: (effCfg[CHECKPOINT_CONFIG_KEY] as CompactState | undefined) ?? null,
          images,
          model,
          project: projectId,
          conversationId: convId,
          liveRules,
          enableDeviceTools: deviceIdRaw !== "ask_only",
          signal,
          onCompactUpdate: async (state) => {
            const nextCfg = { ...effCfg, [CHECKPOINT_CONFIG_KEY]: state };
            await runDeps.db.update(askConversations).set({ config: withoutNul(nextCfg) }).where(eq(askConversations.id, convId));
          },
        });
        while (true) {
          const next = await gen.next();
          if (next.done) {
            answer = next.value.answer;
            thinking = next.value.thinking;
            toolCalls = next.value.toolCalls;
            steps = next.value.steps;
            sources = next.value.sources;
            break;
          }
          yield `data: ${JSON.stringify(next.value)}\n\n`;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        yield `data: ${JSON.stringify({ type: "error", message: `生成失败: ${msg}` })}\n\n`;
        return;
      } finally {
        durationMs = Date.now() - started;
        if (answer || thinking || toolCalls.length || steps.length) {
          const saved = await appendConversationTurns(runDeps.db, convId, {
            settings: runDeps.settings,
            userId: runUser.id,
            question,
            answer: answer || "已完成处理。",
            thinking: thinking || null,
            toolCalls: toolCalls.length ? toolCalls : null,
            steps: steps.length ? steps : null,
            sources: sources.length ? sources : null,
            images,
            userCreatedAt,
            startedAt: userCreatedAt,
            durationMs,
            model,
            executionMode: "ai",
          });
          assistantAt = saved.assistantCreatedAt;
          await bustConvList(runDeps, runUser.id);
        }
      }

      yield `data: ${JSON.stringify({ type: "done", assistant_created_at: assistantAt, duration_ms: durationMs })}\n\n`;
    };

    return runResponse(deps, convId, user, question, requestId, factory, {
      executionMode: "ai",
      model,
      deviceName: null,
      title: convTitle,
      images,
      signal: c.req.raw.signal,
    });
  }

  // Mode 3: Pure RAG streaming
  const factory: RunStreamFactory = async function* (runDeps, runUser, signal) {
    const started = Date.now();
    const userCreatedAt = new Date().toISOString();
    yield `data: ${JSON.stringify({ type: "conversation_id", id: convId, title: convTitle })}\n\n`;

    const contKind = classifyContinuation(question, turns);
    const docs = contKind === "continue" ? [] : await retrieveDocuments(runDeps.db, runDeps.settings, runDeps.redis(), runUser, question, typeof body.tool_id === "string" ? body.tool_id : null, typeof body.days === "number" ? body.days : null);
    if (docs.length) yield `data: ${JSON.stringify({ type: "sources", sources: docs })}\n\n`;

    const { messages } = await buildMessages(runDeps.db, runDeps.redis(), runUser, {
      question,
      contextItems: docs.map((d) => ({ tool_id: d.tool_id, title: d.title, relative_path: d.relative_path, synced_at: d.synced_at, snippet: d.excerpt })),
      history: turns,
      images,
      project: projectId,
      liveRules,
    });

    let answerBuf = "";
    let thinkingBuf = "";
    let assistantAt = new Date().toISOString();
    let durationMs = 0;

    try {
      for await (const chunk of streamChatCompletion(runDeps.settings, runDeps.redis(), messages, {
        temperature: 0.3,
        maxTokens: 2500,
        user: runUser,
        model,
        signal,
      })) {
        if (chunk.type === "thinking") {
          thinkingBuf += chunk.text;
          yield `data: ${JSON.stringify({ type: "thinking", text: chunk.text })}\n\n`;
        } else {
          answerBuf += chunk.text;
          yield `data: ${JSON.stringify({ type: "delta", text: chunk.text })}\n\n`;
        }
      }
    } catch (e) {
      yield `data: ${JSON.stringify({ type: "error", message: `生成失败: ${e instanceof Error ? e.message : String(e)}` })}\n\n`;
      return;
    } finally {
      durationMs = Date.now() - started;
      const cleanAnswer = cleanGuardrailOutput(answerBuf);
      if (cleanAnswer) {
        const saved = await appendConversationTurns(runDeps.db, convId, {
          settings: runDeps.settings,
          userId: runUser.id,
          question,
          answer: cleanAnswer,
          thinking: thinkingBuf || null,
          sources: docs as unknown as Record<string, unknown>[],
          images,
          userCreatedAt,
          durationMs,
        });
        assistantAt = saved.assistantCreatedAt;
        await bustConvList(runDeps, runUser.id);
      }
    }

    yield `data: ${JSON.stringify({ type: "done", assistant_created_at: assistantAt, duration_ms: durationMs })}\n\n`;
  };

  return runResponse(deps, convId, user, question, requestId, factory, {
    executionMode: "rag",
    model,
    deviceName: null,
    title: convTitle,
    images,
    signal: c.req.raw.signal,
  });
});

export const agentCapabilitiesRoutes = new Hono<AppEnv>();
agentCapabilitiesRoutes.get("/capabilities", async (c) => {
  const deps = c.get("deps");
  const user = await currentUser(c);
  return c.json(await resolveAgentCapabilities(deps, user, c.req.query("tool") || "codex", c.req.query("device_id") || null, c.req.query("fresh") || null));
});
agentCapabilitiesRoutes.get("/models", async (c) => {
  const deps = c.get("deps");
  const user = await currentUser(c);
  const tool = c.req.query("tool") || "codex";
  const caps = await resolveAgentCapabilities(deps, user, tool, c.req.query("device_id") || null, null);
  return c.json({ tool, models: caps.models ?? [] });
});
