import { api,AskConversationSummary,ProjectSummary,type AskConversationDetail,type AgentQuotasResponse } from "@/lib/api-client";
import type { AgentCapabilities } from "@/lib/api-client";
import { isConcreteDevice } from "@/lib/ask/devices";
import { ExecutionMode,Turn } from "@/lib/ask/turns";

export const FALLBACK_AGENT_MODELS: Record<string, Array<{ id: string; name: string; desc?: string }>> = {
  codex: [
    { id: "", name: "⚡ 默认模型 (跟随客户端/CLI配置)", desc: "使用本地 Codex 客户端配置的默认模型" },
    { id: "gpt-reserve", name: "GPT-Reserve (极速主力)", desc: "高性价比快速编码与日常任务" },
    { id: "gpt-6-astra", name: "GPT-6-Astra (前沿旗舰)", desc: "最新前沿多步推理模型，复杂编码首选" },
    { id: "gpt-5.6-sol", name: "GPT-5.6-Sol (日常主力)", desc: "可靠的主力 Agent 编码模型" },
    { id: "gpt-5.6-terra", name: "GPT-5.6-Terra", desc: "均衡的高性价比日常模型" },
    { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", desc: "极速响应日常编码模型" },
    { id: "gpt-5.5", name: "GPT-5.5 (经典稳定)", desc: "经典全能编码与推理模型" },
    { id: "o3", name: "o3 (深度思维)", desc: "OpenAI 深度推理" },
    { id: "o4-mini", name: "o4-mini", desc: "极速响应" },
  ],
  claude: [
    { id: "", name: "⚡ 默认模型 (跟随客户端/CLI配置)", desc: "使用本地 Claude 客户端配置的默认模型" },
    { id: "opus", name: "opus (官方动态最新 Opus 别名)", desc: "官方推荐别名，极高智能与超长上下文 (当前自动映射 Claude Opus 5.5)" },
    { id: "sonnet", name: "sonnet (官方动态最新 Sonnet 别名)", desc: "官方推荐别名，自动指向最新主力 (当前自动映射 Claude Sonnet 5.5)" },
    { id: "fable", name: "fable (官方动态最新 Fable 别名)", desc: "官方推荐别名，最强智能体与高阶科学推理 (当前为 Claude Fable 5.1)" },
    { id: "opus[1m]", name: "opus[1m] (100万上下文增强版)", desc: "超大上下文深度思维推演" },
    { id: "haiku", name: "haiku (官方动态最新 Haiku 别名)", desc: "极速轻量日常模型 (当前为 Claude Haiku 4.5)" },
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
  antigravity: [
    { id: "", name: "⚡ 默认模型 (系统配置: Gemini 3.8 Flash)", desc: "使用当前 Antigravity 默认模型" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash (High, Fast)", desc: "最新高智能极速响应模型 (Antigravity 默认推荐)" },
    { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash (Medium, Fast)", desc: "极速日常编码与高吞吐分析" },
    { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash (Fast)", desc: "轻量超低延迟模型" },
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro (深度推理)", desc: "高复杂度架构攻坚与深度逻辑推演" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)", desc: "原生嵌入 Antigravity 的高阶思维模型" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6 (Thinking)", desc: "顶级架构分析与复杂逻辑推演" },
    { id: "gpt-oss-120b", name: "GPT-OSS 120B (Medium)", desc: "开源高性价比大模型" },
    { id: "flash", name: "Gemini Flash (快速推荐)", desc: "标准 Flash 阶梯 (自动映射最新 Gemini 3.8 Flash)" },
    { id: "pro", name: "Gemini Pro (强力推理)", desc: "标准 Pro 阶梯 (自动映射最新 Gemini 3.1 Pro / Claude)" },
    { id: "flash_lite", name: "Gemini Flash-Lite (超轻量)", desc: "超轻量阶梯 (自动映射 Gemini 3.6 Flash)" },
  ],
  workbuddy: [
    { id: "", name: "⚡ 默认模型 (Auto: 自动匹配最优模型)", desc: "使用 WorkBuddy 智能路由与本地默认模型" },
    { id: "deep-model", name: "极致 (Deep Model 深度推理旗舰)", desc: "旗舰模型组合，专为复杂决策与高难度任务打造" },
    { id: "balanced-model", name: "均衡 (Balanced Model 主力均衡)", desc: "性能与成本兼顾，稳定应对日常工作" },
    { id: "fast-model", name: "快速 (Fast Model 极速响应)", desc: "低成本极速响应，适合轻量高频操作" },
    { id: "hy4-preview", name: "Tencent HY 4.0 Preview (混元最新旗舰)", desc: "腾讯混元旗舰大模型 4.0 预览版，长上下文与多步推理" },
    { id: "hy3-x", name: "Tencent HY 3.0-X (混元增强推理)", desc: "腾讯混元 3.0 增强推理模型" },
    { id: "hy3", name: "Tencent HY 3.0 (混元主力通用)", desc: "腾讯混元 3.0 主力大模型" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro (深度求索旗舰)", desc: "DeepSeek V4 旗舰深度推理与全栈编码模型" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (极速响应)", desc: "DeepSeek V4.1 高速响应模型" },
    { id: "glm-5.3", name: "GLM-5.3 (智谱最新旗舰)", desc: "智谱旗舰编码与 Agent 推理模型" },
    { id: "glm-5.3-flash", name: "GLM-5.3 Flash (极速推理)", desc: "智谱高速轻量模型" },
    { id: "glm-5.2", name: "GLM-5.2 (智谱主力通用)", desc: "智谱主力通用大模型" },
    { id: "glm-5.1", name: "GLM-5.1 (智谱稳定通用)", desc: "智谱稳定通用与编码模型" },
    { id: "glm-5v-turbo", name: "GLM-5V-Turbo (多模态视觉)", desc: "智谱多模态视觉极速模型" },
    { id: "minimax-m3", name: "MiniMax-M3 (原生智能体旗舰)", desc: "MiniMax M3 原生智能体模型" },
    { id: "minimax-m2.7", name: "MiniMax-M2.7 (高阶推理)", desc: "MiniMax M2.7 深度推理与工具调用" },
    { id: "kimi-k3-1", name: "Kimi-K3.1 (月之暗面长上下文旗舰)", desc: "月之暗面 Kimi K3.1 旗舰超长上下文模型" },
    { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview (月之暗面预览版)", desc: "月之暗面 Kimi K2.8 预览版" },
    { id: "kimi-k2.7", name: "Kimi-K2.7 (月之暗面主力)", desc: "月之暗面 Kimi K2.7 模型" },
    { id: "kimi-k2.6", name: "Kimi-K2.6 (月之暗面轻量)", desc: "月之暗面 Kimi K2.6 模型" },
    { id: "step-5-preview", name: "Step-5-Preview (阶跃星辰旗舰)", desc: "阶跃星辰 Step 5 深度思维模型" },
  ],
};
export interface CachedAskState {
  activeConversationId: string | null;
  turns: Turn[];
  input: string;
  conversations: AskConversationSummary[];
  selectedDevice: string;
  cwd: string;
  executionMode: ExecutionMode;
  selectedModel: string;
  selectedEffort: string;
  worktreeMode: boolean;
  selectedProjectId: string;
  selectedSessionId: string;
  compactMode: boolean;
  projects?: ProjectSummary[];
  sessions?: Array<{
    session_id: string;
    title: string;
    conversation_id: string;
    message_count: number;
    timestamp: string;
    file_size_bytes?: number;
    estimated_tokens?: number;
    compact_recommended?: boolean;
    messages?: Array<{
      role: string;
      content: string;
      timestamp?: string;
      raw_type?: string;
      subagent_name?: string;
    }>;
  }>;
  capabilities?: AgentCapabilities | null;
  scrollTop?: number;
  hasMoreTurns?: boolean;
  totalTurns?: number;
  activeRun?: {
    convId: string;
    question: string;
    startedAt: number;
  } | null;
  streaming?: boolean;
  quotasData?: AgentQuotasResponse | null;
  projectTitle?: string;
}

export function isUuidOrHash(str?: string | null): boolean {
  if (!str) return false;
  const s = str.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (/^[0-9a-f]{32,}$/i.test(s)) return true;
  return false;
}

export function resolveSafeProjectName(options: {
  projectId?: string;
  projectTitle?: string;
  projects?: ProjectSummary[];
  cwd?: string;
  isZh?: boolean;
}): string {
  const { projectId, projectTitle, projects = [], cwd, isZh = true } = options;

  // 1. Explicit known projectTitle
  if (projectTitle && !isUuidOrHash(projectTitle)) {
    return projectTitle;
  }

  // 2. Lookup by projectId in projects list
  if (projectId) {
    const matched = projects.find((p) => p.id === projectId);
    if (matched) {
      const candidate = matched.title || matched.slug;
      if (candidate && !isUuidOrHash(candidate)) {
        return candidate;
      }
    }
  }

  // 3. Fallback to cwd parsing if available
  if (cwd) {
    const clean = cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    const segments = clean.split("/").filter(Boolean);
    const noiseNames = new Set([
      "brain",
      "scratch",
      "tmp",
      "temp",
      "var",
      "private",
      "users",
      "home",
      "conversations",
      "antigravity",
      "gemini",
      "dotgemini",
      "walkthrough.md",
    ]);
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (
        !seg.startsWith(".") &&
        !seg.endsWith(".md") &&
        !seg.endsWith(".txt") &&
        !seg.endsWith(".json") &&
        !isUuidOrHash(seg) &&
        !noiseNames.has(seg.toLowerCase())
      ) {
        return seg;
      }
    }
  }

  // 4. Default safe fallback
  return isZh ? "项目代码库" : "Project";
}

export interface LocalConvSnapshot {
  id: string;
  turns: Turn[];
  executionMode?: ExecutionMode;
  selectedModel?: string;
  selectedEffort?: string;
  cwd?: string;
  selectedDevice?: string;
  selectedProjectId?: string;
  selectedProjectTitle?: string;
  selectedSessionId?: string;
  worktreeMode?: boolean;
  hasMoreTurns?: boolean;
  totalTurns?: number;
  etag?: string;
  convDetail?: AskConversationDetail;
  updatedAt: number;
}

export const SNAPSHOT_KEY = "memento_last_conv_snapshot_v2";
const LEGACY_SNAPSHOT_KEY = "memento_last_conv_snapshot";

export function getLocalConvSnapshot(): LocalConvSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    localStorage.removeItem(LEGACY_SNAPSHOT_KEY);
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.id === "string" && Array.isArray(parsed.turns)) {
      if (!parsed.selectedDevice || parsed.selectedDevice === "auto") {
        const detailDev = parsed.convDetail?.device_id || parsed.convDetail?.config?.device_id;
        if (detailDev && detailDev !== "auto") {
          parsed.selectedDevice = detailDev;
        } else {
          for (let i = parsed.turns.length - 1; i >= 0; i--) {
            const calls = parsed.turns[i]?.toolCalls || parsed.turns[i]?.tool_calls || [];
            let foundDev = "";
            for (let j = calls.length - 1; j >= 0; j--) {
              const c = calls[j];
              if (!c) continue;
              const resObj = typeof c.result === "object" && c.result ? c.result : {};
              const argsObj = typeof c.args === "object" && c.args ? c.args : {};
              const cand = resObj.device_id || resObj.device_name || c.device_name || argsObj.device_id;
              if (typeof cand === "string" && cand.trim() && !["auto", "ask_only", "all"].includes(cand.trim().toLowerCase())) {
                foundDev = cand.trim();
                break;
              }
            }
            if (foundDev) {
              parsed.selectedDevice = foundDev;
              break;
            }
          }
        }
      }
      return parsed;
    }
  } catch {}
  return null;
}

export function saveLocalConvSnapshot(data: Partial<LocalConvSnapshot> & { id: string; turns: Turn[] }) {
  if (typeof window === "undefined" || !data.id) return;
  try {
    const recentTurns = (data.turns || []).slice(-40);
    const sanitizedTurns: Turn[] = recentTurns.map((turn) => {
      let content = turn.content;
      if (typeof content === "string" && content.includes(";base64,") && content.length > 50000) {
        content = content.replace(/data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+/g, "[图片附件]");
      }
      return {
        role: turn.role,
        content,
        thinking: turn.thinking,
        sources: turn.sources,
        toolCalls: turn.toolCalls,
        error: turn.error,
        created_at: turn.created_at,
        started_at: turn.started_at,
        duration_ms: turn.duration_ms,
      };
    });

    const snapshot: LocalConvSnapshot = {
      id: data.id,
      turns: sanitizedTurns,
      executionMode: data.executionMode,
      selectedModel: data.selectedModel,
      selectedEffort: data.selectedEffort,
      cwd: data.cwd,
      selectedDevice: data.selectedDevice,
      selectedProjectId: data.selectedProjectId,
      selectedProjectTitle: data.selectedProjectTitle,
      selectedSessionId: data.selectedSessionId,
      worktreeMode: data.worktreeMode,
      hasMoreTurns: data.hasMoreTurns,
      totalTurns: data.totalTurns,
      etag: data.etag,
      convDetail: data.convDetail,
      updatedAt: Date.now(),
    };
    conversationTurnsCache.set(data.id, {
      turns: sanitizedTurns,
      config: {
        executionMode: data.executionMode,
        model: data.selectedModel,
        effort: data.selectedEffort,
        cwd: data.cwd,
        selectedDevice: data.selectedDevice,
        selectedProjectId: data.selectedProjectId,
        selectedProjectTitle: data.selectedProjectTitle,
        selectedSessionId: data.selectedSessionId,
        worktreeMode: data.worktreeMode,
      },
    });
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {}
}

// Module-level in-memory caches for true zero-latency instant navigation and refreshing
export const conversationTurnsCache = new Map<string, { turns: Turn[]; config?: Record<string, any> }>();
const capabilitiesMemoryCache = new Map<string, AgentCapabilities>();
const projectsMemoryCache = new Map<string, ProjectSummary[]>();
const sessionsMemoryCache = new Map<string, any[]>();
const pendingPrefetchIds = new Set<string>();

export const CONVERSATIONS_CACHE_KEY = "memento_cached_ask_convs";
export const QUOTAS_CACHE_KEY = "memento_agent_quotas_cache";
const RECENT_TURNS_CACHE_KEY = "memento_recent_conv_turns_cache_v1";

function loadRecentConvTurnsIntoMemory() {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(RECENT_TURNS_CACHE_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && typeof item.id === "string" && Array.isArray(item.turns)) {
            conversationTurnsCache.set(item.id, { turns: item.turns, config: item.config });
          }
        }
      }
    }
  } catch {}
}

if (typeof window !== "undefined") {
  loadRecentConvTurnsIntoMemory();
}

export function saveToRecentConvTurnsCache(id: string, turns: Turn[], data?: any) {
  if (typeof window === "undefined" || !id || !Array.isArray(turns) || turns.length === 0) return;
  try {
    const config = {
      executionMode: data?.execution_mode || data?.config?.execution_mode,
      model: data?.model || data?.config?.model,
      effort: data?.effort || data?.config?.effort,
      cwd: data?.cwd || data?.config?.cwd,
      selectedDevice: data?.device_id || data?.config?.device_id,
      selectedProjectId: data?.project_id || data?.config?.project_id,
      selectedProjectTitle: data?.project_title,
      selectedSessionId: data?.session_id || data?.config?.session_id,
      worktreeMode: Boolean(data?.worktree ?? data?.config?.worktree),
    };

    conversationTurnsCache.set(id, { turns, config });

    const recentRaw = localStorage.getItem(RECENT_TURNS_CACHE_KEY);
    let list: Array<{ id: string; turns: Turn[]; config: any; updatedAt: number }> = [];
    if (recentRaw) {
      try {
        const parsed = JSON.parse(recentRaw);
        if (Array.isArray(parsed)) list = parsed;
      } catch {}
    }

    const sanitizedTurns = turns.slice(-30).map((t) => ({
      role: t.role,
      content: t.content && t.content.length > 40000 ? t.content.slice(0, 40000) : t.content,
      thinking: t.thinking,
      sources: t.sources,
      toolCalls: t.toolCalls,
      error: t.error,
      created_at: t.created_at,
      started_at: t.started_at,
      duration_ms: t.duration_ms,
    }));

    list = list.filter((item) => item.id !== id);
    list.unshift({ id, turns: sanitizedTurns, config, updatedAt: Date.now() });
    list = list.slice(0, 10);

    localStorage.setItem(RECENT_TURNS_CACHE_KEY, JSON.stringify(list));
  } catch {}
}

export async function prefetchConversationTurns(id: string) {
  if (!id || conversationTurnsCache.has(id) || pendingPrefetchIds.has(id)) return;
  pendingPrefetchIds.add(id);
  try {
    const data = await api.getAskConversation(id, 40);
    if (data && data.id && Array.isArray(data.turns)) {
      saveToRecentConvTurnsCache(data.id, data.turns, data);
    }
  } catch {} finally {
    pendingPrefetchIds.delete(id);
  }
}
// Project and session lists belong to one device: a list cached for another device
// is never shown in its place (it was how a project got another machine's folder).
function projectsCacheKey(toolId: string, deviceId?: string) {
  return `${toolId}:${isConcreteDevice(deviceId) ? deviceId : "all"}`;
}

export function getCachedProjects(toolId: string, deviceId?: string): ProjectSummary[] {
  const cacheKey = projectsCacheKey(toolId, deviceId);
  const mem = projectsMemoryCache.get(cacheKey);
  if (mem && mem.length > 0) return mem;
  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(`memento_cached_projs_v2_${cacheKey}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          projectsMemoryCache.set(cacheKey, parsed);
          return parsed;
        }
      }
    } catch {}
  }
  return [];
}

export function saveCachedProjects(toolId: string, deviceId: string | undefined, list: ProjectSummary[]) {
  if (!Array.isArray(list) || list.length === 0) return;
  const cacheKey = projectsCacheKey(toolId, deviceId);
  projectsMemoryCache.set(cacheKey, list);
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(`memento_cached_projs_v2_${cacheKey}`, JSON.stringify(list.slice(0, 50)));
    } catch {}
  }
}

type ProjectSession = Awaited<ReturnType<typeof api.getProjectConversations>>["sessions"][number];

function sessionsCacheKey(projectId: string, deviceId?: string) {
  return `${projectId}|${isConcreteDevice(deviceId) ? deviceId : "all"}`;
}

export function getCachedSessions(projectId: string, deviceId?: string): ProjectSession[] {
  if (!projectId) return [];
  const cacheKey = sessionsCacheKey(projectId, deviceId);
  const mem = sessionsMemoryCache.get(cacheKey);
  if (mem && mem.length > 0) return mem;
  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(`memento_cached_sess_v2_${cacheKey}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          sessionsMemoryCache.set(cacheKey, parsed);
          return parsed;
        }
      }
    } catch {}
  }
  return [];
}

export function saveCachedSessions(projectId: string, deviceId: string | undefined, list: ProjectSession[]) {
  if (!projectId || !Array.isArray(list) || list.length === 0) return;
  const cacheKey = sessionsCacheKey(projectId, deviceId);
  sessionsMemoryCache.set(cacheKey, list);
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(`memento_cached_sess_v2_${cacheKey}`, JSON.stringify(list.slice(0, 30)));
    } catch {}
  }
}

export function getCachedConversations(): AskConversationSummary[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(CONVERSATIONS_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

export function getLocalCachedQuotas(deviceId?: string): AgentQuotasResponse | null {
  if (typeof window === "undefined") return null;
  try {
    // Quotas are per device: a concrete device never shows another device's numbers
    const raw = isConcreteDevice(deviceId)
      ? localStorage.getItem(`${QUOTAS_CACHE_KEY}_${deviceId}`)
      : localStorage.getItem(QUOTAS_CACHE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

export function getImmediateCapabilities(mode: ExecutionMode, deviceId?: string): AgentCapabilities | null {
  if (mode === "ai" || mode === "shell") return null;
  const cacheKey = `${mode}:${deviceId || "default"}`;
  const mem = capabilitiesMemoryCache.get(cacheKey);
  if (mem) return mem;
  if (typeof window !== "undefined") {
    try {
      // Models and defaults are per device: another device's list is never borrowed
      const raw = localStorage.getItem(`memento_caps_${cacheKey}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.models) && parsed.models.length > 0) {
          capabilitiesMemoryCache.set(cacheKey, parsed);
          return parsed;
        }
      }
    } catch {}
  }
  const fallbackModels = FALLBACK_AGENT_MODELS[mode];
  if (fallbackModels && fallbackModels.length > 0) {
    return {
      tool: mode,
      models: fallbackModels,
      default_model: "",
      supports_effort: true,
      default_effort: "",
      effort_options: [],
    };
  }
  return null;
}

export function saveCapabilitiesCache(mode: ExecutionMode, deviceId: string | undefined, caps: AgentCapabilities) {
  if (!caps || !Array.isArray(caps.models)) return;
  const cacheKey = `${mode}:${deviceId || "default"}`;
  capabilitiesMemoryCache.set(cacheKey, caps);
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(`memento_caps_${cacheKey}`, JSON.stringify(caps));
    } catch {}
  }
}
