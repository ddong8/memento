"use client";

import { Suspense, memo, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { getApiBase, authFetch, api, DeviceSummary, AskConversationSummary, ProjectSummary, type AgentQuotasResponse } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { Icon, ToolGlyph } from "@/components/aurora/Icon";
import { BrandMark } from "@/components/aurora/BrandMark";
import { Btn, Chip, Glass, GhostInput, TopBar } from "@/components/aurora/primitives";
import { showInAppToast } from "@/lib/native-notify";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";
import { MediaInspectorProvider, useMediaInspector } from "@/components/viewers/MediaInspectorContext";
import { MediaInspectorPanel } from "@/components/viewers/MediaInspectorPanel";
import { ExecutionTabs, ToolCallItem } from "@/components/ExecutionCard";
import { mergeTaskEvent, type TaskEvent } from "@memento/core";
import { AgentQuotaPopover } from "@/components/quota/AgentQuotaPopover";

export type ExecutionMode = "ai" | "claude" | "codex" | "antigravity" | "shell";

import type { AgentCapabilities, AgentModelOption, AgentEffortOption } from "@/lib/api-client";

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
    { id: "sonnet", name: "sonnet (官方动态最新 Sonnet 别名)", desc: "自动映射当前官方最新 Sonnet (当前为 Claude Sonnet 5)" },
    { id: "opus", name: "opus (官方动态最新 Opus 别名)", desc: "高阶架构与超大上下文 (当前为 Claude Opus 5)" },
    { id: "fable", name: "fable (官方动态最新 Fable 别名)", desc: "官方推荐别名，最强智能体与高阶科学推理 (当前为 Claude Fable 5.1)" },
    { id: "opus[1m]", name: "opus[1m] (100万上下文增强版)", desc: "超大上下文深度思维推演" },
    { id: "haiku", name: "haiku (官方动态最新 Haiku 别名)", desc: "极速轻量日常模型 (当前为 Claude Haiku 4.5)" },
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
};

interface Source {
  id: string;
  title: string;
  relative_path: string;
  tool_id: string;
  category: string;
  synced_at: string | null;
  excerpt: string;
}

/** Where a client is in a run's event stream (see server services/ask_runs.py). */
interface RunCursor {
  lastId: number;
  convId: string | null;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  images?: string[];
  thinking?: string;
  sources?: Source[];
  toolCalls?: ToolCallItem[];
  error?: boolean;
}

function compressImageToDataUrl(file: File, maxDim = 2048, quality = 0.85): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(e.target?.result as string);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
        const dataUrl = canvas.toDataURL(mime, quality);
        resolve(dataUrl);
      };
      img.onerror = () => resolve(e.target?.result as string);
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function parseTurnContent(turn: Turn): { thinking: string; content: string } {
  let thinking = (turn.thinking || "").trim();
  let content = turn.content || "";

  if (content.includes("<think>")) {
    const match = content.match(/<think>([\s\S]*?)(?:<\/think>|$)/);
    if (match) {
      if (!thinking) {
        thinking = match[1].trim();
      }
      content = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim();
    }
  }
  return { thinking, content };
}

function ThinkingBlock({ thinking, isLive }: { thinking: string; isLive?: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<boolean>(false);

  if (!thinking && !isLive) return null;

  return (
    <div
      style={{
        marginBottom: 12,
        borderRadius: 12,
        border: "1px solid var(--aurora-border)",
        background: "rgba(255, 255, 255, 0.02)",
        overflow: "hidden",
        maxWidth: "100%",
        minWidth: 0,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          fontSize: 12.5,
          color: "var(--aurora-fg3)",
          textAlign: "left",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon
            name="brain"
            size={14}
            style={{
              color: isLive ? "var(--aurora-accent)" : "#D97706",
              animation: isLive ? "pulse 1.5s infinite" : "none",
            }}
          />
          <span style={{ fontWeight: 500, color: isLive ? "var(--aurora-accent)" : "var(--aurora-fg2)" }}>
            {isLive ? t.ask.thinking : t.ask.thinkingDone}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "var(--aurora-fg4)" }}>
          <span>{expanded ? t.ask.hideThinking : t.ask.showThinking}</span>
          <Icon name={expanded ? "chevron_up" : "chevron_down"} size={13} />
        </div>
      </button>
      {expanded && (
        <div
          style={{
            borderTop: "1px solid var(--aurora-border)",
            padding: "10px 14px",
            background: "rgba(0, 0, 0, 0.12)",
            fontSize: 13,
            lineHeight: 1.6,
            color: "var(--aurora-fg2)",
            overflowWrap: "anywhere",
            wordBreak: "break-word",
            maxWidth: "100%",
          }}
        >
          <div className="prose prose-sm max-w-full text-xs" style={{ opacity: 0.9 }}>
            <MarkdownViewer content={thinking || "..."} />
          </div>
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(dateStr: string | null, isZh: boolean): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return isZh ? "刚刚" : "just now";
  if (mins < 60) return isZh ? `${mins} 分钟前` : `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return isZh ? `${hrs} 小时前` : `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return isZh ? `${days} 天前` : `${days}d ago`;
  return d.toLocaleDateString();
}

function formatExcerpt(raw: string): string {
  if (!raw) return "";
  let text = raw.trim();

  // If text is wrapped in or contains raw JSON line(s)
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const obj = JSON.parse(text);
      if (obj.content) {
        text = typeof obj.content === "string" ? obj.content : JSON.stringify(obj.content);
      } else if (obj.payload?.message) {
        text = obj.payload.message;
      } else if (obj.message?.content) {
        const mc = obj.message.content;
        text = typeof mc === "string" ? mc : JSON.stringify(mc);
      } else if (obj.type === "session_meta") {
        return "会话启动信息";
      }
    } catch {
      // not a single JSON
    }
  }

  // Strip Antigravity & AI tool XML tags
  text = text.replace(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/g, "用户: $1");
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "");
  text = text.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "");
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  text = text.replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "");

  // If still raw session_meta JSON
  if (text.startsWith('{"timestamp"') && text.includes('"session_meta"')) {
    return "会话启动信息";
  }

  return text.trim();
}

const UserBubble = memo(function UserBubble({
  content,
  images,
}: {
  content: string;
  images?: string[];
}) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <div
        style={{
          background: "var(--aurora-accent-soft)",
          color: "var(--aurora-fg1)",
          padding: "11px 16px",
          borderRadius: 16,
          maxWidth: "min(88%, 680px)",
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          boxShadow: "0 2px 10px rgba(0,0,0,0.1)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {images && images.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: content ? 4 : 0,
            }}
          >
            {images.map((imgUrl, idx) => (
              <div
                key={idx}
                style={{
                  position: "relative",
                  borderRadius: 12,
                  overflow: "hidden",
                  border: "1px solid rgba(255, 255, 255, 0.18)",
                  boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
                  maxWidth: images.length === 1 ? "100%" : 240,
                  maxHeight: 280,
                  cursor: "pointer",
                  background: "rgba(0,0,0,0.2)",
                }}
                onClick={() => {
                  window.open(imgUrl, "_blank");
                }}
                title="点击在新标签页查看高清原图"
              >
                <img
                  src={imgUrl}
                  alt={`Attachment ${idx + 1}`}
                  style={{
                    display: "block",
                    maxWidth: "100%",
                    maxHeight: 280,
                    objectFit: "contain",
                    borderRadius: 12,
                  }}
                />
              </div>
            ))}
          </div>
        )}
        {content && (
          <div
            className="prose prose-sm max-w-none"
            style={{
              fontSize: 14,
              lineHeight: 1.55,
              whiteSpace: "normal",
              color: "var(--aurora-fg1)",
            }}
          >
            <MarkdownViewer content={content} compactText={true} />
          </div>
        )}
      </div>
    </div>
  );
});

const AssistantBubble = memo(function AssistantBubble({
  turn,
  isLast,
  streaming,
  onSourcesClick,
  onSmartCompactAndRetry,
  t,
}: {
  turn: Turn;
  isLast: boolean;
  streaming: boolean;
  onSourcesClick: (sources: Source[]) => void;
  onSmartCompactAndRetry: (sid?: string) => void;
  t: any;
}) {
  const { thinking, content } = parseTurnContent(turn);
  const isThinkingActive = Boolean(streaming && isLast && !content);
  const hasTools = Boolean(turn.toolCalls && turn.toolCalls.length > 0);

  return (
    <Glass padding="clamp(12px, 3vw, 20px)" radius={18} style={{ maxWidth: "100%", minWidth: 0, overflow: "hidden" }}>
      {turn.sources && turn.sources.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", marginBottom: 10 }}>
          <button
            type="button"
            onClick={() => onSourcesClick(turn.sources || [])}
            title={t.ask.sources}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              borderRadius: 999,
              background: "var(--aurora-chip)",
              border: "1px solid var(--aurora-border)",
              color: "var(--aurora-fg2)",
              fontSize: 12,
              cursor: "pointer",
              transition: "all 0.15s ease",
            }}
          >
            <Icon name="book" size={13} style={{ color: "var(--aurora-accent)" }} />
            <span>{t.ask.sources}</span>
            <span
              style={{
                fontSize: 10.5,
                padding: "1px 6px",
                borderRadius: 999,
                background: "rgba(56, 189, 248, 0.15)",
                color: "var(--aurora-accent)",
                fontWeight: 600,
              }}
            >
              {turn.sources.length}
            </span>
          </button>
        </div>
      )}
      {(thinking || isThinkingActive) && (
        <ThinkingBlock thinking={thinking} isLive={isThinkingActive} />
      )}
      {hasTools && (
        <div style={{ marginBottom: 12 }}>
          <ExecutionTabs
            calls={turn.toolCalls!}
            parentContent={content}
            onSmartCompactAndRetry={onSmartCompactAndRetry}
          />
        </div>
      )}
      {content ? (
        <div className="prose prose-sm max-w-none" style={{ fontSize: 14, lineHeight: 1.6 }}>
          <MarkdownViewer content={content} />
        </div>
      ) : (
        !hasTools && !thinking && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--aurora-fg4)", fontSize: 13 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--aurora-accent)",
                animation: "pulse 1s infinite",
              }}
            />
            {t.ask.thinking}
          </div>
        )
      )}
    </Glass>
  );
});

interface CachedAskState {
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
}

// Module-level in-memory cache to preserve state when switching menus in-app
let askCache: CachedAskState | null = null;

function AskPageContent() {
  const searchParams = useSearchParams();
  const inspector = useMediaInspector();
  const syncTurnsMedia = inspector?.syncTurnsMedia;
  const [turns, setTurns] = useState<Turn[]>(() => askCache?.turns || []);

  // 自动将当前对话所有轮次中的媒体同步至右侧独立视窗列表中（使用稳定方法引用，防止循环渲染卡死）
  useEffect(() => {
    syncTurnsMedia?.(turns);
  }, [turns, syncTurnsMedia]);

  const [input, setInput] = useState(() => askCache?.input || "");
  const [streaming, setStreaming] = useState(false);
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>(() => askCache?.selectedDevice || "auto");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(() => askCache?.executionMode || "ai");
  const [cwd, setCwd] = useState<string>(() => askCache?.cwd || "");
  const [showCwd, setShowCwd] = useState<boolean>(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // Agent Context: Model, Project & Session selection
  const [selectedModel, setSelectedModel] = useState<string>(() => askCache?.selectedModel || "");
  /** Run agent tasks in their own git worktree and branch. */
  const [worktreeMode, setWorktreeMode] = useState<boolean>(() => askCache?.worktreeMode || false);
  const [selectedEffort, setSelectedEffort] = useState<string>(() => askCache?.selectedEffort || "");
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(() => askCache?.capabilities || null);
  const [isCustomModel, setIsCustomModel] = useState<boolean>(false);
  const [projects, setProjects] = useState<ProjectSummary[]>(() => askCache?.projects || []);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => askCache?.selectedProjectId || "");
  const [sessions, setSessions] = useState<
    Array<{
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
    }>
  >(() => askCache?.sessions || []);
  const [selectedSessionId, setSelectedSessionId] = useState<string>(() => askCache?.selectedSessionId || "");
  const [compactMode, setCompactMode] = useState<boolean>(() => askCache?.compactMode || false);
  const [loadingSessions, setLoadingSessions] = useState<boolean>(false);
  const [showSessionContext, setShowSessionContext] = useState<boolean>(true);
  const [isConfigCollapsed, setIsConfigCollapsed] = useState<boolean>(false);
  const [attachedImages, setAttachedImages] = useState<
    Array<{ id: string; name: string; dataUrl: string; size: number }>
  >([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastPasteTimeRef = useRef<number>(0);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const newImgs: Array<{ id: string; name: string; dataUrl: string; size: number }> = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.type.startsWith("image/")) continue;
      try {
        const dataUrl = await compressImageToDataUrl(file);
        newImgs.push({ id: crypto.randomUUID(), name: file.name, dataUrl, size: file.size });
      } catch (err) {
        console.error("Failed to compress image:", err);
      }
    }
    if (newImgs.length > 0) {
      setAttachedImages((prev) => {
        const existingUrls = new Set(prev.map((img) => img.dataUrl));
        const toAdd = newImgs.filter((img) => !existingUrls.has(img.dataUrl));
        return [...prev, ...toAdd];
      });
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const removeAttachedImage = useCallback((id: string) => {
    setAttachedImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const handlePaste = useCallback(async (e: React.ClipboardEvent | ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    // 提取所有图片 items
    const rawImageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) rawImageFiles.push(file);
      }
    }
    if (rawImageFiles.length === 0) return;

    // 防抖：400ms 内忽略重复触发（如 React SyntheticEvent 与原生 DOM 事件冒泡重叠）
    const now = Date.now();
    if (now - lastPasteTimeRef.current < 400) {
      e.preventDefault();
      return;
    }
    lastPasteTimeRef.current = now;
    e.preventDefault();

    // Windows 剪贴板常对单次截图同时生成多种格式（如 image/png 与 image/jpeg/bmp），相同字节大小视为同一张图，去重只保留首个
    const imageFiles: File[] = [];
    const seenSizes = new Set<number>();
    for (const file of rawImageFiles) {
      if (seenSizes.has(file.size)) continue;
      seenSizes.add(file.size);
      imageFiles.push(file);
    }

    const newImgs: Array<{ id: string; name: string; dataUrl: string; size: number }> = [];
    for (const file of imageFiles) {
      try {
        const dataUrl = await compressImageToDataUrl(file);
        newImgs.push({
          id: crypto.randomUUID(),
          name: file.name || "pasted_image.png",
          dataUrl,
          size: file.size,
        });
      } catch (err) {
        console.error("Failed to process pasted image:", err);
      }
    }

    if (newImgs.length > 0) {
      setAttachedImages((prev) => {
        const existingUrls = new Set(prev.map((img) => img.dataUrl));
        const toAdd = newImgs.filter((img) => !existingUrls.has(img.dataUrl));
        return [...prev, ...toAdd];
      });
    }
  }, []);

  useEffect(() => {
    const onWindowPaste = (e: ClipboardEvent) => {
      // 若焦点在输入框/文本域内，已有 GhostInput 自身的 onPaste 处理，避免冒泡至 window 二次触发
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.defaultPrevented) return;

      const items = e.clipboardData?.items;
      if (!items) return;
      let hasImage = false;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          hasImage = true;
          break;
        }
      }
      if (hasImage) {
        handlePaste(e);
      }
    };
    window.addEventListener("paste", onWindowPaste);
    return () => window.removeEventListener("paste", onWindowPaste);
  }, [handlePaste]);

  const projectsRef = useRef<ProjectSummary[]>([]);
  projectsRef.current = projects;
  const selectedProjectIdRef = useRef<string>("");
  selectedProjectIdRef.current = selectedProjectId;

  useEffect(() => {
    try {
      const saved = localStorage.getItem("memento_ask_config_collapsed");
      if (saved !== null) {
        setIsConfigCollapsed(saved === "true");
      } else if (typeof window !== "undefined" && window.innerWidth < 768) {
        setIsConfigCollapsed(true);
      }
    } catch {}
  }, []);

  const toggleConfigCollapsed = useCallback(() => {
    setIsConfigCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("memento_ask_config_collapsed", String(next));
      } catch {}
      return next;
    });
  }, []);

  // Conversation history state
  const [conversations, setConversations] = useState<AskConversationSummary[]>(() => askCache?.conversations || []);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => askCache?.activeConversationId || null);
  const activeConversationIdRef = useRef<string | null>(askCache?.activeConversationId || null);
  const streamingRef = useRef<boolean>(false);
  const isRestoringRef = useRef<boolean>(false);
  const lastRestoredIdRef = useRef<string | null>(askCache?.activeConversationId || null);
  const [historyOpen, setHistoryOpen] = useState<boolean>(false);
  const [loadingHistory, setLoadingHistory] = useState<boolean>(false);
  const [quotaOpen, setQuotaOpen] = useState<boolean>(false);
  const [quotasData, setQuotasData] = useState<AgentQuotasResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchQuotas = async () => {
      try {
        const res = await api.getAgentQuotas(selectedDevice);
        if (!cancelled && res) {
          setQuotasData(res);
        }
      } catch {
        // ignore
      }
    };
    fetchQuotas();
    const interval = setInterval(fetchQuotas, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedDevice]);

  const getModeQuotaSummary = (mode: ExecutionMode): { label: string; percent?: number; isPro?: boolean } | null => {
    if (!quotasData?.tools) return null;
    if (mode === "antigravity") {
      const agy = quotasData.tools.antigravity;
      if (!agy || !agy.available) return null;
      return {
        label: agy.remaining_percent != null ? `${agy.remaining_percent}%` : (agy.plan_name || "Pro"),
        percent: agy.remaining_percent ?? undefined,
        isPro: true,
      };
    }
    if (mode === "claude") {
      const c = quotasData.tools.claude_code;
      if (!c || !c.available) return null;
      return {
        label: c.remaining_percent != null && c.remaining_percent < 100 ? `${c.remaining_percent}%` : (c.tier || "PRO"),
        percent: c.remaining_percent ?? 100,
        isPro: (c.tier || "").toUpperCase().includes("PRO"),
      };
    }
    if (mode === "codex") {
      const cx = quotasData.tools.codex;
      if (!cx || !cx.available) return null;
      return {
        label: cx.tier || (cx.plan_name ? cx.plan_name.replace("ChatGPT ", "") : "FREE"),
        percent: cx.remaining_percent ?? 100,
        isPro: (cx.tier || "").toUpperCase().includes("PRO") || (cx.tier || "").toUpperCase().includes("PLUS"),
      };
    }
    return null;
  };

  // Sync state continuously into in-memory cache so switching tabs/menus retains all data
  useEffect(() => {
    askCache = {
      activeConversationId,
      turns,
      input,
      conversations,
      selectedDevice,
      cwd,
      executionMode,
      selectedModel,
      selectedEffort,
      worktreeMode,
      selectedProjectId,
      selectedSessionId,
      compactMode,
      projects,
      sessions,
      capabilities,
      scrollTop: chatScrollRef.current?.scrollTop ?? askCache?.scrollTop ?? 0,
    };
  }, [
    activeConversationId,
    turns,
    input,
    conversations,
    selectedDevice,
    cwd,
    executionMode,
    selectedModel,
    selectedEffort,
    worktreeMode,
    selectedProjectId,
    selectedSessionId,
    compactMode,
    projects,
    sessions,
    capabilities,
  ]);

  // Sources drawer state
  const [sourcesOpen, setSourcesOpen] = useState<boolean>(false);
  const [selectedSources, setSelectedSources] = useState<Source[]>([]);

  const { t, locale } = useI18n();
  const isZh = locale.startsWith("zh");
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // RAF-batched streaming: accumulate updates, flush once per frame
  const turnsRef = useRef<Turn[]>([]);
  const rafIdRef = useRef<number>(0);
  const turnsDirtyRef = useRef(false);

  const [historyFilterDevice, setHistoryFilterDevice] = useState<boolean>(true);

  // Load conversation list
  const loadConversations = useCallback(async (filterDev?: boolean) => {
    try {
      if (conversations.length === 0) {
        setLoadingHistory(true);
      }
      const shouldFilter = filterDev !== undefined ? filterDev : historyFilterDevice;
      const devId = (shouldFilter && selectedDevice && selectedDevice !== "auto" && selectedDevice !== "ask_only")
        ? selectedDevice
        : undefined;
      const list = await api.listAskConversations(devId);
      setConversations(list || []);
    } catch (e) {
      console.error("Failed to load ask conversations:", e);
    } finally {
      setLoadingHistory(false);
    }
  }, [historyFilterDevice, selectedDevice, conversations.length]);

  // Declared further down; loadConversation reaches it through this ref.
  const attachRunRef = useRef<((convId: string, question: string, baseTurns: Turn[]) => Promise<void>) | null>(null);

  // Helper to persist updated configuration for current conversation if one is active
  const persistCurrentConfig = useCallback((patch: Record<string, any>) => {
    const convId = activeConversationIdRef.current;
    if (!convId || streamingRef.current || isRestoringRef.current) return;
    api.updateAskConversation(convId, patch).catch(() => {});
  }, []);

  const normalizeDeviceId = useCallback(
    (devStr?: string | null) => {
      if (!devStr || devStr === "auto" || devStr === "ask_only" || devStr === "all") return devStr || "auto";
      const found = devices.find(
        (d) => d.device_id === devStr || d.id === devStr || d.name === devStr || d.name?.toLowerCase() === devStr.toLowerCase()
      );
      return found ? found.device_id : devStr;
    },
    [devices]
  );

  // Defensive extraction helper to infer executionMode, model, effort, project, session, cwd, device from turns
  const inferConfigFromTurns = useCallback((turnsList: Turn[]) => {
    const res: {
      executionMode?: ExecutionMode;
      deviceId?: string;
      cwd?: string;
      projectId?: string;
      sessionId?: string;
      model?: string;
      effort?: string;
    } = {};

    for (let i = turnsList.length - 1; i >= 0; i--) {
      const turn = turnsList[i];
      const calls = turn.toolCalls || (turn as any).tool_calls || [];
      for (let j = calls.length - 1; j >= 0; j--) {
        const call = calls[j];
        if (!call) continue;

        let args: Record<string, any> = {};
        if (typeof call.args === "object" && call.args !== null) {
          args = call.args as Record<string, any>;
        } else if (typeof call.args === "string") {
          try { args = JSON.parse(call.args); } catch {}
        }

        let resObj: Record<string, any> = {};
        if (typeof call.result === "object" && call.result !== null) {
          resObj = call.result as Record<string, any>;
        } else if (typeof call.result === "string") {
          try { resObj = JSON.parse(call.result); } catch {}
        }

        let callObj: Record<string, any> = {};
        if (typeof (call as any).call === "object" && (call as any).call !== null) {
          callObj = (call as any).call as Record<string, any>;
        }

        const binary = (
          (args.binary as string) ||
          ((call as any).binary as string) ||
          (callObj.binary as string) ||
          (resObj.binary as string) ||
          ""
        ).toLowerCase().trim();

        const action = (
          (resObj.action as string) ||
          (args.action as string) ||
          (call.name === "run_on_device" ? "shell" : call.name) ||
          ""
        ).toLowerCase().trim();

        const name = (call.name || callObj.name || "").toLowerCase().trim();
        const cmd = (
          (args.command as string) ||
          (args.prompt as string) ||
          (callObj.command as string) ||
          ((call as any).command as string) ||
          ""
        ).toLowerCase().trim();

        let detectedMode: ExecutionMode | undefined;
        if (binary.includes("claude") || name === "claude" || cmd.includes("[claude")) {
          detectedMode = "claude";
        } else if (binary.includes("codex") || name === "codex" || cmd.includes("[codex")) {
          detectedMode = "codex";
        } else if (binary.includes("agy") || binary.includes("antigravity") || name === "antigravity" || cmd.includes("[antigravity") || cmd.includes("[agy")) {
          detectedMode = "antigravity";
        } else if (action === "shell" || ["bash", "sh", "zsh"].includes(binary) || cmd.includes("[shell")) {
          detectedMode = "shell";
        }

        if (detectedMode && !res.executionMode) {
          res.executionMode = detectedMode;
        }

        const pid = (args.project_id as string) || (callObj.project_id as string) || (resObj.project_id as string);
        if (pid && !res.projectId) {
          res.projectId = String(pid);
        }

        const sid = (resObj.session_id as string) || (args.session_id as string) || (callObj.session_id as string);
        if (sid && !res.sessionId) {
          res.sessionId = String(sid);
        }

        const mod = (args.model as string) || (callObj.model as string);
        if (mod && !res.model) {
          res.model = String(mod);
        }

        const eff = (args.effort as string) || (callObj.effort as string);
        if (eff && !res.effort) {
          res.effort = String(eff);
        }

        const tcCwd = (args.cwd as string) || (callObj.cwd as string);
        if (tcCwd && !res.cwd) {
          res.cwd = String(tcCwd);
        }

        const dev = (
          (resObj.device_name as string) ||
          call.device_name ||
          (args.device_id as string) ||
          (resObj.device_id as string) ||
          (callObj.device_name as string)
        );
        if (dev && !res.deviceId) {
          res.deviceId = String(dev);
        }

        if (res.executionMode && res.sessionId && res.projectId) {
          return res;
        }
      }
    }
    return res;
  }, []);

  // Load single conversation
  const loadConversation = useCallback(async (id: string) => {
    if (!id || streamingRef.current) return;
    isRestoringRef.current = true;
    lastRestoredIdRef.current = id;
    try {
      const data = await api.getAskConversation(id);
      activeConversationIdRef.current = data.id;
      setActiveConversationId(data.id);
      window.history.replaceState(null, "", `/ask?id=${data.id}`);
      try {
        localStorage.setItem("memento_last_ask_conv_id", data.id);
      } catch {}

      // 1. Device, cwd, and turns
      let targetDev = data.device_id || "";
      let targetCwd = data.cwd || "";
      const loadedTurns = data.turns || [];
      setTurns(loadedTurns);
      setHistoryOpen(false);
      setSourcesOpen(false);

      // 2. Execution mode, model, effort, project, session
      let targetMode = ((data.execution_mode || data.config?.execution_mode || "ai") as ExecutionMode);
      let targetModel = data.model || data.config?.model || "";
      let targetEffort = data.effort || data.config?.effort || "";
      let targetProjId = data.project_id || data.config?.project_id || "";
      let targetSessionId = data.session_id || data.config?.session_id || "";

      // Defensive infer if returned mode was generic "ai"
      if (targetMode === "ai" || !targetMode) {
        const inferred = inferConfigFromTurns(loadedTurns);
        if (inferred.executionMode) targetMode = inferred.executionMode;
        if (!targetProjId && inferred.projectId) targetProjId = inferred.projectId;
        if (!targetSessionId && inferred.sessionId) targetSessionId = inferred.sessionId;
        if (!targetModel && inferred.model) targetModel = inferred.model;
        if (!targetEffort && inferred.effort) targetEffort = inferred.effort;
        if (!targetCwd && inferred.cwd) targetCwd = inferred.cwd;
        if (!targetDev && inferred.deviceId) targetDev = inferred.deviceId;

        // Persist inferred configuration back to server DB
        if (targetMode !== "ai") {
          api.updateAskConversation(data.id, {
            execution_mode: targetMode,
            project_id: targetProjId,
            session_id: targetSessionId,
            model: targetModel,
            effort: targetEffort,
            cwd: targetCwd,
            device_id: targetDev,
          }).catch(() => {});
        }
      }

      const devToUse = normalizeDeviceId(targetDev) || "auto";
      setSelectedDevice(devToUse);
      if (targetCwd) {
        setCwd(targetCwd);
        setShowCwd(true);
      } else {
        setCwd("");
      }

      setExecutionMode(targetMode);
      setSelectedModel(targetModel);
      setIsCustomModel(Boolean(targetModel && !FALLBACK_AGENT_MODELS[targetMode]?.some((m) => m.id === targetModel)));
      setSelectedEffort(targetEffort);

      const isWorktree = Boolean(data.worktree ?? data.config?.worktree ?? false);
      setWorktreeMode(isWorktree);

      setCompactMode(false);

      // 3. Project and Session restoration
      if (["codex", "claude", "antigravity"].includes(targetMode)) {
        const toolMap: Record<string, string> = {
          codex: "codex",
          claude: "claude_code",
          antigravity: "antigravity",
        };
        const toolId = toolMap[targetMode];
        if (toolId) {
          try {
            const devForQuery = devToUse !== "auto" && devToUse !== "ask_only" && devToUse !== "all" ? devToUse : undefined;
            let projList = await api.listProjects(toolId, devForQuery);
            if ((!projList || projList.length === 0) && devForQuery) {
              projList = await api.listProjects(toolId);
            }
            const projs = projList || [];
            setProjects(projs);

            let matchedProj = targetProjId ? projs.find((p) => p.id === targetProjId) : undefined;
            if (!matchedProj && targetCwd) {
              const cleanCwd = targetCwd.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
              const folderName = cleanCwd.split("/").filter(Boolean).pop();
              matchedProj = projs.find((p) => {
                if (!p.source_path) return false;
                const sp = p.source_path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
                if (sp === cleanCwd) return true;
                if (sp.endsWith(cleanCwd) || cleanCwd.endsWith(sp)) return true;
                if (sp.includes(cleanCwd) || cleanCwd.includes(sp)) return true;
                if (folderName && (p.title?.toLowerCase() === folderName || p.slug?.toLowerCase() === folderName)) return true;
                return false;
              });
            }

            const effectiveProjId = matchedProj ? matchedProj.id : targetProjId;
            if (effectiveProjId) {
              setSelectedProjectId(effectiveProjId);
              selectedProjectIdRef.current = effectiveProjId;
              setLoadingSessions(true);
              try {
                let res = await api.getProjectConversations(effectiveProjId, 0, 50, "desc", devForQuery);
                let sessList = res?.sessions || [];
                if ((!sessList || sessList.length === 0) && devForQuery) {
                  res = await api.getProjectConversations(effectiveProjId, 0, 50, "desc");
                  sessList = res?.sessions || [];
                }
                setSessions(sessList);
                setSelectedSessionId(targetSessionId);
              } catch (e) {
                console.error("Failed to restore project sessions:", e);
                setSessions([]);
                setSelectedSessionId(targetSessionId);
              } finally {
                setLoadingSessions(false);
              }
            } else {
              setSelectedProjectId("");
              selectedProjectIdRef.current = "";
              setSessions([]);
              setSelectedSessionId(targetSessionId);
            }
          } catch (e) {
            console.error("Failed to load projects for mode:", e);
            setProjects([]);
            setSelectedProjectId("");
            selectedProjectIdRef.current = "";
            setSessions([]);
            setSelectedSessionId(targetSessionId);
          }
        }
      } else {
        setProjects([]);
        setSelectedProjectId("");
        selectedProjectIdRef.current = "";
        setSessions([]);
        setSelectedSessionId("");
      }

      // 4. Still running? Show live
      const runRes = await authFetch(`${getApiBase()}/api/ask/conversations/${data.id}/run`);
      if (runRes.ok) {
        const run = await runRes.json();
        if (!run.done) attachRunRef.current?.(data.id, run.question || "", data.turns || []);
      }
    } catch (e) {
      console.error("Failed to load conversation:", e);
    } finally {
      setTimeout(() => {
        isRestoringRef.current = false;
      }, 600);
    }
  }, [inferConfigFromTurns, normalizeDeviceId]);

  // Start fresh chat
  const startNewChat = useCallback(() => {
    abortRef.current?.abort();
    streamingRef.current = false;
    activeConversationIdRef.current = null;
    setActiveConversationId(null);
    setSelectedSessionId("");
    setCompactMode(false);
    setTurns([]);
    setInput("");
    window.history.replaceState(null, "", "/ask");
    try {
      localStorage.removeItem("memento_last_ask_conv_id");
    } catch {}
    askCache = null;
    setHistoryOpen(false);
    setSourcesOpen(false);
  }, []);

  // Delete conversation
  const deleteConversation = useCallback(
    async (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      if (!window.confirm(t.ask.deleteConfirm)) return;
      try {
        await api.deleteAskConversation(id);
        setConversations((prev) => prev.filter((c) => c.id !== id));
        if (activeConversationIdRef.current === id) {
          startNewChat();
        }
      } catch (e) {
        console.error("Failed to delete conversation:", e);
      }
    },
    [startNewChat, t.ask.deleteConfirm]
  );

  // Fetch online/registered devices
  useEffect(() => {
    authFetch(`${getApiBase()}/api/devices`)
      .then((r) => r.json())
      .then((d: DeviceSummary[]) => {
        setDevices(d || []);
      })
      .catch(() => setDevices([]));
  }, []);

  // Check URL params (?id=... or ?q=...)
  const qParam = searchParams.get("q");
  const idParam = searchParams.get("id");
  const deviceParam = searchParams.get("device");
  const modeParam = searchParams.get("mode") as ExecutionMode | null;
  const initialSentRef = useRef(false);

  const loadConversationRef = useRef(loadConversation);
  loadConversationRef.current = loadConversation;
  const loadConversationsRef = useRef(loadConversations);
  loadConversationsRef.current = loadConversations;

  useEffect(() => {
    loadConversationsRef.current();

    const checkAndRestore = async () => {
      // Determine target conversation ID:
      // 1) Explicit URL idParam
      // 2) Stored in localStorage from last session
      // 3) Currently active in askCache
      let resolvedTargetId = idParam;
      if (!resolvedTargetId && !qParam) {
        if (typeof window !== "undefined") {
          resolvedTargetId = localStorage.getItem("memento_last_ask_conv_id") || askCache?.activeConversationId || null;
        }
        if (!resolvedTargetId) {
          try {
            const recent = await api.getRecentActiveConversation();
            if (recent && recent.id) {
              resolvedTargetId = recent.id;
            }
          } catch {}
        }
      }

      // Check server for any active runs for this user
      let activeRunToAttach: any = null;
      try {
        const runsRes = await authFetch(`${getApiBase()}/api/ask/runs`);
        if (runsRes.ok) {
          const activeRuns = await runsRes.json();
          if (Array.isArray(activeRuns) && activeRuns.length > 0) {
            if (resolvedTargetId) {
              activeRunToAttach = activeRuns.find((r: any) => r.conversation_id === resolvedTargetId && !r.done);
            }
            // If user opened /ask with no specific id, but there is an active run, prioritize that active run!
            if (!activeRunToAttach && !idParam && activeRuns[0] && !activeRuns[0].done) {
              activeRunToAttach = activeRuns[0];
              resolvedTargetId = activeRunToAttach.conversation_id;
            }
          }
        }
      } catch (err) {
        console.error("Failed to check active runs:", err);
      }

      if (!resolvedTargetId || streamingRef.current) return;

      if (lastRestoredIdRef.current === resolvedTargetId && activeConversationIdRef.current === resolvedTargetId) {
        return;
      }

      // If an active run is currently ongoing on the server: MUST reattach live stream!
      if (activeRunToAttach) {
        activeConversationIdRef.current = resolvedTargetId;
        setActiveConversationId(resolvedTargetId);
        lastRestoredIdRef.current = resolvedTargetId;
        if (!idParam) {
          window.history.replaceState(null, "", `/ask?id=${resolvedTargetId}`);
        }
        try {
          localStorage.setItem("memento_last_ask_conv_id", resolvedTargetId);
        } catch {}

        let baseTurns = (activeConversationIdRef.current === resolvedTargetId && turns.length > 0)
          ? turns
          : [];
        if (baseTurns.length === 0) {
          try {
            const data = await api.getAskConversation(resolvedTargetId);
            baseTurns = data.turns || [];
          } catch {}
        }
        attachRunRef.current?.(resolvedTargetId, activeRunToAttach.question || "", baseTurns);
        return;
      }

      // If already cached in memory with complete turns and no active background run: keep in-memory state!
      if (
        askCache &&
        askCache.activeConversationId === resolvedTargetId &&
        askCache.turns.length > 0 &&
        turns.length > 0
      ) {
        lastRestoredIdRef.current = resolvedTargetId;
        if (askCache?.scrollTop && chatScrollRef.current) {
          requestAnimationFrame(() => {
            if (chatScrollRef.current && askCache?.scrollTop) {
              chatScrollRef.current.scrollTop = askCache.scrollTop;
            }
          });
        }
        return;
      }

      // Load conversation fresh from DB to ensure runtime mode, project, and session are properly restored!
      loadConversationRef.current(resolvedTargetId);
    };

    checkAndRestore();
  }, [idParam, qParam]);

  // Support instantaneous chat navigation / switching via notifications or banners
  useEffect(() => {
    const handleSwitchChat = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const targetId = detail?.id;
      if (targetId) {
        lastRestoredIdRef.current = null;
        loadConversation(targetId);
      }
    };
    window.addEventListener("memento_switch_chat", handleSwitchChat);
    (window as any).__memento_open_chat = (id: string) => {
      lastRestoredIdRef.current = null;
      loadConversation(id);
    };
    (window as any).__memento_navigate = (url: string) => {
      if (url.includes("/ask")) {
        try {
          const parsed = new URL(url, window.location.origin);
          const id = parsed.searchParams.get("id");
          if (id) {
            window.history.pushState(null, "", `/ask?id=${id}`);
            lastRestoredIdRef.current = null;
            loadConversation(id);
            return;
          }
        } catch {}
      }
      window.location.href = url;
    };
    return () => {
      window.removeEventListener("memento_switch_chat", handleSwitchChat);
      delete (window as any).__memento_open_chat;
      delete (window as any).__memento_navigate;
    };
  }, [loadConversation]);

  // Follow the stream as tokens land — throttled to avoid layout thrash.
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitialScrollMountRef = useRef<boolean>(true);
  useEffect(() => {
    if (isInitialScrollMountRef.current) {
      isInitialScrollMountRef.current = false;
      if (askCache?.scrollTop && chatScrollRef.current) {
        chatScrollRef.current.scrollTop = askCache.scrollTop;
        return;
      }
    }
    if (scrollTimerRef.current) return;
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }, 120);
  }, [turns]);

  // Abort any in-flight stream if the user navigates away mid-answer.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Mobile swipe down on chat area to dismiss keyboard smoothly
  const touchStartY = useRef<number | null>(null);
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
  }, []);
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartY.current === null) return;
    const currentY = e.touches[0].clientY;
    const deltaY = currentY - touchStartY.current;
    if (deltaY > 35) {
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
        (active as HTMLElement).blur();
      }
      touchStartY.current = null;
    }
  }, []);

  // Voice Input (Speech-to-Text) with real-time recognition & smart mobile fallback
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [speechHint, setSpeechHint] = useState<string | null>(null);
  const speechHintTimer = useRef<NodeJS.Timeout | null>(null);
  const recognitionRef = useRef<any>(null);
  const inputElRef = useRef<HTMLInputElement>(null);

  const toggleVoiceInput = useCallback(() => {
    // 1. Instant tactile feedback
    if (typeof window !== "undefined" && (window as any).__memento_haptic) {
      try {
        (window as any).__memento_haptic("medium");
      } catch {}
    }

    if (isRecordingVoice) {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {}
      }
      setIsRecordingVoice(false);
      return;
    }

    const isIOSDevice =
      typeof navigator !== "undefined" &&
      (/iPad|iPhone|iPod/.test(navigator.userAgent || "") ||
        (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1));

    const isMobileShell =
      typeof window !== "undefined" &&
      (!!(window as any).ReactNativeWebView ||
        (typeof navigator !== "undefined" && navigator.userAgent.includes("MementoMobile")));

    // On iOS or within Mobile App, Apple strictly restricts third-party webviews from running
    // Web Speech API (always throwing service-not-allowed).
    // Instead of failing with a permission warning, immediately focus the input synchronously
    // to bring up the iOS keyboard with the Apple Neural Engine dictation microphone.
    if (isIOSDevice || isMobileShell) {
      inputElRef.current?.focus();
      setTimeout(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      }, 80);
      const msg = isZh
        ? "已为您呼出键盘，点击键盘右下角「麦克风」🎤 即可开始语音吩咐！"
        : "Keyboard opened. Tap the mic 🎤 on your keyboard to dictate.";
      showInAppToast(isZh ? "🎙️ 语音吩咐已就绪" : "Voice Input Ready", msg);
      setSpeechHint(msg);
      if (speechHintTimer.current) clearTimeout(speechHintTimer.current);
      speechHintTimer.current = setTimeout(() => setSpeechHint(null), 5000);
      return;
    }

    const SpeechRecognition =
      typeof window !== "undefined"
        ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
        : null;

    if (!SpeechRecognition) {
      inputElRef.current?.focus();
      const msg = isZh
        ? "当前环境暂不支持浏览器内置语音转录，请直接键入文本"
        : "Speech recognition not supported in this browser.";
      showInAppToast(isZh ? "🎙️ 提示" : "Notice", msg);
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.lang = isZh ? "zh-CN" : "en-US";
      recognition.continuous = false;
      recognition.interimResults = true;

      recognition.onstart = () => {
        setIsRecordingVoice(true);
        setSpeechHint(null);
      };

      recognition.onresult = (event: any) => {
        let transcript = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        if (transcript) {
          setInput((prev) => {
            const trimmed = prev.trim();
            return trimmed ? `${trimmed} ${transcript}` : transcript;
          });
        }
      };

      recognition.onerror = (e: any) => {
        console.warn("Speech recognition error:", e);
        setIsRecordingVoice(false);
        const errType = e?.error;
        if (errType === "not-allowed" || errType === "service-not-allowed") {
          inputElRef.current?.focus();
          const fallbackMsg = isZh
            ? "未开启麦克风权限：请在浏览器设置中允许麦克风访问"
            : "Microphone blocked. Please grant microphone access in browser settings.";
          showInAppToast(isZh ? "🎙️ 麦克风提示" : "Microphone Notice", fallbackMsg);
          setSpeechHint(fallbackMsg);
          if (speechHintTimer.current) clearTimeout(speechHintTimer.current);
          speechHintTimer.current = setTimeout(() => setSpeechHint(null), 5000);
        }
      };

      recognition.onend = () => {
        setIsRecordingVoice(false);
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err) {
      console.warn("Failed to start speech recognition:", err);
      setIsRecordingVoice(false);
      inputElRef.current?.focus();
      const fallbackMsg = isZh
        ? "已为您呼出键盘，点击键盘右下角「麦克风」🎤 即可开始语音吩咐！"
        : "Keyboard opened. Tap the mic 🎤 on your keyboard to dictate.";
      showInAppToast(isZh ? "🎙️ 语音吩咐已就绪" : "Voice Input Ready", fallbackMsg);
      setSpeechHint(fallbackMsg);
      if (speechHintTimer.current) clearTimeout(speechHintTimer.current);
      speechHintTimer.current = setTimeout(() => setSpeechHint(null), 5000);
    }
  }, [isRecordingVoice, isZh]);

  useEffect(() => {
    if (deviceParam) {
      setSelectedDevice(deviceParam);
    }
  }, [deviceParam]);

  useEffect(() => {
    if (modeParam && ["ai", "claude", "codex", "antigravity", "shell"].includes(modeParam)) {
      setExecutionMode(modeParam);
    }
  }, [modeParam]);

  // Load dynamic agent capabilities (models, default configs, reasoning effort)
  useEffect(() => {
    if (executionMode === "ai" || executionMode === "shell") {
      setCapabilities(null);
      return;
    }
    let cancelled = false;
    api.getAgentCapabilities(executionMode, selectedDevice)
      .then((data) => {
        if (!cancelled && data) {
          setCapabilities(data);
          if (!isCustomModel) {
            const hasModel = (data.models || []).some((m) => m.id === selectedModel);
            if (!hasModel && selectedModel !== "") {
              setSelectedModel("");
            }
          }
        }
      })
      .catch((err) => {
        console.warn("Failed to load agent capabilities:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [executionMode, selectedDevice, isCustomModel, selectedModel]);

  // RAF-batched patchLast: mutate ref immediately, schedule single flush per frame
  const patchLast = useCallback((fn: (turn: Turn) => Turn) => {
    const arr = turnsRef.current;
    const i = arr.length - 1;
    if (i >= 0 && arr[i].role === "assistant") {
      arr[i] = fn(arr[i]);
    } else {
      arr.push(fn({ role: "assistant", content: "", toolCalls: [] }));
    }
    if (!turnsDirtyRef.current) {
      turnsDirtyRef.current = true;
      rafIdRef.current = requestAnimationFrame(() => {
        turnsDirtyRef.current = false;
        setTurns([...turnsRef.current]);
      });
    }
  }, []);

  // Read one SSE response of a run, applying its events. Returns true once the run is done.
  const consumeRun = useCallback(async (res: Response, cursor: RunCursor): Promise<boolean> => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;

    const handleFrame = (frame: string) => {
      const lines = frame.split("\n");
      const idLine = lines.find((l) => l.startsWith("id: "));
      if (idLine) cursor.lastId = Number(idLine.slice(4)) || cursor.lastId;
      const line = lines.find((l) => l.startsWith("data: "));
      if (!line) return;
      let evt: {
        type: string;
        id?: string;
        tool_call_id?: string;
        text?: string;
        sources?: Source[];
        message?: string;
        name?: string;
        args?: Record<string, unknown>;
        task_id?: string;
        device_id?: string;
        device_name?: string;
        action?: string;
        status?: string;
        stream?: "stdout" | "stderr";
        result?: ToolCallItem["result"];
        call?: ToolCallItem;
        event?: TaskEvent;
      };
      try {
        evt = JSON.parse(line.slice(6));
      } catch {
        return;
      }

      if (evt.type === "conversation_id" && evt.id) {
        cursor.convId = evt.id;
        activeConversationIdRef.current = evt.id;
        setActiveConversationId(evt.id);
        window.history.replaceState(null, "", `/ask?id=${evt.id}`);
        try {
          localStorage.setItem("memento_last_ask_conv_id", evt.id);
        } catch {}
      } else if (evt.type === "sources") {
        patchLast((x) => ({ ...x, sources: evt.sources ?? [] }));
      } else if (evt.type === "tool_call") {
        patchLast((x) => {
          const calls = [...(x.toolCalls || [])];
          const callObj = evt.call || ({} as any);
          const callId = evt.id || evt.tool_call_id || callObj.id || `call_${Date.now()}`;
          if (!calls.some((c) => c.id === callId)) {
            calls.push({
              id: callId,
              name: evt.name || callObj.name || "",
              args: evt.args || callObj.args || {},
              device_name: evt.device_name || callObj.device_name,
            });
          }
          return { ...x, toolCalls: calls };
        });
      } else if (evt.type === "task_progress") {
        patchLast((x) => {
          const calls = [...(x.toolCalls || [])];
          let idx = -1;
          if (evt.task_id) {
            idx = calls.findIndex((c) => c.result?.task_id === evt.task_id);
          }
          if (idx === -1 && evt.tool_call_id) {
            idx = calls.findIndex((c) => c.id === evt.tool_call_id);
          }
          if (idx === -1 && evt.device_name) {
            idx = calls.findIndex(
              (c) =>
                (c.device_name === evt.device_name || (c.args as Record<string, any>)?.device_id === evt.device_id) &&
                (!c.result || !c.result.status || c.result.status === "queued" || c.result.status === "running")
            );
          }
          if (idx === -1) {
            idx = calls
              .map((c, i) =>
                c.name === "run_on_device" &&
                (!c.result || (c.result.status !== "succeeded" && c.result.status !== "failed" && c.result.status !== "timeout"))
                  ? i
                  : -1
              )
              .filter((i) => i >= 0)
              .pop() ?? -1;
          }
          if (idx >= 0) {
            calls[idx] = {
              ...calls[idx],
              device_name: evt.device_name || calls[idx].device_name,
              result: {
                ...(calls[idx].result || {}),
                task_id: evt.task_id,
                device_id: evt.device_id,
                device_name: evt.device_name || calls[idx].device_name,
                action: evt.action || (calls[idx].args?.action as string),
                status: evt.status,
              },
            };
          }
          return { ...x, toolCalls: calls };
        });
      } else if (evt.type === "task_chunk" || evt.type === "tool_stream") {
        patchLast((x) => {
          const calls = [...(x.toolCalls || [])];
          let idx = -1;
          if (evt.task_id) {
            idx = calls.findIndex((c) => c.result?.task_id === evt.task_id);
          }
          if (idx === -1 && evt.tool_call_id) {
            idx = calls.findIndex((c) => c.id === evt.tool_call_id);
          }
          if (idx === -1 && evt.device_name) {
            idx = calls.findIndex(
              (c) =>
                (c.device_name === evt.device_name || (c.args as Record<string, any>)?.device_id === evt.device_id) &&
                (!c.result || (c.result.status !== "succeeded" && c.result.status !== "failed" && c.result.status !== "timeout"))
            );
          }
          if (idx === -1) {
            idx = calls
              .map((c, i) =>
                c.name === "run_on_device" &&
                (!c.result || (c.result.status !== "succeeded" && c.result.status !== "failed" && c.result.status !== "timeout"))
                  ? i
                  : -1
              )
              .filter((i) => i >= 0)
              .pop() ?? -1;
          }
          if (idx >= 0) {
            const target = calls[idx];
            const prevRes = target.result || {};
            const chunkText = evt.text || "";
            if (evt.stream === "stderr") {
              calls[idx] = {
                ...target,
                result: {
                  ...prevRes,
                  task_id: evt.task_id || prevRes.task_id,
                  status: "running",
                  stderr: (prevRes.stderr || "") + chunkText,
                },
              };
            } else {
              calls[idx] = {
                ...target,
                result: {
                  ...prevRes,
                  task_id: evt.task_id || prevRes.task_id,
                  status: "running",
                  stdout: (prevRes.stdout || "") + chunkText,
                },
              };
            }
          }
          return { ...x, toolCalls: calls };
        });
      } else if (evt.type === "tool_result") {
        patchLast((x) => {
          const calls = [...(x.toolCalls || [])];
          let idx = -1;
          const resTaskId = evt.result?.task_id;
          if (resTaskId) {
            idx = calls.findIndex((c) => c.result?.task_id === resTaskId);
          }
          if (idx === -1 && evt.tool_call_id) {
            idx = calls.findIndex((c) => c.id === evt.tool_call_id);
          }
          const res = evt.result;
          if (idx === -1 && res?.device_name) {
            idx = calls.findIndex(
              (c) =>
                (c.device_name === res.device_name || (c.args as Record<string, any>)?.device_id === res.device_id) &&
                (!c.result || !c.result.status || c.result.status === "queued" || c.result.status === "running")
            );
          }
          if (idx === -1) {
            idx = calls
              .map((c, i) =>
                !c.result || (c.result.status !== "succeeded" && c.result.status !== "failed" && c.result.status !== "timeout")
                  ? i
                  : -1
              )
              .filter((i) => i >= 0)
              .pop() ?? -1;
          }
          if (idx !== undefined && idx >= 0) {
            // The final result carries the whole event log; keep the live one if it doesn't.
            const events = evt.result?.events ?? calls[idx].result?.events;
            calls[idx] = { ...calls[idx], result: evt.result && { ...evt.result, ...(events ? { events } : {}) } };
          } else if (calls.length > 0) {
            calls[calls.length - 1] = { ...calls[calls.length - 1], result: evt.result };
          }
          return { ...x, toolCalls: calls };
        });

        // 智能瘦身或新会话生成时，无缝同步最新的底层 session_id 并复位瘦身模式，使后续继续在同一会话内推进
        const newSid = (evt.result as any)?.session_id;
        if (newSid && typeof newSid === "string") {
          setSelectedSessionId(newSid);
          persistCurrentConfig({ session_id: newSid, compact_mode: false });
        }
        setCompactMode(false);
        persistCurrentConfig({ compact_mode: false });
      } else if (evt.type === "task_event" && evt.event) {
        const event = evt.event;
        patchLast((x) => {
          const calls = [...(x.toolCalls || [])];
          let idx = evt.task_id ? calls.findIndex((c) => c.result?.task_id === evt.task_id) : -1;
          if (idx === -1 && evt.tool_call_id) idx = calls.findIndex((c) => c.id === evt.tool_call_id);
          if (idx >= 0) {
            const prev = calls[idx].result || {};
            calls[idx] = {
              ...calls[idx],
              result: { ...prev, task_id: prev.task_id || evt.task_id, events: mergeTaskEvent(prev.events ?? [], event) },
            };
          }
          return { ...x, toolCalls: calls };
        });
      } else if (evt.type === "thinking" && evt.text) {
        patchLast((x) => ({ ...x, thinking: (x.thinking || "") + evt.text }));
      } else if (evt.type === "delta" && evt.text) {
        patchLast((x) => ({ ...x, content: x.content + evt.text }));
      } else if (evt.type === "done") {
        sawDone = true;
      } else if (evt.type === "error") {
        patchLast((x) => ({ ...x, content: evt.message || t.ask.error, error: true }));
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      frames.forEach(handleFrame);
    }
    if (buffer.trim()) handleFrame(buffer);
    return sawDone;
  }, [patchLast, persistCurrentConfig, t]);

  // Reattach to a run from the last event seen, until it ends.
  const followRun = useCallback(async (cursor: RunCursor, ctrl: AbortController) => {
    for (let attempt = 1; attempt <= 20 && !ctrl.signal.aborted; attempt++) {
      try {
        const res = await authFetch(
          `${getApiBase()}/api/ask/conversations/${cursor.convId}/stream?after=${cursor.lastId}`,
          { signal: ctrl.signal },
        );
        if (res.status === 404) {
          // Finished and no longer held by the server: the saved conversation has it all.
          const data = await api.getAskConversation(cursor.convId!);
          turnsRef.current = data.turns || [];
          return;
        }
        if (res.ok && res.body && (await consumeRun(res, cursor))) return;
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
      }
      await new Promise((r) => setTimeout(r, Math.min(2000 * attempt, 15000)));
    }
  }, [consumeRun]);

  const finishStream = useCallback((ctrl: AbortController) => {
    if (abortRef.current !== ctrl) return; // superseded by a newer stream
    if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    turnsDirtyRef.current = false;
    setTurns([...turnsRef.current]);
    streamingRef.current = false;
    setStreaming(false);
    setCompactMode(false);
    abortRef.current = null;
    loadConversations();
  }, [loadConversations]);

  // Show a run that is still going (opened from history, or after a reload).
  const attachRun = useCallback(async (convId: string, question: string, baseTurns: Turn[]) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let turnsToUse = [...baseTurns];
    const len = turnsToUse.length;
    const last = len > 0 ? turnsToUse[len - 1] : null;
    const secondLast = len > 1 ? turnsToUse[len - 2] : null;

    if (last?.role === "assistant" && secondLast?.role === "user" && secondLast.content === question) {
      // Already ends with user question and assistant placeholder, reset assistant content and toolCalls for clean replay
      turnsToUse = [...turnsToUse.slice(0, -1), { role: "assistant", content: "", toolCalls: [] }];
    } else if (last?.role === "user" && last.content === question) {
      // Ends with user question, append assistant placeholder
      turnsToUse.push({ role: "assistant", content: "", toolCalls: [] });
    } else {
      // Normal case: append both user and assistant
      turnsToUse.push(
        { role: "user", content: question },
        { role: "assistant", content: "", toolCalls: [] }
      );
    }

    turnsRef.current = turnsToUse;
    setTurns([...turnsToUse]);
    streamingRef.current = true;
    setStreaming(true);
    try {
      await followRun({ lastId: 0, convId }, ctrl);
    } finally {
      finishStream(ctrl);
    }
  }, [finishStream, followRun]);
  attachRunRef.current = attachRun;

  // The stop button: ends the run on the server, including its device tasks.
  // Closing or leaving the page only detaches; the run keeps going.
  const stopRun = useCallback(() => {
    const convId = activeConversationIdRef.current;
    abortRef.current?.abort();
    if (convId) {
      authFetch(`${getApiBase()}/api/ask/conversations/${convId}/cancel`, { method: "POST" }).catch(() => {});
    }
  }, []);

  const sendWithText = useCallback(async (
    textToSend: string,
    options?: { forceCompact?: boolean; overrideSessionId?: string; images?: string[] }
  ) => {
    const rawQuestion = textToSend.trim();
    const sendImages = options?.images || [];
    if ((!rawQuestion && sendImages.length === 0) || streamingRef.current) return;
    const question = rawQuestion || (sendImages.length > 0 ? (locale === "zh-CN" ? "请分析这张图片" : "Please analyze this image") : "");

    const effectiveSessionId = options?.overrideSessionId !== undefined ? options.overrideSessionId : selectedSessionId;
    const effectiveCompact = options?.forceCompact !== undefined ? options.forceCompact : compactMode;

    // Snapshot history BEFORE appending, preserving tool execution results for follow-up turns
    const history = turns
      .filter((x) => !x.error)
      .map((x) => ({
        role: x.role,
        content: x.content,
        images: x.images,
        tool_calls: x.toolCalls?.map((tc) => ({
          name: tc.name,
          args: tc.args,
          device_name: tc.device_name || tc.result?.device_name,
          status: tc.result?.status,
          exit_code: tc.result?.exit_code,
          stdout: tc.result?.stdout ? tc.result.stdout.slice(-2000) : undefined,
          stderr: tc.result?.stderr ? tc.result.stderr.slice(-2000) : undefined,
          error: tc.result?.error,
        })),
      }));

    setInput("");
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setIsConfigCollapsed(true);
    }
    const initialTurns: Turn[] = [
      ...turns.filter((x) => !x.error),
      { role: "user", content: question, images: sendImages.length > 0 ? sendImages : undefined },
      { role: "assistant", content: "", toolCalls: [] },
    ];
    turnsRef.current = initialTurns;
    setTurns(initialTurns);
    streamingRef.current = true;
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    // convId is set only once this send's run announces itself, so a send that
    // never reached the server reports an error instead of "reattaching".
    const cursor: RunCursor = { lastId: 0, convId: null };

    try {
      const res = await authFetch(`${getApiBase()}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          images: sendImages.length > 0 ? sendImages : undefined,
          // Lets the server attach a retried send to the run it already started.
          request_id: crypto.randomUUID(),
          conversation_id: activeConversationId || undefined,
          history,
          device_id: selectedDevice,
          cwd: cwd.trim() || undefined,
          agent_mode: selectedDevice !== "ask_only",
          execution_mode: executionMode,
          model: selectedModel || undefined,
          effort: selectedEffort || undefined,
          session_id: effectiveSessionId || undefined,
          compact_mode: effectiveCompact || undefined,
          project_id: selectedProjectId || undefined,
          worktree: worktreeMode && ["codex", "claude", "antigravity"].includes(executionMode) ? true : undefined,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        const busy = res.status === 409;
        patchLast((x) => ({ ...x, content: busy ? "这个对话还有任务在运行，请等它结束或先停止" : t.ask.error, error: true }));
        return;
      }

      const done = await consumeRun(res, cursor);
      // The run lives on the server: a dropped connection reattaches, never resends.
      if (!done && !ctrl.signal.aborted && cursor.convId) await followRun(cursor, ctrl);
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        if (cursor.convId && !ctrl.signal.aborted) {
          await followRun(cursor, ctrl);
        } else {
          patchLast((x) => ({ ...x, content: x.content || t.ask.error, error: true }));
        }
      }
    } finally {
      finishStream(ctrl);
    }
  }, [activeConversationId, compactMode, consumeRun, cwd, executionMode, finishStream, followRun, locale, patchLast, selectedDevice, selectedEffort, selectedModel, selectedProjectId, selectedSessionId, turns, t, worktreeMode]);

  const send = useCallback(() => {
    if (streaming || (!input.trim() && attachedImages.length === 0)) return;
    const textToSend = input.trim();
    const imgs = attachedImages.map((img) => img.dataUrl);
    setAttachedImages([]);
    setInput("");
    sendWithText(textToSend, { images: imgs });
  }, [streaming, input, attachedImages, sendWithText]);

  const handleSmartCompactAndRetry = useCallback(
    (targetSid?: string) => {
      const sidToUse = targetSid || selectedSessionId;
      if (sidToUse) {
        setSelectedSessionId(sidToUse);
      }
      setCompactMode(true);
      const lastUserTurn = [...turns].reverse().find((t) => t.role === "user" && t.content);
      if (lastUserTurn?.content) {
        sendWithText(lastUserTurn.content, { forceCompact: true, overrideSessionId: sidToUse });
      }
    },
    [selectedSessionId, turns, sendWithText]
  );

  useEffect(() => {
    if (qParam && !initialSentRef.current && !streaming) {
      initialSentRef.current = true;
      sendWithText(qParam);
    }
  }, [qParam, streaming, sendWithText]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const handleSelectProject = useCallback(
    async (projId: string, customProjects?: ProjectSummary[]) => {
      const isSameProj = projId === selectedProjectIdRef.current;
      setSelectedProjectId(projId);
      selectedProjectIdRef.current = projId;
      if (!isSameProj && !isRestoringRef.current) {
        setSelectedSessionId("");
      }
      if (!projId) {
        setSessions([]);
        if (!isRestoringRef.current) {
          persistCurrentConfig({ project_id: "", session_id: "" });
        }
        return;
      }
      const projs = customProjects || projectsRef.current;
      const proj = projs.find((p) => p.id === projId);
      let clean = "";
      if (proj?.source_path) {
        clean = proj.source_path.trim();
        const match = clean.match(/((?:[a-zA-Z]:[/\\]|\/)[a-zA-Z0-9_\.\-]+(?:[\/\\][a-zA-Z0-9_\.\-]+)*)/);
        if (match) {
          clean = match[1].replace(/[\/\\]+$/, "");
        } else {
          clean = clean.split(/[\r\n",]/)[0].trim().replace(/[\/\\]+$/, "");
        }
        setCwd(clean);
        setShowCwd(true);
      }
      if (!isRestoringRef.current && !isSameProj) {
        persistCurrentConfig({ project_id: projId, session_id: "", cwd: clean || undefined });
      }
      setLoadingSessions(true);
      try {
        const res = await api.getProjectConversations(projId, 0, 50, "desc", selectedDevice);
        setSessions(res.sessions || []);
        if (res.project?.source_path && !clean) {
          let cleanProj = res.project.source_path.trim();
          const match = cleanProj.match(/((?:[a-zA-Z]:[/\\]|\/)[a-zA-Z0-9_\.\-]+(?:[\/\\][a-zA-Z0-9_\.\-]+)*)/);
          if (match) {
            cleanProj = match[1].replace(/[\/\\]+$/, "");
          } else {
            cleanProj = cleanProj.split(/[\r\n",]/)[0].trim().replace(/[\/\\]+$/, "");
          }
          setCwd(cleanProj);
          setShowCwd(true);
        }
      } catch (e) {
        console.error("Failed to load project sessions:", e);
        setSessions([]);
      } finally {
        setLoadingSessions(false);
      }
    },
    [selectedDevice, persistCurrentConfig]
  );

  const loadProjectsForMode = useCallback(
    async (mode: ExecutionMode, targetDev?: string, preferredTitle?: string) => {
      const toolMap: Record<string, string> = {
        codex: "codex",
        claude: "claude_code",
        antigravity: "antigravity",
      };
      const toolId = toolMap[mode];
      if (!toolId) {
        if (!isRestoringRef.current) {
          setProjects([]);
          setSelectedProjectId("");
          selectedProjectIdRef.current = "";
          setSessions([]);
          setSelectedSessionId("");
        }
        return;
      }
      try {
        const devToUse = targetDev !== undefined ? targetDev : selectedDevice;
        const list = await api.listProjects(toolId, devToUse);
        const projList = list || [];
        setProjects(projList);

        if (projList.length > 0) {
          const pref = preferredTitle || (projectsRef.current.find((p) => p.id === selectedProjectIdRef.current)?.title);
          let targetProj = pref
            ? projList.find((p) => p.title?.toLowerCase() === pref.toLowerCase() || p.slug?.toLowerCase().endsWith(`/${pref.toLowerCase()}`))
            : undefined;
          if (!targetProj && !selectedProjectIdRef.current) {
            targetProj = projList[0];
          }
          if (targetProj && targetProj.id !== selectedProjectIdRef.current && !isRestoringRef.current) {
            handleSelectProject(targetProj.id, projList);
          }
        } else {
          if (!isRestoringRef.current) {
            setSelectedProjectId("");
            selectedProjectIdRef.current = "";
            setSessions([]);
            setSelectedSessionId("");
          }
        }
      } catch (e) {
        console.error("Failed to load projects:", e);
        if (!isRestoringRef.current) {
          setProjects([]);
          setSelectedProjectId("");
          selectedProjectIdRef.current = "";
          setSessions([]);
          setSelectedSessionId("");
        }
      }
    },
    [selectedDevice, handleSelectProject]
  );

  const handleDeviceChange = (newDev: string) => {
    setSelectedDevice(newDev);
    persistCurrentConfig({ device_id: newDev });
    const prevTitle = projectsRef.current.find((p) => p.id === selectedProjectIdRef.current)?.title;
    setSelectedProjectId("");
    selectedProjectIdRef.current = "";
    setSelectedSessionId("");
    setSessions([]);
    if (["codex", "claude", "antigravity"].includes(executionMode)) {
      loadProjectsForMode(executionMode, newDev, prevTitle);
    }
  };

  const handleSelectMode = (mode: ExecutionMode) => {
    setExecutionMode(mode);
    let dev = selectedDevice;
    if (mode !== "ai" && selectedDevice === "ask_only") {
      dev = "auto";
      setSelectedDevice("auto");
    }
    // Default to empty (follow client/CLI config), never force hardcoded model!
    setSelectedModel("");
    setIsCustomModel(false);
    persistCurrentConfig({ execution_mode: mode, model: "", project_id: "", session_id: "" });
    const prevTitle = projectsRef.current.find((p) => p.id === selectedProjectIdRef.current)?.title;
    setSelectedProjectId("");
    selectedProjectIdRef.current = "";
    setSelectedSessionId("");
    setSessions([]);
    loadProjectsForMode(mode, dev, prevTitle);
  };

  const handleSelectSession = useCallback(
    async (sid: string) => {
      setSelectedSessionId(sid);
      persistCurrentConfig({ session_id: sid });
      if (!sid) {
        startNewChat();
        return;
      }
      const targetSession = sessions.find(
        (s) => (s.session_id || s.conversation_id) === sid
      );
      if (!targetSession) return;

      // 默认保持原生接续（Raw Resume），绝不静默强制开启瘦身模式，仅在 UI 提供建议标记并由用户显式切换
      setCompactMode(false);

      let rawMsgs: Array<{
        role: string;
        content: string;
        images?: string[];
        thinking?: string;
        tool_name?: string;
        tool_input?: string;
        raw_type?: string;
      }> = (targetSession.messages || []) as any;

      if (targetSession.conversation_id) {
        try {
          const full = await api.getMessages(targetSession.conversation_id, 0, 100);
          if (full?.messages && full.messages.length > 0) {
            rawMsgs = full.messages.map((m: any) => ({
              role: m.role || "user",
              content: m.content || "",
              images: m.images || undefined,
              thinking: m.thinking || undefined,
              tool_name: m.tool_name || undefined,
              tool_input: m.tool_input || undefined,
              raw_type: m.raw_type || undefined,
            }));
          }
        } catch (err) {
          console.warn("Failed to load full conversation messages:", err);
        }
      }

      // Helper to parse legacy [Tool: <name>]\n<input> blocks embedded in text
      const parseLegacyToolContent = (text: string) => {
        const toolIdx = text.indexOf("[Tool:");
        if (toolIdx === -1) return null;
        const preText = text.slice(0, toolIdx).trim();
        const toolPart = text.slice(toolIdx);
        const match = toolPart.match(/^\[Tool:\s*([^\]]+)\]\s*([\s\S]*)$/);
        if (!match) return null;
        const name = match[1].trim();
        const inputStr = match[2].trim();
        let command = inputStr;
        try {
          const parsed = JSON.parse(inputStr);
          if (typeof parsed === "object" && parsed !== null) {
            if (parsed.command) command = parsed.command;
          }
        } catch {}
        return { preText, name, command };
      };

      const loadedTurns: Turn[] = [];

      for (const m of rawMsgs) {
        let role = m.role || "user";
        let content = m.content || "";
        const rawType = m.raw_type || "";

        // Detect legacy [Result] on user role -> treat as tool output
        if (role === "user" && content.startsWith("[Result]")) {
          role = "tool";
          content = content.replace(/^\[Result\]\s*/, "");
        }

        // Detect legacy [Tool: ...] on assistant role
        const legacyCall = role === "assistant" ? parseLegacyToolContent(content) : null;
        if (legacyCall) {
          content = legacyCall.preText;
          role = content ? "assistant" : "tool";
        }

        if (role === "user") {
          // Skip any residual tool/meta noise from appearing as user messages
          if (
            content.startsWith("[Tool:") ||
            content.startsWith("[Result]") ||
            content.startsWith('{"tool_use_id"')
          ) {
            continue;
          }
          loadedTurns.push({
            role: "user",
            content: content,
            images: m.images || undefined,
          });
        } else if (role === "assistant") {
          const toolCalls: ToolCallItem[] = [];
          if (legacyCall) {
            toolCalls.push({
              name: legacyCall.name,
              args: { command: legacyCall.command },
            });
          } else if (m.tool_name) {
            toolCalls.push({
              name: m.tool_name,
              args: m.tool_input ? { command: m.tool_input } : {},
            });
          }
          loadedTurns.push({
            role: "assistant",
            content: content,
            thinking: m.thinking || undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          });
        } else if (role === "tool") {
          // Attach tool call or output to the last assistant turn
          let lastTurn = loadedTurns[loadedTurns.length - 1];
          if (!lastTurn || lastTurn.role !== "assistant") {
            lastTurn = {
              role: "assistant",
              content: "",
              toolCalls: [],
            };
            loadedTurns.push(lastTurn);
          }
          if (!lastTurn.toolCalls) {
            lastTurn.toolCalls = [];
          }

          if (legacyCall) {
            lastTurn.toolCalls.push({
              name: legacyCall.name,
              args: { command: legacyCall.command },
            });
          } else if (rawType === "tool_call" || m.tool_name) {
            lastTurn.toolCalls.push({
              name: m.tool_name || "tool",
              args: m.tool_input ? { command: m.tool_input } : {},
            });
          } else {
            // Tool output: attach stdout to the most recent tool call if available
            if (lastTurn.toolCalls.length > 0) {
              const lastCall = lastTurn.toolCalls[lastTurn.toolCalls.length - 1];
              lastCall.result = {
                stdout: content,
                status: "succeeded",
                exit_code: 0,
              };
            } else {
              lastTurn.toolCalls.push({
                name: "tool",
                args: {},
                result: {
                  stdout: content,
                  status: "succeeded",
                  exit_code: 0,
                },
              });
            }
          }
        }
      }

      abortRef.current?.abort();
      streamingRef.current = false;
      // 优先从已有的 AskConversations 中寻找关联该底层 session 的真正 Ask 会话，避免将 Document ID 误作为 AskConversation ID
      let matchedAskConv = conversations.find(
        (c) => c.config?.session_id === sid || c.id === sid
      );
      if (matchedAskConv) {
        activeConversationIdRef.current = matchedAskConv.id;
        setActiveConversationId(matchedAskConv.id);
        window.history.replaceState(null, "", `/ask?id=${matchedAskConv.id}`);
        try {
          localStorage.setItem("memento_last_ask_conv_id", matchedAskConv.id);
        } catch {}
      } else {
        try {
          const ensured = await api.ensureConversationBySession({
            session_id: sid,
            project_id: selectedProjectIdRef.current || selectedProjectId || undefined,
            execution_mode: executionMode,
            device_id: selectedDevice,
            cwd: cwd.trim() || undefined,
          });
          if (ensured && ensured.id) {
            activeConversationIdRef.current = ensured.id;
            setActiveConversationId(ensured.id);
            window.history.replaceState(null, "", `/ask?id=${ensured.id}`);
            try {
              localStorage.setItem("memento_last_ask_conv_id", ensured.id);
            } catch {}
            if (ensured.turns && ensured.turns.length > 0) {
              setTurns(ensured.turns);
              return;
            }
          }
        } catch (e) {
          console.warn("Failed to ensure conversation by session:", e);
        }
      }
      setTurns(loadedTurns);
    },
    [conversations, cwd, executionMode, selectedDevice, selectedProjectId, sessions, startNewChat]
  );

  // Sync projects on initial load if starting in agent mode (ONLY when no conversation is active/restoring)
  useEffect(() => {
    if (!activeConversationId && !isRestoringRef.current && ["codex", "claude", "antigravity"].includes(executionMode)) {
      if (projects.length === 0) {
        loadProjectsForMode(executionMode);
      }
    }
  }, [executionMode, activeConversationId, projects.length, loadProjectsForMode]);

  const currentDev = devices.find((d) => d.device_id === selectedDevice);
  const isCurrentDevOnline = currentDev
    ? (currentDev.online ?? (currentDev.last_heartbeat ? (Date.now() - new Date(currentDev.last_heartbeat).getTime()) < 180_000 : false))
    : true;
  let placeholderText = t.ask.placeholderAgent;
  if (executionMode === "claude") {
    placeholderText = t.ask.placeholderClaude || (isZh ? "向 Claude Code 派发编码任务..." : "Dispatch coding task to Claude Code...");
  } else if (executionMode === "codex") {
    placeholderText = t.ask.placeholderCodex || (isZh ? "向 OpenAI Codex 派发任务..." : "Dispatch task to OpenAI Codex...");
  } else if (executionMode === "antigravity") {
    placeholderText = t.ask.placeholderAntigravity || (isZh ? "向 Google Antigravity 派发任务..." : "Dispatch task to Google Antigravity...");
  } else if (executionMode === "shell") {
    placeholderText = t.ask.placeholderShell || (isZh ? "在目标电脑上直接执行 Shell 命令..." : "Execute Shell command on target device...");
  } else if (selectedDevice === "ask_only") {
    placeholderText = t.ask.placeholderAskOnly;
  } else if (currentDev) {
    placeholderText = isZh ? `在 ${currentDev.name} 上执行任务或提问，例如：「检查 git 状态」...` : `Run task or question on ${currentDev.name}...`;
  }

  const activeConversation = conversations.find((c) => c.id === activeConversationId);

  return (
    <div className="w-full flex h-[calc(100dvh-4.5rem)] sm:h-[calc(100vh-5.5rem)] rounded-xl sm:rounded-2xl border-0 sm:border border-[var(--aurora-border-strong)] bg-[var(--aurora-surface-solid)]/40 backdrop-blur-2xl overflow-hidden shadow-2xl relative select-none">
      {/* 主对话区与输入控制台 */}
      <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden relative bg-transparent">
        {/* 对话区顶部 Bar */}
        <header className="px-3 sm:px-4 py-2 sm:py-2.5 border-b border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)]/70 backdrop-blur-md flex items-center justify-between gap-2 sm:gap-3 shrink-0">
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0 flex-1">
            <Btn
              variant="glass"
              size="sm"
              icon="clock"
              onClick={() => setHistoryOpen(true)}
              title={isZh ? "查看历史对话" : "View history"}
              className="shrink-0"
            >
              <span className="hidden sm:inline">{t.ask.historyTitle}</span>
              {conversations.length > 0 && (
                <span
                  style={{
                    fontSize: 11,
                    padding: "1px 6px",
                    borderRadius: 999,
                    background: "var(--aurora-chip)",
                    color: "var(--aurora-fg3)",
                    marginLeft: 4,
                  }}
                >
                  {conversations.length}
                </span>
              )}
            </Btn>
            <div className="min-w-0 flex-1">
              <h1 className="text-xs sm:text-sm font-semibold text-[var(--aurora-fg1)] truncate max-w-[120px] sm:max-w-xs md:max-w-sm">
                {activeConversation?.title || t.ask.title}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {/* 媒体视窗快捷开关 (若对话中有视频或照片，高亮并提示) */}
            {inspector && inspector.mediaList.length > 0 && (
              <Btn
                variant={inspector.isOpen ? "primary" : "glass"}
                size="sm"
                icon="sidebar"
                onClick={inspector.toggleInspector}
                title={inspector.isOpen ? (isZh ? "折叠媒体独立视窗" : "Collapse media inspector") : (isZh ? "展开媒体独立视窗" : "Open media inspector")}
                className="shrink-0"
              >
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="hidden sm:inline">媒体视窗</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-black/20 font-mono font-bold">
                    {inspector.mediaList.length}
                  </span>
                </span>
              </Btn>
            )}
            {/* AI 订阅与额度监控入口 */}
            <Btn
              variant="glass"
              size="sm"
              icon="activity"
              onClick={() => setQuotaOpen(true)}
              title={isZh ? "查看各个 AI 订阅工具额度 (Antigravity/Claude/Codex)" : "View AI Subscriptions & Quotas"}
              className="shrink-0"
            >
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                <span className="hidden sm:inline">AI 额度</span>
                {quotasData?.tools?.antigravity?.remaining_percent != null && (
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 700,
                      padding: "1px 5px",
                      borderRadius: 999,
                      background: "rgba(56, 189, 248, 0.15)",
                      color: "#38BDF8",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {quotasData.tools.antigravity.remaining_percent}%
                  </span>
                )}
              </span>
            </Btn>
            <Btn
              variant="glass"
              size="sm"
              icon="plus"
              onClick={startNewChat}
              className="shrink-0"
            >
              <span className="hidden sm:inline">{t.ask.newChat}</span>
            </Btn>
            {turns.length > 0 && (
              <Btn
                variant="ghost"
                size="sm"
                onClick={() => {
                  abortRef.current?.abort();
                  setTurns([]);
                }}
                className="shrink-0"
              >
                {t.ask.clear}
              </Btn>
            )}
          </div>
        </header>

        {/* 中栏消息滚动列表 */}
        <div
          ref={chatScrollRef}
          onScroll={(e) => {
            if (askCache) {
              askCache.scrollTop = e.currentTarget.scrollTop;
            }
          }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          className="flex-1 overflow-y-auto px-4 md:px-8 py-6 scroll-smooth"
        >
          <div className="w-full max-w-3xl mx-auto space-y-4">

      {turns.length === 0 && (
        <Glass padding="clamp(16px, 4vw, 32px)" radius={20} style={{ textAlign: "center", marginBottom: 20, maxWidth: "100%", minWidth: 0 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 48,
              height: 48,
              borderRadius: 14,
              background: "rgba(56, 189, 248, 0.12)",
              color: "var(--aurora-accent)",
              marginBottom: 12,
            }}
          >
            <Icon name="terminal" size={26} />
          </div>
          <h3 style={{ fontSize: 16, fontWeight: 600, color: "var(--aurora-fg1)", margin: "0 0 6px" }}>
            {t.ask.title}
          </h3>
          <p style={{ color: "var(--aurora-fg3)", fontSize: 13.5, margin: "0 0 18px" }}>
            {t.ask.empty}
          </p>

          {/* Quick command pills */}
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            {[
              { label: t.ask.sugGitStatus, icon: "code" as const },
              { label: t.ask.sugPorts, icon: "activity" as const },
              { label: t.ask.sugDevices, icon: "devices" as const },
              { label: t.ask.sugRecentSummary, icon: "sparkles" as const },
            ].map((s, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => {
                  sendWithText(s.label);
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 14px",
                  borderRadius: 9999,
                  background: "var(--aurora-chip)",
                  border: "1px solid var(--aurora-border)",
                  color: "var(--aurora-fg2)",
                  fontSize: 12.5,
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--aurora-accent)";
                  e.currentTarget.style.color = "var(--aurora-fg1)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--aurora-border)";
                  e.currentTarget.style.color = "var(--aurora-fg2)";
                }}
              >
                <Icon name={s.icon} size={13} style={{ color: "var(--aurora-accent)" }} />
                <span>{s.label}</span>
              </button>
            ))}
          </div>
        </Glass>
      )}

      {/* Conversation turns list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: "100%", minWidth: 0 }}>
        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <UserBubble key={i} content={turn.content} images={turn.images} />
          ) : (
            <AssistantBubble
              key={i}
              turn={turn}
              isLast={i === turns.length - 1}
              streaming={streaming}
              onSourcesClick={(sources) => {
                setSelectedSources(sources);
                setSourcesOpen(true);
                setHistoryOpen(false);
              }}
              onSmartCompactAndRetry={handleSmartCompactAndRetry}
              t={t}
            />
          )
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  </div>

  {/* 中栏底部交互控制台 (作为 flex footer，全面屏安全区适配) */}
  <footer
    className="shrink-0 px-3 pt-2.5 lg:p-4 border-t border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)]/90 backdrop-blur-xl"
    style={{
      paddingBottom: "max(0.75rem, env(safe-area-inset-bottom, 0.75rem))",
    }}
  >
    <div className="max-w-3xl mx-auto w-full min-w-0" style={{ boxSizing: "border-box" }}>
      <div
        style={{
          background: "var(--aurora-surface-solid)",
          border: "1px solid var(--aurora-border-strong)",
          borderRadius: 18,
          padding: "10px 14px",
          boxShadow: "var(--aurora-card-shadow), 0 16px 40px -8px rgba(0,0,0,0.14)",
          backdropFilter: "blur(20px)",
          maxWidth: "100%",
          width: "100%",
          minWidth: 0,
          boxSizing: "border-box",
        }}
      >
            {isConfigCollapsed ? (
              /* Collapsed Summary Pill Bar */
              <div
                onClick={toggleConfigCollapsed}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 8,
                  padding: "5px 10px",
                  background: "var(--aurora-chip)",
                  border: "1px solid var(--aurora-border)",
                  borderRadius: 12,
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                  userSelect: "none",
                  minWidth: 0,
                  maxWidth: "100%",
                  boxSizing: "border-box",
                }}
                title={isZh ? "点击展开完整配置面板" : "Click to expand configuration panel"}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    overflowX: "auto",
                    scrollbarWidth: "none",
                    minWidth: 0,
                    flex: 1,
                    maxWidth: "calc(100% - 75px)",
                  }}
                >
                  {/* Current Mode Badge */}
                  {(() => {
                    const currentMode = [
                      { id: "ai" as const, label: t.ask.modeAi || "AI 编排", icon: "brain" as const, color: "var(--aurora-accent)" },
                      { id: "claude" as const, label: t.ask.modeClaude || "Claude Code", brandId: "claude_code" as const, color: "#D97757" },
                      { id: "codex" as const, label: t.ask.modeCodex || "Codex", brandId: "codex" as const, color: "#10A37F" },
                      { id: "antigravity" as const, label: t.ask.modeAntigravity || "Antigravity", brandId: "antigravity" as const, color: "#3186FF" },
                      { id: "shell" as const, label: t.ask.modeShell || "Shell 终端", icon: "terminal" as const, color: "#38BDF8" },
                    ].find((m) => m.id === executionMode) || { id: "ai" as const, label: "AI 编排", icon: "brain" as const, color: "var(--aurora-accent)" };

                    const modeQuota = getModeQuotaSummary(executionMode);

                    return (
                      <span
                        onClick={() => {
                          if (["antigravity", "claude", "codex"].includes(executionMode)) {
                            setQuotaOpen(true);
                          }
                        }}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          padding: "2px 8px",
                          borderRadius: 8,
                          background: "var(--aurora-accent-soft)",
                          border: `1px solid ${currentMode.color}`,
                          color: currentMode.color,
                          fontSize: 11.5,
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                          flexShrink: 0,
                          cursor: ["antigravity", "claude", "codex"].includes(executionMode) ? "pointer" : "default",
                        }}
                        title={["antigravity", "claude", "codex"].includes(executionMode) ? "点击查看 AI 订阅与额度详情" : undefined}
                      >
                        {currentMode.brandId ? (
                          <BrandMark id={currentMode.brandId} size={13} colored />
                        ) : (
                          <Icon name={currentMode.icon || "sparkles"} size={12} style={{ color: currentMode.color }} />
                        )}
                        <span>{currentMode.label}</span>
                        {modeQuota && (
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              padding: "0 4px",
                              borderRadius: 4,
                              background: "rgba(0, 0, 0, 0.2)",
                              color: modeQuota.percent != null && modeQuota.percent < 30 ? "#F59E0B" : "inherit",
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {modeQuota.label}
                          </span>
                        )}
                      </span>
                    );
                  })()}

                  {/* Target Device Badge */}
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 8px",
                      borderRadius: 8,
                      background: !isCurrentDevOnline && selectedDevice !== "auto" && selectedDevice !== "ask_only" ? "rgba(239, 68, 68, 0.12)" : "var(--aurora-surface-solid)",
                      border: !isCurrentDevOnline && selectedDevice !== "auto" && selectedDevice !== "ask_only" ? "1px solid rgba(239, 68, 68, 0.4)" : "1px solid var(--aurora-border)",
                      color: !isCurrentDevOnline && selectedDevice !== "auto" && selectedDevice !== "ask_only" ? "#ef4444" : "var(--aurora-fg2)",
                      fontSize: 11.5,
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    <Icon name="devices" size={12} style={{ color: !isCurrentDevOnline && selectedDevice !== "auto" && selectedDevice !== "ask_only" ? "#ef4444" : "var(--aurora-accent)" }} />
                    <span>
                      {selectedDevice === "auto"
                        ? t.ask.autoDispatch
                        : selectedDevice === "ask_only"
                        ? t.ask.askOnly
                        : `${isCurrentDevOnline ? "🟢" : "🔴"} ${currentDev?.name || (selectedDevice.length > 8 ? selectedDevice.slice(0, 8) : selectedDevice)} (${isCurrentDevOnline ? (isZh ? "在线" : "Online") : (isZh ? "离线" : "Offline")})`}
                    </span>
                  </span>

                  {/* Associated Project Badge */}
                  {selectedProjectId && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "2px 8px",
                        borderRadius: 8,
                        background: "var(--aurora-surface-solid)",
                        border: "1px solid var(--aurora-border)",
                        color: "var(--aurora-fg2)",
                        fontSize: 11.5,
                        fontWeight: 500,
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      <Icon name="code" size={12} style={{ color: "var(--aurora-fg3)" }} />
                      <span>{projects.find((p) => p.id === selectedProjectId)?.title || selectedProjectId}</span>
                    </span>
                  )}

                  {/* CWD snippet if no project but cwd is set */}
                  {!selectedProjectId && cwd && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "2px 8px",
                        borderRadius: 8,
                        background: "var(--aurora-surface-solid)",
                        border: "1px solid var(--aurora-border)",
                        color: "var(--aurora-fg3)",
                        fontSize: 11,
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                        maxWidth: 160,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={cwd}
                    >
                      <Icon name="folder" size={11} style={{ color: "var(--aurora-accent)" }} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{cwd}</span>
                    </span>
                  )}

                  {/* Selected Model Badge */}
                  {selectedModel && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "2px 8px",
                        borderRadius: 8,
                        background: "var(--aurora-surface-solid)",
                        border: "1px solid var(--aurora-border)",
                        color: "var(--aurora-fg3)",
                        fontSize: 11,
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      <Icon name="sparkles" size={11} style={{ color: "var(--aurora-accent)" }} />
                      <span>{selectedModel}</span>
                    </span>
                  )}

                  {/* Reasoning Effort Badge */}
                  {selectedEffort && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                        padding: "2px 6px",
                        borderRadius: 8,
                        background: "var(--aurora-surface-solid)",
                        border: "1px solid var(--aurora-border)",
                        color: "var(--aurora-fg3)",
                        fontSize: 11,
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      <Icon name="brain" size={11} style={{ color: "var(--aurora-accent)" }} />
                      <span>{selectedEffort}</span>
                    </span>
                  )}

                  {/* Resumed Session Badge */}
                  {selectedSessionId && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "2px 8px",
                        borderRadius: 8,
                        background: "var(--aurora-accent-soft)",
                        border: "1px solid var(--aurora-accent)",
                        color: "var(--aurora-accent)",
                        fontSize: 11,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      <Icon name="clock" size={11} />
                      <span>
                        {isZh ? "续接: " : "Resuming: "}
                        {(() => {
                          const s = sessions.find((x) => (x.session_id || x.conversation_id) === selectedSessionId);
                          const t = s?.title || selectedSessionId;
                          return t.length > 18 ? t.slice(0, 18) + "..." : t;
                        })()}
                      </span>
                    </span>
                  )}
                </div>

                {/* Expand button */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleConfigCollapsed();
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    background: "var(--aurora-accent-soft)",
                    border: "1px solid var(--aurora-accent)",
                    borderRadius: 8,
                    padding: "3px 8px",
                    color: "var(--aurora-accent)",
                    fontSize: 11.5,
                    fontWeight: 600,
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                  title={isZh ? "展开完整配置面板" : "Expand configuration panel"}
                >
                  <Icon name="chevron_down" size={12} />
                  <span>{isZh ? "展开配置" : "Expand"}</span>
                </button>
              </div>
            ) : (
              <div>
                {/* Agent Mode Selector Toolbelt with Collapse button */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    marginBottom: 8,
                    minWidth: 0,
                    maxWidth: "100%",
                    boxSizing: "border-box",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      overflowX: "auto",
                      maxWidth: "calc(100% - 75px)",
                      flex: 1,
                      paddingBottom: 2,
                      scrollbarWidth: "none",
                      WebkitOverflowScrolling: "touch",
                      minWidth: 0,
                    }}
                  >
                    {[
                      { id: "ai" as const, label: t.ask.modeAi || "AI 编排", icon: "brain" as const, color: "var(--aurora-accent)" },
                      { id: "claude" as const, label: t.ask.modeClaude || "Claude Code", brandId: "claude_code", color: "#D97757" },
                      { id: "codex" as const, label: t.ask.modeCodex || "Codex", brandId: "codex", color: "#10A37F" },
                      { id: "antigravity" as const, label: t.ask.modeAntigravity || "Antigravity", brandId: "antigravity", color: "#3186FF" },
                      { id: "shell" as const, label: t.ask.modeShell || "Shell 终端", icon: "terminal" as const, color: "#38BDF8" },
                    ].map((m) => {
                      const isSelected = executionMode === m.id;
                      const qSummary = getModeQuotaSummary(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => handleSelectMode(m.id)}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            background: isSelected ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                            border: "1px solid",
                            borderColor: isSelected ? m.color : "var(--aurora-border)",
                            borderRadius: 12,
                            padding: "4px 10px",
                            fontSize: 12,
                            fontWeight: isSelected ? 600 : 500,
                            color: isSelected ? m.color : "var(--aurora-fg2)",
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                            whiteSpace: "nowrap",
                            flexShrink: 0,
                          }}
                        >
                          {m.brandId ? (
                            <BrandMark id={m.brandId} size={14} colored={isSelected} tint={isSelected ? undefined : "var(--aurora-fg3)"} />
                          ) : (
                            <Icon name={m.icon || "sparkles"} size={13} style={{ color: isSelected ? m.color : "var(--aurora-fg3)" }} />
                          )}
                          <span>{m.label}</span>
                          {qSummary && (
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 600,
                                padding: "1px 5px",
                                borderRadius: 6,
                                background: isSelected ? "rgba(0, 0, 0, 0.25)" : "var(--aurora-surface)",
                                color: isSelected ? m.color : "var(--aurora-fg3)",
                              }}
                            >
                              {qSummary.label}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Collapse button */}
                  <button
                    type="button"
                    onClick={toggleConfigCollapsed}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                      background: "var(--aurora-chip)",
                      border: "1px solid var(--aurora-border)",
                      borderRadius: 8,
                      padding: "3px 8px",
                      color: "var(--aurora-fg3)",
                      fontSize: 11.5,
                      fontWeight: 500,
                      cursor: "pointer",
                      flexShrink: 0,
                      transition: "all 0.15s ease",
                    }}
                    title={isZh ? "收起配置面板，释放聊天区域" : "Collapse configuration panel"}
                  >
                    <Icon name="chevron_up" size={12} />
                    <span>{isZh ? "收起" : "Collapse"}</span>
                  </button>
                </div>

            {/* Device & environment toolbelt */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap", maxWidth: "100%", minWidth: 0 }}>
              {/* Target device selector */}
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: !isCurrentDevOnline && selectedDevice !== "auto" && selectedDevice !== "ask_only" ? "rgba(239, 68, 68, 0.08)" : "var(--aurora-chip)",
                  border: !isCurrentDevOnline && selectedDevice !== "auto" && selectedDevice !== "ask_only" ? "1px solid rgba(239, 68, 68, 0.5)" : "1px solid var(--aurora-border)",
                  borderRadius: 10,
                  padding: "4px 10px",
                  fontSize: 12,
                  maxWidth: "100%",
                  minWidth: 0,
                }}
              >
                <Icon name="devices" size={13} style={{ color: !isCurrentDevOnline && selectedDevice !== "auto" && selectedDevice !== "ask_only" ? "#ef4444" : "var(--aurora-accent)", flexShrink: 0 }} />
                <select
                  value={selectedDevice}
                  onChange={(e) => handleDeviceChange(e.target.value)}
                  style={{
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    color: "var(--aurora-fg1)",
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: "pointer",
                    maxWidth: "min(220px, 60vw)",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}
                >
                  <option value="auto" style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                    {t.ask.autoDispatch}
                  </option>
                  {selectedDevice && !["auto", "ask_only", "all"].includes(selectedDevice) && !devices.some((d) => d.device_id === selectedDevice) && (
                    <option value={selectedDevice} style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                      💻 {selectedDevice}
                    </option>
                  )}
                  {devices.map((d) => {
                    const isOnline = d.online ?? (d.last_heartbeat ? (Date.now() - new Date(d.last_heartbeat).getTime()) < 180_000 : false);
                    return (
                      <option key={d.device_id} value={d.device_id} style={{ background: "var(--aurora-surface-solid)", color: isOnline ? "var(--aurora-fg1)" : "var(--aurora-fg3)" }}>
                        {isOnline ? "🟢" : "🔴"} {d.name} ({isOnline ? (isZh ? "在线" : "Online") : (isZh ? "离线" : "Offline")})
                      </option>
                    );
                  })}
                  <option value="ask_only" style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                    {t.ask.askOnly}
                  </option>
                </select>
                {!isCurrentDevOnline && selectedDevice !== "auto" && selectedDevice !== "ask_only" && (
                  <span
                    title={isZh ? "目标设备当前离线，请在目标机器上启动 Memento 客户端" : "Target device is offline, please start Memento on target device"}
                    style={{
                      fontSize: 11,
                      color: "#ef4444",
                      fontWeight: 600,
                      display: "inline-flex",
                      alignItems: "center",
                      whiteSpace: "nowrap",
                    }}
                  >
                    ⚠️ {isZh ? "离线" : "Offline"}
                  </span>
                )}
              </div>

              {/* Optional working directory selector */}
              {selectedDevice !== "ask_only" && (
                showCwd ? (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      background: "var(--aurora-chip)",
                      border: "1px solid var(--aurora-accent)",
                      borderRadius: 10,
                      padding: "4px 10px",
                      flex: 1,
                      minWidth: "min(140px, 100%)",
                      maxWidth: "100%",
                    }}
                  >
                    <Icon name="folder" size={13} style={{ color: "var(--aurora-accent)", flexShrink: 0 }} />
                    <input
                      type="text"
                      value={cwd}
                      onChange={(e) => {
                        setCwd(e.target.value);
                        persistCurrentConfig({ cwd: e.target.value });
                      }}
                      placeholder={t.ask.cwdPlaceholder}
                      style={{
                        background: "transparent",
                        border: "none",
                        outline: "none",
                        color: "var(--aurora-fg1)",
                        fontSize: 12,
                        fontFamily: "monospace",
                        width: "100%",
                        minWidth: 0,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowCwd(false)}
                      style={{ background: "none", border: "none", color: "var(--aurora-fg4)", cursor: "pointer", padding: 0, flexShrink: 0 }}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowCwd(true)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      background: cwd ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                      border: "1px solid",
                      borderColor: cwd ? "var(--aurora-accent)" : "var(--aurora-border)",
                      borderRadius: 10,
                      padding: "4px 10px",
                      fontSize: 12,
                      fontWeight: 500,
                      color: cwd ? "var(--aurora-accent)" : "var(--aurora-fg2)",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                      maxWidth: "min(200px, 45vw)",
                      minWidth: 0,
                    }}
                  >
                    <Icon name="folder" size={12} style={{ flexShrink: 0 }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {cwd ? cwd : t.ask.cwdLabel}
                    </span>
                  </button>
                )
              )}

              {/* Agent Model selector */}
              {["codex", "claude", "antigravity"].includes(executionMode) && (
                isCustomModel ? (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      background: "var(--aurora-chip)",
                      border: "1px solid var(--aurora-accent)",
                      borderRadius: 10,
                      padding: "4px 10px",
                      fontSize: 12,
                      maxWidth: "100%",
                      minWidth: 0,
                    }}
                    title={isZh ? "输入任意模型名称或标识符" : "Input custom model identifier"}
                  >
                    <Icon name="sparkles" size={13} style={{ color: "var(--aurora-accent)", flexShrink: 0 }} />
                    <input
                      type="text"
                      value={selectedModel}
                      onChange={(e) => {
                        setSelectedModel(e.target.value);
                        persistCurrentConfig({ model: e.target.value });
                      }}
                      placeholder={isZh ? "输入模型名称, 如 gpt-6-astra..." : "Model name, e.g. gpt-6-astra..."}
                      autoFocus
                      style={{
                        background: "transparent",
                        border: "none",
                        outline: "none",
                        color: "var(--aurora-fg1)",
                        fontSize: 12,
                        fontFamily: "monospace",
                        width: "min(160px, 35vw)",
                        minWidth: 0,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setIsCustomModel(false);
                        setSelectedModel("");
                        persistCurrentConfig({ model: "" });
                      }}
                      style={{ background: "none", border: "none", color: "var(--aurora-fg4)", cursor: "pointer", padding: 0, flexShrink: 0 }}
                      title={isZh ? "返回快捷预设列表" : "Return to preset list"}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                ) : (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      background: selectedModel ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                      border: "1px solid",
                      borderColor: selectedModel ? "var(--aurora-accent)" : "var(--aurora-border)",
                      borderRadius: 10,
                      padding: "4px 10px",
                      fontSize: 12,
                      maxWidth: "100%",
                      minWidth: 0,
                    }}
                    title={isZh ? "选择调用的模型" : "Select model"}
                  >
                    <Icon name="sparkles" size={13} style={{ color: selectedModel ? "var(--aurora-accent)" : "var(--aurora-fg3)", flexShrink: 0 }} />
                    <select
                      value={selectedModel}
                      onChange={(e) => {
                        if (e.target.value === "__custom__") {
                          setIsCustomModel(true);
                          setSelectedModel("");
                          persistCurrentConfig({ model: "" });
                        } else {
                          setSelectedModel(e.target.value);
                          persistCurrentConfig({ model: e.target.value });
                        }
                      }}
                      style={{
                        background: "transparent",
                        border: "none",
                        outline: "none",
                        color: selectedModel ? "var(--aurora-accent)" : "var(--aurora-fg1)",
                        fontSize: 12,
                        fontWeight: selectedModel ? 600 : 500,
                        cursor: "pointer",
                        maxWidth: "min(200px, 50vw)",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        minWidth: 0,
                      }}
                    >
                      {((capabilities?.models && capabilities.models.length > 0)
                        ? capabilities.models
                        : (FALLBACK_AGENT_MODELS[executionMode] || [])
                      ).map((m) => (
                        <option key={m.id} value={m.id} title={m.desc} style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                          {m.name}
                        </option>
                      ))}
                      <option value="__custom__" style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-accent)" }}>
                        {isZh ? "✏️ 自定义输入任意模型..." : "✏️ Custom model..."}
                      </option>
                    </select>
                  </div>
                )
              )}

              {/* Agent Reasoning Effort selector (Low / Medium / High) */}
              {["codex", "claude", "antigravity"].includes(executionMode) && (capabilities?.supports_effort || executionMode === "codex") && (
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    background: selectedEffort ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                    border: "1px solid",
                    borderColor: selectedEffort ? "var(--aurora-accent)" : "var(--aurora-border)",
                    borderRadius: 10,
                    padding: "4px 10px",
                    fontSize: 12,
                    maxWidth: "100%",
                    minWidth: 0,
                  }}
                  title={isZh ? "调节推理思考深度 (Reasoning Effort)" : "Adjust reasoning effort"}
                >
                  <Icon name="brain" size={13} style={{ color: selectedEffort ? "var(--aurora-accent)" : "var(--aurora-fg3)", flexShrink: 0 }} />
                  <select
                    value={selectedEffort}
                    onChange={(e) => {
                      setSelectedEffort(e.target.value);
                      persistCurrentConfig({ effort: e.target.value });
                    }}
                    style={{
                      background: "transparent",
                      border: "none",
                      outline: "none",
                      color: selectedEffort ? "var(--aurora-accent)" : "var(--aurora-fg1)",
                      fontSize: 12,
                      fontWeight: selectedEffort ? 600 : 500,
                      cursor: "pointer",
                      maxWidth: "min(170px, 40vw)",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                    }}
                  >
                    {(capabilities?.effort_options && capabilities.effort_options.length > 0
                      ? capabilities.effort_options
                      : [
                          { id: "", name: isZh ? "⚡ 默认 Effort (跟随配置)" : "⚡ Default Effort" },
                          { id: "low", name: "Low (快速/轻量思考)" },
                          { id: "medium", name: "Medium (标准思考量)" },
                          { id: "high", name: "High (深度推理/高思考量)" },
                        ]
                    ).map((opt) => (
                      <option key={opt.id} value={opt.id} title={opt.desc} style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                        {opt.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Own worktree and branch for the agent */}
              {["codex", "claude", "antigravity"].includes(executionMode) && (
                <button
                  type="button"
                  onClick={() => {
                    const next = !worktreeMode;
                    setWorktreeMode(next);
                    persistCurrentConfig({ worktree: next });
                  }}
                  aria-pressed={worktreeMode}
                  title={worktreeMode ? t.taskRun.worktreeOn : t.taskRun.worktreeOff}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    background: worktreeMode ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                    border: "1px solid",
                    borderColor: worktreeMode ? "var(--aurora-accent)" : "var(--aurora-border)",
                    borderRadius: 10,
                    padding: "4px 10px",
                    fontSize: 12,
                    color: worktreeMode ? "var(--aurora-accent)" : "var(--aurora-fg2)",
                    fontWeight: worktreeMode ? 600 : 500,
                    cursor: "pointer",
                  }}
                >
                  <Icon name="layers" size={13} />
                  {t.taskRun.worktree}
                </button>
              )}

              {/* Agent Project selector */}
              {["codex", "claude", "antigravity"].includes(executionMode) && (
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    background: "var(--aurora-chip)",
                    border: "1px solid var(--aurora-border)",
                    borderRadius: 10,
                    padding: "4px 10px",
                    fontSize: 12,
                    maxWidth: "100%",
                    minWidth: 0,
                  }}
                  title={isZh ? "关联项目代码库" : "Associate project repository"}
                >
                  <Icon name="code" size={13} style={{ color: "var(--aurora-fg3)", flexShrink: 0 }} />
                  <select
                    value={selectedProjectId}
                    onChange={(e) => handleSelectProject(e.target.value)}
                    style={{
                      background: "transparent",
                      border: "none",
                      outline: "none",
                      color: "var(--aurora-fg1)",
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: "pointer",
                      maxWidth: "min(200px, 50vw)",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                    }}
                  >
                    <option value="" style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                      {projects.length === 0 ? (isZh ? "暂无项目" : "No projects") : (isZh ? "选择项目 (可选)..." : "Select project (optional)...")}
                    </option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id} style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                        📁 {p.title || p.slug || p.id}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Agent Historical Session selector */}
              {["codex", "claude", "antigravity"].includes(executionMode) && (
                selectedProjectId ? (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      background: selectedSessionId ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                      border: "1px solid",
                      borderColor: selectedSessionId ? "var(--aurora-accent)" : "var(--aurora-border)",
                      borderRadius: 10,
                      padding: "4px 10px",
                      fontSize: 12,
                      maxWidth: "100%",
                      minWidth: 0,
                    }}
                    title={isZh ? "续接该项目下的历史会话" : "Resume historical session"}
                  >
                    <Icon name="clock" size={13} style={{ color: selectedSessionId ? "var(--aurora-accent)" : "var(--aurora-fg3)", flexShrink: 0 }} />
                    <select
                      value={selectedSessionId}
                      onChange={(e) => handleSelectSession(e.target.value)}
                      disabled={loadingSessions}
                      style={{
                        background: "transparent",
                        border: "none",
                        outline: "none",
                        color: selectedSessionId ? "var(--aurora-accent)" : "var(--aurora-fg1)",
                        fontSize: 12,
                        fontWeight: selectedSessionId ? 600 : 500,
                        cursor: "pointer",
                        maxWidth: "min(220px, 55vw)",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        minWidth: 0,
                      }}
                    >
                      <option value="" style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                        {loadingSessions ? (isZh ? "加载会话列表中..." : "Loading sessions...") : (isZh ? "➕ 新建独立会话" : "➕ New Session")}
                      </option>
                      {selectedSessionId && !sessions.some((s) => (s.session_id || s.conversation_id) === selectedSessionId) && (
                        <option value={selectedSessionId} style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                          💬 {selectedSessionId.length > 25 ? selectedSessionId.slice(0, 25) + "..." : selectedSessionId}
                        </option>
                      )}
                      {sessions.map((s) => {
                        const sid = s.session_id || s.conversation_id;
                        const isHeavy = s.compact_recommended || s.message_count > 35 || (s.file_size_bytes && s.file_size_bytes > 300_000);
                        const tag = isHeavy ? " [⚠️ 建议瘦身]" : "";
                        return (
                          <option key={sid} value={sid} style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                            💬 {s.title ? (s.title.length > 25 ? s.title.slice(0, 25) + "..." : s.title) : (sid ? sid.slice(0, 10) + "..." : "会话")}{tag}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                ) : (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      background: "var(--aurora-chip)",
                      border: "1px dashed var(--aurora-border)",
                      borderRadius: 10,
                      padding: "4px 10px",
                      fontSize: 12,
                      color: "var(--aurora-fg3)",
                      opacity: 0.8,
                    }}
                    title={isZh ? "请先选择项目以查看该项目的历史会话列表" : "Select a project to view its historical sessions"}
                  >
                    <Icon name="clock" size={13} style={{ color: "var(--aurora-fg3)", opacity: 0.6, flexShrink: 0 }} />
                    <span>{isZh ? "选项目看历史会话" : "Select project for sessions"}</span>
                  </div>
                )
              )}
            </div>

            {/* Active Resume Session Banner & Historical Context Preview */}
            {selectedSessionId && (() => {
              const activeSession = sessions.find((s) => (s.session_id || s.conversation_id) === selectedSessionId);
              const msgs = activeSession?.messages || [];
              const previewMsgs = msgs.slice(-5);
              const totalCount = activeSession?.message_count || msgs.length;
              const isHeavy = activeSession?.compact_recommended || totalCount > 35 || ((activeSession?.file_size_bytes || 0) > 300_000);

              return (
                <div style={{ marginBottom: 10 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "6px 12px",
                      background: compactMode ? "rgba(16, 185, 129, 0.08)" : "var(--aurora-accent-soft)",
                      border: `1px solid ${compactMode ? "rgba(16, 185, 129, 0.5)" : "var(--aurora-accent)"}`,
                      borderRadius: showSessionContext ? "10px 10px 0 0" : 10,
                      fontSize: 12,
                      color: "var(--aurora-fg1)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }}>
                      <Icon name={compactMode ? "sparkles" : "clock"} size={14} style={{ color: compactMode ? "#10b981" : "var(--aurora-accent)", flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, color: compactMode ? "#10b981" : "var(--aurora-accent)", flexShrink: 0 }}>
                        {compactMode ? (isZh ? "🌟 智能瘦身续接:" : "🌟 Compact resume:") : (isZh ? "续接历史会话:" : "Resuming session:")}
                      </span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--aurora-fg2)", fontWeight: 500 }}>
                        {activeSession?.title || selectedSessionId}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--aurora-fg3)", flexShrink: 0 }}>
                        ({isZh ? `共 ${totalCount} 条消息` : `${totalCount} msgs`})
                      </span>
                      {isHeavy && (
                        <span style={{ fontSize: 10.5, padding: "1px 6px", borderRadius: 4, background: "rgba(245, 158, 11, 0.15)", color: "#f59e0b", fontWeight: 600, flexShrink: 0 }}>
                          ⚠️ {isZh ? "建议瘦身" : "Long"}
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                      <button
                        type="button"
                        onClick={() => {
                          const next = !compactMode;
                          setCompactMode(next);
                          persistCurrentConfig({ compact_mode: next });
                        }}
                        style={{
                          background: compactMode ? "rgba(16, 185, 129, 0.18)" : "var(--aurora-chip)",
                          border: `1px solid ${compactMode ? "#10b981" : "var(--aurora-border)"}`,
                          color: compactMode ? "#10b981" : "var(--aurora-fg2)",
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: 11,
                          padding: "2px 8px",
                          borderRadius: 6,
                          fontWeight: compactMode ? 600 : 500,
                          transition: "all 0.15s ease",
                        }}
                        title={compactMode ? (isZh ? "已开启智能记忆压缩（轻装接续）" : "Smart compaction active") : (isZh ? "切换为智能瘦身模式" : "Switch to smart compact")}
                      >
                        <Icon name="sparkles" size={11} />
                        <span>{compactMode ? (isZh ? "智能瘦身接续" : "Smart Compact") : (isZh ? "原生接续" : "Raw Resume")}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowSessionContext(!showSessionContext)}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--aurora-accent)",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 3,
                          fontSize: 11.5,
                          padding: "2px 6px",
                          borderRadius: 6,
                          fontWeight: 600,
                        }}
                        title={showSessionContext ? (isZh ? "收起历史上下文" : "Collapse context") : (isZh ? "展开历史上下文" : "Expand context")}
                      >
                        <Icon name={showSessionContext ? "chevron_up" : "chevron_down"} size={12} />
                        <span>{showSessionContext ? (isZh ? "收起上下文" : "Hide Context") : (isZh ? "预览上下文" : "Preview Context")}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSelectSession("")}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--aurora-fg3)",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 3,
                          fontSize: 11,
                          padding: "2px 6px",
                          borderRadius: 6,
                          flexShrink: 0,
                        }}
                        title={isZh ? "退出续接，开启新会话" : "Cancel resume, start new"}
                      >
                        <Icon name="close" size={12} />
                        <span>{isZh ? "退出" : "Exit"}</span>
                      </button>
                    </div>
                  </div>

                  {/* Context Preview Drawer */}
                  {showSessionContext && (
                    <div
                      style={{
                        padding: "10px 14px",
                        background: "var(--aurora-surface-solid)",
                        border: "1px solid var(--aurora-accent)",
                        borderTop: "none",
                        borderRadius: "0 0 10px 10px",
                        fontSize: 12,
                        boxShadow: "0 4px 12px rgba(0,0,0,0.06)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: 8,
                          paddingBottom: 6,
                          borderBottom: "1px solid var(--aurora-border)",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontWeight: 600, color: "var(--aurora-fg1)" }}>
                            {isZh ? "历史会话上下文 (最近交互)" : "Historical Context (Recent Turns)"}
                          </span>
                          {previewMsgs.length > 0 && (
                            <span style={{ fontSize: 11, color: "var(--aurora-fg3)" }}>
                              ({isZh ? `显示最近 ${previewMsgs.length} 条` : `Showing last ${previewMsgs.length}`})
                            </span>
                          )}
                        </div>
                        {activeSession?.conversation_id && (
                          <a
                            href={`/conversations/${activeSession.conversation_id}`}
                            target="_blank"
                            rel="noreferrer"
                            style={{
                              color: "var(--aurora-accent)",
                              textDecoration: "none",
                              fontSize: 11.5,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                              fontWeight: 500,
                            }}
                          >
                            <span>{isZh ? "在新标签页查看完整会话" : "View Full Conversation"}</span>
                            <Icon name="external_link" size={11} />
                          </a>
                        )}
                      </div>

                      {/* Messages list */}
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                          maxHeight: "min(170px, 25vh)",
                          overflowY: "auto",
                          overscrollBehavior: "contain",
                          WebkitOverflowScrolling: "touch",
                          paddingRight: 4,
                        }}
                      >
                        {previewMsgs.length === 0 ? (
                          <div style={{ color: "var(--aurora-fg3)", textAlign: "center", padding: "12px 0", fontSize: 12 }}>
                            {isZh ? "该会话暂无历史文本消息记录" : "No textual messages recorded in this session"}
                          </div>
                        ) : (
                          previewMsgs.map((m, idx) => {
                            const isUser = m.role === "user";
                            return (
                              <div
                                key={idx}
                                style={{
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: 3,
                                  background: isUser ? "var(--aurora-chip)" : "var(--aurora-surface)",
                                  border: `1px solid ${isUser ? "var(--aurora-border)" : "var(--aurora-border)"}`,
                                  borderRadius: 8,
                                  padding: "6px 10px",
                                }}
                              >
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11 }}>
                                  <span style={{ fontWeight: 600, color: isUser ? "var(--aurora-accent)" : "var(--aurora-fg2)" }}>
                                    {isUser
                                      ? (isZh ? "👤 用户提问" : "👤 User")
                                      : (m.subagent_name
                                          ? `🔀 ${m.subagent_name}`
                                          : `🤖 ${executionMode === "claude" ? "Claude Code" : executionMode === "codex" ? "OpenAI Codex" : executionMode === "antigravity" ? "Google Antigravity" : "Assistant"}`)}
                                  </span>
                                  {m.timestamp && (
                                    <span style={{ color: "var(--aurora-fg3)", fontSize: 10 }}>
                                      {new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                    </span>
                                  )}
                                </div>
                                <div
                                  style={{
                                    color: "var(--aurora-fg1)",
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-word",
                                    lineHeight: 1.45,
                                    maxHeight: 90,
                                    overflowY: "auto",
                                    fontSize: 12,
                                  }}
                                >
                                  {m.content?.trim() || ""}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

            {/* Voice Recording Active Banner */}
            {isRecordingVoice && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "4px 12px",
                  marginBottom: 6,
                  borderRadius: 10,
                  background: "rgba(239, 68, 68, 0.1)",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  fontSize: 11.5,
                  color: "#ef4444",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="w-2 h-2 rounded-full bg-[#ef4444] animate-ping" />
                  <span style={{ fontWeight: 600 }}>{isZh ? "🎙️ 正在倾听吩咐... 实时转写中" : "Listening & transcribing..."}</span>
                </div>
                <button
                  type="button"
                  onClick={toggleVoiceInput}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#ef4444",
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  {isZh ? "完成倾听" : "Done"}
                </button>
              </div>
            )}

            {/* Speech Hint Floating Pill */}
            {speechHint && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "5px 12px",
                  marginBottom: 6,
                  borderRadius: 10,
                  background: "rgba(124, 58, 237, 0.12)",
                  border: "1px solid rgba(124, 58, 237, 0.3)",
                  fontSize: 12,
                  color: "#A78BFA",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span>🎙️</span>
                  <span>{speechHint}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setSpeechHint(null)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "inherit",
                    cursor: "pointer",
                    fontSize: 13,
                    opacity: 0.7,
                    padding: "0 4px",
                  }}
                >
                  ✕
                </button>
              </div>
            )}

            {/* Attached images preview list */}
            {attachedImages.length > 0 && (
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  padding: "4px 2px 10px 2px",
                  alignItems: "center",
                }}
              >
                {attachedImages.map((img) => (
                  <div
                    key={img.id}
                    style={{
                      position: "relative",
                      borderRadius: 10,
                      overflow: "hidden",
                      border: "1px solid var(--aurora-border)",
                      background: "rgba(0,0,0,0.25)",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
                    }}
                  >
                    <img
                      src={img.dataUrl}
                      alt={img.name}
                      style={{
                        width: 48,
                        height: 48,
                        objectFit: "cover",
                        display: "block",
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => removeAttachedImage(img.id)}
                      title={isZh ? "移除图片" : "Remove image"}
                      style={{
                        position: "absolute",
                        top: 2,
                        right: 2,
                        width: 16,
                        height: 16,
                        borderRadius: 999,
                        background: "rgba(0,0,0,0.75)",
                        color: "#fff",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 10,
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <span style={{ fontSize: 11, color: "var(--aurora-fg3)" }}>
                  {isZh ? `已附加 ${attachedImages.length} 张图片` : `${attachedImages.length} image(s) attached`}
                </span>
              </div>
            )}

            {/* Input box and action button */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", width: "100%", minWidth: 0, boxSizing: "border-box" }}>
              {/* Image Upload Button */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title={isZh ? "上传图片或截图 (支持直接粘贴 Ctrl+V / Cmd+V)" : "Upload image (supports Ctrl+V / Cmd+V)"}
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: attachedImages.length > 0 ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                  border: `1px solid ${attachedImages.length > 0 ? "var(--aurora-accent)" : "var(--aurora-border)"}`,
                  color: attachedImages.length > 0 ? "var(--aurora-accent)" : "var(--aurora-fg3)",
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                  flexShrink: 0,
                  boxSizing: "border-box",
                }}
                className="hover:text-[var(--aurora-fg1)] hover:border-[var(--aurora-border-strong)]"
              >
                <Icon name="image" size={16} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: "none" }}
                onChange={handleFileChange}
              />

              <GhostInput
                inputRef={inputElRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={handlePaste}
                onFocus={() => {
                  setTimeout(() => {
                    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
                  }, 120);
                }}
                onKeyDown={onKeyDown}
                placeholder={placeholderText}
                icon={
                  executionMode === "shell"
                    ? "terminal"
                    : executionMode === "claude" || executionMode === "codex" || executionMode === "antigravity"
                    ? "code"
                    : selectedDevice === "ask_only"
                    ? "sparkles"
                    : "brain"
                }
                wrapStyle={{
                  flex: 1,
                  minWidth: 0,
                  background: "var(--aurora-chip)",
                  border: "1px solid var(--aurora-border)",
                  boxSizing: "border-box",
                }}
                disabled={streaming}
              />
              {/* Voice Input Button */}
              <button
                type="button"
                onClick={toggleVoiceInput}
                title={isRecordingVoice ? (isZh ? "停止倾听" : "Stop listening") : (isZh ? "语音吩咐 (按键说话)" : "Voice input")}
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: isRecordingVoice ? "rgba(239, 68, 68, 0.16)" : "var(--aurora-chip)",
                  border: isRecordingVoice ? "1px solid #ef4444" : "1px solid var(--aurora-border)",
                  color: isRecordingVoice ? "#ef4444" : "var(--aurora-fg3)",
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                  flexShrink: 0,
                  boxSizing: "border-box",
                }}
                className={isRecordingVoice ? "animate-pulse shadow-sm" : "hover:text-[var(--aurora-fg1)]"}
              >
                <Icon name="microphone" size={15} />
              </button>
              {streaming ? (
                <Btn onClick={stopRun} style={{ flexShrink: 0 }}>{t.ask.stop}</Btn>
              ) : (
                <Btn
                  onClick={send}
                  disabled={!input.trim() && attachedImages.length === 0}
                  icon={executionMode === "shell" ? "terminal" : executionMode !== "ai" ? "rocket" : selectedDevice === "ask_only" ? "search" : "rocket"}
                  style={{ flexShrink: 0 }}
                >
                  {t.ask.send}
                </Btn>
              )}
            </div>
          </div>
        </div>
      </footer>
    </div>

      {/* AI Subscription Quotas Popover */}
      <AgentQuotaPopover
        isOpen={quotaOpen}
        onClose={() => setQuotaOpen(false)}
        deviceId={selectedDevice}
      />

      {/* History Drawer Overlay & Sidebar */}
      {historyOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          {/* Backdrop */}
          <div
            onClick={() => setHistoryOpen(false)}
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0, 0, 0, 0.45)",
              backdropFilter: "blur(4px)",
            }}
          />

          {/* Drawer content */}
          <div
            style={{
              position: "relative",
              width: "min(380px, 90vw)",
              height: "100%",
              background: "var(--aurora-surface-solid)",
              borderLeft: "1px solid var(--aurora-border)",
              boxShadow: "-8px 0 32px rgba(0, 0, 0, 0.16)",
              display: "flex",
              flexDirection: "column",
              zIndex: 1,
            }}
          >
            {/* Drawer Header */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
                padding: "16px 20px",
                borderBottom: "1px solid var(--aurora-border)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon name="clock" size={18} style={{ color: "var(--aurora-accent)" }} />
                  <span style={{ fontSize: 15, fontWeight: 600, color: "var(--aurora-fg1)" }}>
                    {t.ask.historyTitle}
                  </span>
                  {conversations.length > 0 && (
                    <span
                      style={{
                        fontSize: 11,
                        padding: "2px 7px",
                        borderRadius: 999,
                        background: "var(--aurora-chip)",
                        color: "var(--aurora-fg3)",
                      }}
                    >
                      {conversations.length}
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button
                    type="button"
                    onClick={startNewChat}
                    title={t.ask.newChat}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      background: "var(--aurora-chip)",
                      border: "1px solid var(--aurora-border)",
                      color: "var(--aurora-fg2)",
                      cursor: "pointer",
                    }}
                  >
                    <Icon name="plus" size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setHistoryOpen(false)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      background: "transparent",
                      border: "none",
                      color: "var(--aurora-fg3)",
                      cursor: "pointer",
                    }}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
              </div>

              {selectedDevice && selectedDevice !== "auto" && selectedDevice !== "ask_only" && (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => {
                      setHistoryFilterDevice(true);
                      loadConversations(true);
                    }}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 14,
                      fontSize: 11.5,
                      fontWeight: historyFilterDevice ? 600 : 400,
                      cursor: "pointer",
                      border: "1px solid",
                      borderColor: historyFilterDevice ? "var(--aurora-accent)" : "var(--aurora-border)",
                      background: historyFilterDevice ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                      color: historyFilterDevice ? "var(--aurora-accent)" : "var(--aurora-fg3)",
                    }}
                  >
                    🖥️ 当前设备 ({devices.find((d) => d.device_id === selectedDevice)?.name || selectedDevice.slice(0, 8)})
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setHistoryFilterDevice(false);
                      loadConversations(false);
                    }}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 14,
                      fontSize: 11.5,
                      fontWeight: !historyFilterDevice ? 600 : 400,
                      cursor: "pointer",
                      border: "1px solid",
                      borderColor: !historyFilterDevice ? "var(--aurora-accent)" : "var(--aurora-border)",
                      background: !historyFilterDevice ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                      color: !historyFilterDevice ? "var(--aurora-accent)" : "var(--aurora-fg3)",
                    }}
                  >
                    🌐 全部设备
                  </button>
                </div>
              )}
            </div>

            {/* Drawer List */}
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "12px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {loadingHistory ? (
                <div style={{ textAlign: "center", padding: "40px 0", color: "var(--aurora-fg4)", fontSize: 13 }}>
                  加载中...
                </div>
              ) : conversations.length === 0 ? (
                <div
                  style={{
                    textAlign: "center",
                    padding: "48px 20px",
                    color: "var(--aurora-fg4)",
                    fontSize: 13,
                  }}
                >
                  {t.ask.noHistory}
                </div>
              ) : (
                conversations.map((c) => {
                  const isActive = c.id === activeConversationId;
                  const dateStr = c.updated_at
                    ? new Date(c.updated_at).toLocaleString(undefined, {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "";
                  return (
                    <div
                      key={c.id}
                      onClick={() => loadConversation(c.id)}
                      style={{
                        padding: "11px 13px",
                        borderRadius: 10,
                        background: isActive ? "var(--aurora-chip)" : "transparent",
                        border: "1px solid",
                        borderColor: isActive ? "var(--aurora-accent)" : "transparent",
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.background = "var(--aurora-chip)";
                          e.currentTarget.style.borderColor = "var(--aurora-border)";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.background = "transparent";
                          e.currentTarget.style.borderColor = "transparent";
                        }
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 13.5,
                            fontWeight: isActive ? 600 : 500,
                            color: isActive ? "var(--aurora-accent)" : "var(--aurora-fg1)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            lineHeight: 1.4,
                          }}
                        >
                          {c.title || t.ask.title}
                        </div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            fontSize: 11.5,
                            color: "var(--aurora-fg4)",
                            marginTop: 4,
                          }}
                        >
                          <span>{dateStr}</span>
                          {c.device_id && (
                            <>
                              <span>·</span>
                              <span
                                style={{
                                  padding: "1px 5px",
                                  borderRadius: 4,
                                  background: "var(--aurora-chip)",
                                  fontSize: 10,
                                  fontFamily: "monospace",
                                }}
                              >
                                {c.device_id.slice(0, 8)}
                              </span>
                            </>
                          )}
                          <span>·</span>
                          <span>{t.ask.turnsCount.replace("{n}", String(c.message_count))}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => deleteConversation(e, c.id)}
                        title={t.ask.deleteConfirm}
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "var(--aurora-fg4)",
                          cursor: "pointer",
                          padding: 6,
                          borderRadius: 6,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          opacity: 0.6,
                          transition: "all 0.15s ease",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.color = "#ef4444";
                          e.currentTarget.style.opacity = "1";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.color = "var(--aurora-fg4)";
                          e.currentTarget.style.opacity = "0.6";
                        }}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Sources Drawer Overlay & Sidebar */}
      {sourcesOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          {/* Backdrop */}
          <div
            onClick={() => setSourcesOpen(false)}
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0, 0, 0, 0.45)",
              backdropFilter: "blur(4px)",
            }}
          />

          {/* Drawer content */}
          <div
            style={{
              position: "relative",
              width: "min(460px, 92vw)",
              height: "100%",
              background: "var(--aurora-surface-solid)",
              borderLeft: "1px solid var(--aurora-border)",
              boxShadow: "-8px 0 32px rgba(0, 0, 0, 0.16)",
              display: "flex",
              flexDirection: "column",
              zIndex: 1,
            }}
          >
            {/* Drawer Header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 20px",
                borderBottom: "1px solid var(--aurora-border)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon name="book" size={18} style={{ color: "var(--aurora-accent)" }} />
                <span style={{ fontSize: 15, fontWeight: 600, color: "var(--aurora-fg1)" }}>
                  {t.ask.sources}
                </span>
                {selectedSources.length > 0 && (
                  <span
                    style={{
                      fontSize: 11,
                      padding: "2px 7px",
                      borderRadius: 999,
                      background: "rgba(56, 189, 248, 0.15)",
                      color: "var(--aurora-accent)",
                      fontWeight: 600,
                    }}
                  >
                    {selectedSources.length}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setSourcesOpen(false)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  background: "transparent",
                  border: "none",
                  color: "var(--aurora-fg3)",
                  cursor: "pointer",
                }}
              >
                <Icon name="close" size={16} />
              </button>
            </div>

            {/* Drawer List */}
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "14px",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              {selectedSources.map((s, si) => (
                <div
                  key={s.id || si}
                  style={{
                    padding: "14px 16px",
                    borderRadius: 12,
                    background: "var(--aurora-bg)",
                    border: "1px solid var(--aurora-border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.03)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: "var(--aurora-accent)",
                        }}
                      >
                        [{si + 1}]
                      </span>
                      <ToolGlyph id={s.tool_id} size={16} />
                      {s.category && (
                        <span
                          style={{
                            fontSize: 10.5,
                            padding: "2px 7px",
                            borderRadius: 6,
                            background: "var(--aurora-surface-solid)",
                            border: "1px solid var(--aurora-border)",
                            color: "var(--aurora-fg3)",
                            fontWeight: 500,
                          }}
                        >
                          {s.category}
                        </span>
                      )}
                    </div>
                    {s.synced_at && (
                      <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>
                        {formatRelativeTime(s.synced_at, isZh)}
                      </span>
                    )}
                  </div>

                  <Link
                    href={`/documents/${s.id}`}
                    target="_blank"
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--aurora-fg1)",
                      textDecoration: "none",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      lineHeight: 1.4,
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.title || s.relative_path}
                    </span>
                    <Icon name="external_link" size={13} style={{ flexShrink: 0, opacity: 0.6 }} />
                  </Link>

                  {s.excerpt && (
                    <div
                      style={{
                        fontSize: 12,
                        lineHeight: 1.6,
                        color: "var(--aurora-fg2)",
                        background: "var(--aurora-surface-solid)",
                        borderRadius: 8,
                        padding: "10px 12px",
                        border: "1px solid var(--aurora-border)",
                        borderLeft: "3px solid var(--aurora-accent)",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        maxHeight: 180,
                        overflowY: "auto",
                      }}
                    >
                      {formatExcerpt(s.excerpt)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 栏 3: 右侧媒体独立视窗 (桌面端并列第三栏，移动端滑出全屏抽屉) */}
      <MediaInspectorPanel />
    </div>
  );
}

export default function AskPage() {
  return (
    <Suspense fallback={<div style={{ color: "var(--aurora-fg4)", textAlign: "center", marginTop: 80 }}>加载中...</div>}>
      <MediaInspectorProvider>
        <AskPageContent />
      </MediaInspectorProvider>
    </Suspense>
  );
}
