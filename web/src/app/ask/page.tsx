"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { getApiBase, authFetch, api, DeviceSummary, AskConversationSummary, ProjectSummary } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { Icon, ToolGlyph } from "@/components/aurora/Icon";
import { BrandMark } from "@/components/aurora/BrandMark";
import { Btn, Chip, Glass, GhostInput, TopBar } from "@/components/aurora/primitives";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";
import { ExecutionTabs, ToolCallItem } from "@/components/ExecutionCard";

export type ExecutionMode = "ai" | "claude" | "codex" | "antigravity" | "shell";

export const AGENT_MODELS: Record<string, Array<{ id: string; name: string; desc?: string }>> = {
  codex: [
    { id: "", name: "⚡ 默认模型 (跟随客户端/CLI配置)", desc: "使用本地 Codex 客户端配置的默认模型" },
    { id: "gpt-5.5", name: "GPT-5.5 (官方推荐)", desc: "当前 Codex 推荐主力模型" },
    { id: "gpt-6-astra", name: "GPT-6-Astra (最新)", desc: "最新前沿多步推理模型" },
    { id: "gpt-5.1-codex-max", name: "GPT-5.1-Codex-Max", desc: "经典全能模型" },
    { id: "o3", name: "o3 (深度思维)", desc: "OpenAI 深度推理" },
    { id: "o4-mini", name: "o4-mini", desc: "极速响应" },
  ],
  claude: [
    { id: "", name: "⚡ 默认模型 (跟随客户端/CLI配置)", desc: "使用本地 Claude 客户端配置的默认模型" },
    { id: "sonnet", name: "sonnet (最新 Sonnet 别名)", desc: "自动映射当前官方最新 Sonnet" },
    { id: "opus", name: "opus (最新 Opus 别名 / 4.6)", desc: "高阶架构与超大上下文" },
    { id: "haiku", name: "haiku (最新 Haiku 别名 / 4.5)", desc: "极速轻量" },
    { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", desc: "混合推理与编码" },
  ],
  antigravity: [
    { id: "", name: "⚡ 默认模型 (系统配置)", desc: "使用当前 Antigravity 默认模型" },
    { id: "flash", name: "Gemini Flash (快速)", desc: "快速平衡" },
    { id: "pro", name: "Gemini Pro (强力)", desc: "深度推理" },
    { id: "flash_lite", name: "Gemini Flash-Lite", desc: "极轻量" },
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

interface Turn {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  sources?: Source[];
  toolCalls?: ToolCallItem[];
  error?: boolean;
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

function AskPageContent() {
  const searchParams = useSearchParams();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>("auto");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("ai");
  const [cwd, setCwd] = useState<string>("");
  const [showCwd, setShowCwd] = useState<boolean>(false);

  // Agent Context: Model, Project & Session selection
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [isCustomModel, setIsCustomModel] = useState<boolean>(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [sessions, setSessions] = useState<Array<{ session_id: string; title: string; conversation_id: string; message_count: number; timestamp: string }>>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [loadingSessions, setLoadingSessions] = useState<boolean>(false);

  // Conversation history state
  const [conversations, setConversations] = useState<AskConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const activeConversationIdRef = useRef<string | null>(null);
  const streamingRef = useRef<boolean>(false);
  const [historyOpen, setHistoryOpen] = useState<boolean>(false);
  const [loadingHistory, setLoadingHistory] = useState<boolean>(false);

  // Sources drawer state
  const [sourcesOpen, setSourcesOpen] = useState<boolean>(false);
  const [selectedSources, setSelectedSources] = useState<Source[]>([]);

  const { t, locale } = useI18n();
  const isZh = locale.startsWith("zh");
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load conversation list
  const loadConversations = useCallback(async () => {
    try {
      setLoadingHistory(true);
      const list = await api.listAskConversations();
      setConversations(list || []);
    } catch (e) {
      console.error("Failed to load ask conversations:", e);
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  // Load single conversation
  const loadConversation = useCallback(async (id: string) => {
    if (!id || streamingRef.current) return;
    try {
      const data = await api.getAskConversation(id);
      activeConversationIdRef.current = data.id;
      setActiveConversationId(data.id);
      window.history.replaceState(null, "", `/ask?id=${data.id}`);
      if (data.device_id) setSelectedDevice(data.device_id);
      if (data.cwd) setCwd(data.cwd);
      setTurns(data.turns || []);
      setHistoryOpen(false);
      setSourcesOpen(false);
    } catch (e) {
      console.error("Failed to load conversation:", e);
    }
  }, []);

  // Start fresh chat
  const startNewChat = useCallback(() => {
    abortRef.current?.abort();
    streamingRef.current = false;
    activeConversationIdRef.current = null;
    setActiveConversationId(null);
    setTurns([]);
    setInput("");
    window.history.replaceState(null, "", "/ask");
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

  useEffect(() => {
    loadConversations();
    if (idParam && idParam !== activeConversationIdRef.current && !streamingRef.current) {
      loadConversation(idParam);
    }
  }, [idParam, loadConversation, loadConversations]);

  // Follow the stream as tokens land.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  // Abort any in-flight stream if the user navigates away mid-answer.
  useEffect(() => () => abortRef.current?.abort(), []);

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

  const sendWithText = useCallback(async (textToSend: string) => {
    const question = textToSend.trim();
    if (!question || streamingRef.current) return;

    // Snapshot history BEFORE appending, preserving tool execution results for follow-up turns
    const history = turns
      .filter((x) => !x.error)
      .map((x) => ({
        role: x.role,
        content: x.content,
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
    setTurns((prev) => [
      ...prev,
      { role: "user", content: question },
      { role: "assistant", content: "", toolCalls: [] },
    ]);
    streamingRef.current = true;
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Mutate the last (assistant) turn as deltas arrive.
    const patchLast = (fn: (turn: Turn) => Turn) =>
      setTurns((prev) => {
        const next = [...prev];
        const i = next.length - 1;
        if (i >= 0 && next[i].role === "assistant") {
          next[i] = fn(next[i]);
        } else {
          next.push(fn({ role: "assistant", content: "", toolCalls: [] }));
        }
        return next;
      });

    try {
      const res = await authFetch(`${getApiBase()}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          conversation_id: activeConversationId || undefined,
          history,
          device_id: selectedDevice,
          cwd: cwd.trim() || undefined,
          agent_mode: selectedDevice !== "ask_only",
          execution_mode: executionMode,
          model: selectedModel || undefined,
          session_id: selectedSessionId || undefined,
          project_id: selectedProjectId || undefined,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        patchLast((x) => ({ ...x, content: t.ask.error, error: true }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
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
          };
          try {
            evt = JSON.parse(line.slice(6));
          } catch {
            continue;
          }

          if (evt.type === "conversation_id" && evt.id) {
            activeConversationIdRef.current = evt.id;
            setActiveConversationId(evt.id);
            window.history.replaceState(null, "", `/ask?id=${evt.id}`);
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
                calls[idx] = { ...calls[idx], result: evt.result };
              } else if (calls.length > 0) {
                calls[calls.length - 1] = { ...calls[calls.length - 1], result: evt.result };
              }
              return { ...x, toolCalls: calls };
            });
          } else if (evt.type === "thinking" && evt.text) {
            patchLast((x) => ({ ...x, thinking: (x.thinking || "") + evt.text }));
          } else if (evt.type === "delta" && evt.text) {
            patchLast((x) => ({ ...x, content: x.content + evt.text }));
          } else if (evt.type === "error") {
            patchLast((x) => ({ ...x, content: evt.message || t.ask.error, error: true }));
          }
        }
      }
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        patchLast((x) => ({ ...x, content: x.content || t.ask.error, error: true }));
      }
    } finally {
      streamingRef.current = false;
      setStreaming(false);
      abortRef.current = null;
      loadConversations();
    }
  }, [activeConversationId, cwd, executionMode, loadConversations, selectedDevice, selectedModel, selectedProjectId, selectedSessionId, streaming, turns, t]);

  const send = useCallback(() => {
    sendWithText(input);
  }, [input, sendWithText]);

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

  const loadProjectsForMode = useCallback(async (mode: ExecutionMode) => {
    const toolMap: Record<string, string> = {
      codex: "codex",
      claude: "claude_code",
      antigravity: "antigravity",
    };
    const toolId = toolMap[mode];
    if (!toolId) {
      setProjects([]);
      setSelectedProjectId("");
      setSessions([]);
      setSelectedSessionId("");
      return;
    }
    try {
      const list = await api.listProjects(toolId);
      setProjects(list || []);
    } catch (e) {
      console.error("Failed to load projects:", e);
      setProjects([]);
    }
  }, []);

  const handleSelectMode = (mode: ExecutionMode) => {
    setExecutionMode(mode);
    if (mode !== "ai" && selectedDevice === "ask_only") {
      setSelectedDevice("auto");
    }
    // Default to empty (follow client/CLI config), never force hardcoded model!
    setSelectedModel("");
    setIsCustomModel(false);
    loadProjectsForMode(mode);
  };

  const handleSelectProject = useCallback(async (projId: string) => {
    setSelectedProjectId(projId);
    setSelectedSessionId("");
    if (!projId) {
      setSessions([]);
      return;
    }
    const proj = projects.find((p) => p.id === projId);
    if (proj?.source_path) {
      setCwd(proj.source_path);
      setShowCwd(true);
    }
    setLoadingSessions(true);
    try {
      const res = await api.getProjectConversations(projId, 0, 30, "desc");
      setSessions(res.sessions || []);
    } catch (e) {
      console.error("Failed to load project sessions:", e);
      setSessions([]);
    } finally {
      setLoadingSessions(false);
    }
  }, [projects]);

  // Sync projects on initial load if starting in agent mode
  useEffect(() => {
    if (["codex", "claude", "antigravity"].includes(executionMode)) {
      loadProjectsForMode(executionMode);
    }
  }, [executionMode, loadProjectsForMode]);

  const currentDev = devices.find((d) => d.device_id === selectedDevice);
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

  return (
    <div className="w-full max-w-4xl mx-auto pb-44 min-w-0 overflow-x-hidden">
      <TopBar
        title={t.ask.title}
        subtitle={t.ask.subtitle}
        right={
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Btn
              variant="glass"
              size="sm"
              icon="clock"
              onClick={() => setHistoryOpen(true)}
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
            <Btn
              variant="glass"
              size="sm"
              icon="plus"
              onClick={startNewChat}
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
              >
                {t.ask.clear}
              </Btn>
            )}
          </div>
        }
      />

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
      <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 20, maxWidth: "100%", minWidth: 0 }}>
        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <div key={i} style={{ display: "flex", justifyContent: "flex-end" }}>
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
                }}
              >
                {turn.content}
              </div>
            </div>
          ) : (
            <Glass key={i} padding="clamp(12px, 3vw, 20px)" radius={18} style={{ maxWidth: "100%", minWidth: 0, overflow: "hidden" }}>
              {/* Optional top toolbar / sources pill */}
              {turn.sources && turn.sources.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    marginBottom: 10,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedSources(turn.sources || []);
                      setSourcesOpen(true);
                      setHistoryOpen(false);
                    }}
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
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "var(--aurora-accent)";
                      e.currentTarget.style.color = "var(--aurora-accent)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "var(--aurora-border)";
                      e.currentTarget.style.color = "var(--aurora-fg2)";
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

              {(() => {
                const { thinking, content } = parseTurnContent(turn);
                const isLastTurn = i === turns.length - 1;
                const isThinkingActive = Boolean(streaming && isLastTurn && !content);
                const hasTools = Boolean(turn.toolCalls && turn.toolCalls.length > 0);

                return (
                  <>
                    {/* Collapsible Thinking Process Block */}
                    {(thinking || isThinkingActive) && (
                      <ThinkingBlock thinking={thinking} isLive={isThinkingActive} />
                    )}

                    {/* Render tool executions with multi-device tabs */}
                    {hasTools && (
                      <div style={{ marginBottom: 12 }}>
                        <ExecutionTabs calls={turn.toolCalls!} />
                      </div>
                    )}

                    {/* Render assistant text output */}
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
                  </>
                );
              })()}
            </Glass>
          )
        )}
        <div ref={bottomRef} />
      </div>

      {/* Fixed Viewport Bottom Interactive Console Bar */}
      <div
        className="fixed bottom-0 left-0 lg:left-60 right-0 z-20 pointer-events-none"
        style={{
          paddingBottom: "clamp(12px, 2.5vh, 20px)",
          paddingTop: 28,
          background: "linear-gradient(to top, var(--aurora-bg) 75%, transparent)",
        }}
      >
        <div className="max-w-4xl mx-auto px-3 sm:px-4 md:px-6 pointer-events-auto">
          <div
            style={{
              background: "var(--aurora-surface-solid)",
              border: "1px solid var(--aurora-border-strong)",
              borderRadius: 18,
              padding: "10px 14px",
              boxShadow: "var(--aurora-card-shadow), 0 16px 40px -8px rgba(0,0,0,0.14)",
              backdropFilter: "blur(20px)",
              maxWidth: "100%",
              minWidth: 0,
            }}
          >
            {/* Agent Mode Selector Toolbelt */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 8,
                overflowX: "auto",
                maxWidth: "100%",
                paddingBottom: 2,
                scrollbarWidth: "none",
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
                  </button>
                );
              })}
            </div>

            {/* Device & environment toolbelt */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap", maxWidth: "100%", minWidth: 0 }}>
              {/* Target device selector */}
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
              >
                <Icon name="devices" size={13} style={{ color: "var(--aurora-accent)", flexShrink: 0 }} />
                <select
                  value={selectedDevice}
                  onChange={(e) => setSelectedDevice(e.target.value)}
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
                  {devices.map((d) => (
                    <option key={d.device_id} value={d.device_id} style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                      🖥️ {d.name} ({d.device_id.slice(0, 8)})
                    </option>
                  ))}
                  <option value="ask_only" style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                    {t.ask.askOnly}
                  </option>
                </select>
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
                      onChange={(e) => setCwd(e.target.value)}
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
                      onChange={(e) => setSelectedModel(e.target.value)}
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
                        } else {
                          setSelectedModel(e.target.value);
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
                      {(AGENT_MODELS[executionMode] || []).map((m) => (
                        <option key={m.id} value={m.id} style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
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
                      {isZh ? "选择项目 (可选)..." : "Select project (optional)..."}
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
              {["codex", "claude", "antigravity"].includes(executionMode) && selectedProjectId && (
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
                    onChange={(e) => setSelectedSessionId(e.target.value)}
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
                    {sessions.map((s) => {
                      const sid = s.session_id || s.conversation_id;
                      return (
                        <option key={sid} value={sid} style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                          💬 {s.title ? (s.title.length > 25 ? s.title.slice(0, 25) + "..." : s.title) : (sid ? sid.slice(0, 10) + "..." : "会话")}
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}
            </div>

            {/* Active Resume Session Banner */}
            {selectedSessionId && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 8,
                  padding: "6px 12px",
                  background: "var(--aurora-accent-soft)",
                  border: "1px solid var(--aurora-accent)",
                  borderRadius: 10,
                  fontSize: 12,
                  color: "var(--aurora-fg1)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }}>
                  <Icon name="clock" size={14} style={{ color: "var(--aurora-accent)", flexShrink: 0 }} />
                  <span style={{ fontWeight: 600, color: "var(--aurora-accent)", flexShrink: 0 }}>
                    {isZh ? "续接历史会话:" : "Resuming session:"}
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--aurora-fg2)" }}>
                    {sessions.find((s) => (s.session_id || s.conversation_id) === selectedSessionId)?.title || selectedSessionId}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedSessionId("")}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--aurora-fg3)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 11,
                    padding: "2px 6px",
                    borderRadius: 6,
                    flexShrink: 0,
                  }}
                  title={isZh ? "退出续接，开启新会话" : "Cancel resume, start new"}
                >
                  <Icon name="close" size={12} />
                  <span>{isZh ? "退出续接" : "Cancel"}</span>
                </button>
              </div>
            )}

            {/* Input box and action button */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", width: "100%", minWidth: 0 }}>
              <GhostInput
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
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
                }}
                disabled={streaming}
              />
              {streaming ? (
                <Btn onClick={() => abortRef.current?.abort()} style={{ flexShrink: 0 }}>{t.ask.stop}</Btn>
              ) : (
                <Btn
                  onClick={send}
                  disabled={!input.trim()}
                  icon={executionMode === "shell" ? "terminal" : executionMode !== "ai" ? "rocket" : selectedDevice === "ask_only" ? "search" : "rocket"}
                  style={{ flexShrink: 0 }}
                >
                  {t.ask.send}
                </Btn>
              )}
            </div>
          </div>
        </div>
      </div>

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
              background: "var(--aurora-bg2)",
              borderLeft: "1px solid var(--aurora-border)",
              boxShadow: "-8px 0 28px rgba(0, 0, 0, 0.2)",
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
              width: "min(420px, 92vw)",
              height: "100%",
              background: "var(--aurora-bg2)",
              borderLeft: "1px solid var(--aurora-border)",
              boxShadow: "-8px 0 28px rgba(0, 0, 0, 0.2)",
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
                    padding: "12px 14px",
                    borderRadius: 12,
                    background: "var(--aurora-chip)",
                    border: "1px solid var(--aurora-border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
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
                            padding: "1px 6px",
                            borderRadius: 6,
                            background: "rgba(255,255,255,0.06)",
                            color: "var(--aurora-fg3)",
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
                        fontSize: 11.5,
                        lineHeight: 1.5,
                        color: "var(--aurora-fg3)",
                        background: "rgba(0, 0, 0, 0.12)",
                        borderRadius: 8,
                        padding: "8px 10px",
                        borderLeft: "2px solid var(--aurora-accent)",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        maxHeight: 140,
                        overflowY: "auto",
                      }}
                    >
                      {s.excerpt}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AskPage() {
  return (
    <Suspense fallback={<div style={{ color: "var(--aurora-fg4)", textAlign: "center", marginTop: 80 }}>加载中...</div>}>
      <AskPageContent />
    </Suspense>
  );
}
