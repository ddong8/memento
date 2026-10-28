import type { AgentSessionItem } from "./sessions";
import { api,AskConversationSummary,ProjectSummary,type AskConversationDetail,type AgentQuotasResponse } from "@/lib/api-client";
import type { AgentCapabilities } from "@/lib/api-client";
import { isConcreteDevice } from "@/lib/ask/devices";
import { ExecutionMode,Turn } from "@/lib/ask/turns";
import type { ToolCallItem } from "@/components/ExecutionCard";

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
  // Only until the device reports its own list (read from WorkBuddy's cached product config); WorkBuddy 5.8.3, 2026-10
  workbuddy: [
    { id: "", name: "⚡ 默认模型 (跟随 WorkBuddy 配置)", desc: "使用当前 WorkBuddy 客户端配置的默认模型" },
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
  sessions?: AgentSessionItem[];
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

// localStorage is synchronous and what goes in here is large (whole conversations with their tool
// output): serializing it where a conversation opens or a run ends held the page up for a moment.
// The latest value per key waits here and is written when the browser is idle; leaving or hiding
// the page writes it at once.
const pendingWrites = new Map<string, () => string>();
let flushScheduled = false;

function writeLater(key: string, value: () => string) {
  if (typeof window === "undefined") return;
  pendingWrites.set(key, value);
  if (flushScheduled) return;
  flushScheduled = true;
  const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
  if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(flushAskCacheWrites, { timeout: 2000 });
  else setTimeout(flushAskCacheWrites, 300);
}

/** Writes what is waiting for localStorage now. */
export function flushAskCacheWrites() {
  flushScheduled = false;
  if (typeof window === "undefined") return;
  const writes = [...pendingWrites];
  pendingWrites.clear();
  for (const [key, value] of writes) {
    try {
      localStorage.setItem(key, value());
    } catch {}
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushAskCacheWrites);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAskCacheWrites();
  });
}

/** Forgets the last opened conversation (a new chat): a write still waiting would bring it back. */
export function clearLocalConvSnapshot() {
  pendingWrites.delete(SNAPSHOT_KEY);
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
    localStorage.removeItem(LEGACY_SNAPSHOT_KEY);
  } catch {}
}

const KEPT_OUTPUT_CHARS = 8000;
const KEPT_EVENTS = 200;

/** A tool call as kept in localStorage: the tail of long output and the last steps, enough to show
 *  the conversation at once before the saved one arrives. */
function compactToolCall(call: ToolCallItem): ToolCallItem {
  const r = call.result;
  if (!r) return call;
  const tooLong = (v?: string) => typeof v === "string" && v.length > KEPT_OUTPUT_CHARS;
  if (!tooLong(r.stdout) && !tooLong(r.stderr) && !(r.events && r.events.length > KEPT_EVENTS)) return call;
  return {
    ...call,
    result: {
      ...r,
      ...(tooLong(r.stdout) ? { stdout: r.stdout!.slice(-KEPT_OUTPUT_CHARS) } : {}),
      ...(tooLong(r.stderr) ? { stderr: r.stderr!.slice(-KEPT_OUTPUT_CHARS) } : {}),
      ...(r.events && r.events.length > KEPT_EVENTS ? { events: r.events.slice(-KEPT_EVENTS) } : {}),
    },
  };
}

function compactTurnsForStorage(turns: Turn[]): Turn[] {
  return turns.map((t) => (t.toolCalls?.length ? { ...t, toolCalls: t.toolCalls.map(compactToolCall) } : t));
}

export function getLocalConvSnapshot(): LocalConvSnapshot | null {
  if (typeof window === "undefined") return null;
  if (pendingWrites.has(SNAPSHOT_KEY)) flushAskCacheWrites();
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
    writeLater(SNAPSHOT_KEY, () => JSON.stringify({ ...snapshot, turns: compactTurnsForStorage(snapshot.turns) }));
  } catch {}
}

export interface CachedConversationConfig {
  executionMode?: ExecutionMode;
  model?: string;
  effort?: string;
  cwd?: string;
  selectedDevice?: string;
  selectedProjectId?: string;
  selectedProjectTitle?: string;
  selectedSessionId?: string;
  worktreeMode?: boolean;
}

// Module-level in-memory caches for true zero-latency instant navigation and refreshing
export const conversationTurnsCache = new Map<string, { turns: Turn[]; config?: CachedConversationConfig }>();
const capabilitiesMemoryCache = new Map<string, AgentCapabilities>();
const projectsMemoryCache = new Map<string, ProjectSummary[]>();
const sessionsMemoryCache = new Map<string, ProjectSession[]>();
const pendingPrefetchIds = new Set<string>();

export const CONVERSATIONS_CACHE_KEY = "memento_cached_ask_convs";
export const QUOTAS_CACHE_KEY = "memento_agent_quotas_cache";
const RECENT_TURNS_CACHE_KEY = "memento_recent_conv_turns_cache_v1";

type RecentConvEntry = { id: string; turns: Turn[]; config: CachedConversationConfig; updatedAt: number };
const RECENT_CONVS_KEPT = 10;
// The list as stored, read once: parsing it again for every conversation opened was the cost
let recentConvEntries: RecentConvEntry[] = [];

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
            recentConvEntries.push(item);
          }
        }
      }
    }
  } catch {}
}

if (typeof window !== "undefined") {
  loadRecentConvTurnsIntoMemory();
}

export function saveToRecentConvTurnsCache(
  id: string,
  turns: Turn[],
  data?: Partial<AskConversationDetail> | Record<string, any> | null
) {
  if (!id || !Array.isArray(turns) || turns.length === 0) return;
  try {
    const d = data as (Partial<AskConversationDetail> & { config?: Record<string, any> }) | undefined;
    const config: CachedConversationConfig = {
      executionMode: (d?.execution_mode || d?.config?.execution_mode) as ExecutionMode | undefined,
      model: d?.model ?? d?.config?.model,
      effort: d?.effort ?? d?.config?.effort,
      cwd: d?.cwd || d?.config?.cwd || undefined,
      selectedDevice: d?.device_id || d?.config?.device_id || undefined,
      selectedProjectId: d?.project_id || d?.config?.project_id,
      selectedProjectTitle: d?.project_title,
      selectedSessionId: d?.session_id || d?.config?.session_id,
      worktreeMode: Boolean(d?.worktree ?? d?.config?.worktree),
    };

    conversationTurnsCache.set(id, { turns, config });

    if (typeof window === "undefined") return;

    const recent = turns.slice(-30);
    recentConvEntries = [
      { id, turns: recent, config, updatedAt: Date.now() },
      ...recentConvEntries.filter((item) => item.id !== id),
    ].slice(0, RECENT_CONVS_KEPT);

    // Trimmed when written (idle), not here: this runs as a conversation opens
    writeLater(RECENT_TURNS_CACHE_KEY, () =>
      JSON.stringify(
        recentConvEntries.map((item) => ({
          ...item,
          turns: compactTurnsForStorage(
            item.turns.map((t) => ({
              role: t.role,
              content: t.content && t.content.length > 40000 ? t.content.slice(0, 40000) : t.content,
              thinking: t.thinking,
              sources: t.sources,
              toolCalls: t.toolCalls,
              error: t.error,
              created_at: t.created_at,
              started_at: t.started_at,
              duration_ms: t.duration_ms,
            }))
          ),
        }))
      )
    );
  } catch {}
}

const prefetchTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Intelligent hover-debounced prefetch: only triggers network fetch when user's cursor
 * hovers on the conversation for >140ms, eliminating request storms during fast scrolling.
 */
export function prefetchConversationTurns(id: string, delayMs = 140) {
  if (!id || conversationTurnsCache.has(id) || pendingPrefetchIds.has(id)) return;

  const existing = prefetchTimers.get(id);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    prefetchTimers.delete(id);
    if (conversationTurnsCache.has(id) || pendingPrefetchIds.has(id)) return;
    pendingPrefetchIds.add(id);
    try {
      const data = await api.getAskConversation(id, 40);
      if (data && data.id && Array.isArray(data.turns)) {
        saveToRecentConvTurnsCache(data.id, data.turns, data);
      }
    } catch {} finally {
      pendingPrefetchIds.delete(id);
    }
  }, delayMs);

  prefetchTimers.set(id, timer);
}

export function cancelPrefetchConversationTurns(id: string) {
  const existing = prefetchTimers.get(id);
  if (existing) {
    clearTimeout(existing);
    prefetchTimers.delete(id);
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
