"use client";

import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/aurora/Icon";
import { BrandMark } from "@/components/aurora/BrandMark";
import { Btn } from "@/components/aurora/primitives";
import { api, type AskConversationSummary, type DeviceSummary } from "@/lib/api-client";
import { triggerHapticFeedback } from "@/lib/native-notify";
import { cancelPrefetchConversationTurns } from "@/lib/ask/cache";

export interface ConversationAgentInfo {
  id: "claude_code" | "antigravity" | "codex" | "workbuddy" | "shell" | "ai";
  name: string;
  brandId?: "claude_code" | "antigravity" | "codex" | "workbuddy";
}

export function resolveConversationAgent(c: AskConversationSummary): ConversationAgentInfo {
  const cfg = c.config || {};
  const rawMode = String(
    cfg.executionMode ||
    cfg.execution_mode ||
    cfg.mode ||
    cfg.agent ||
    cfg.tool ||
    ""
  ).toLowerCase().trim();

  const model = String(cfg.model || cfg.selectedModel || "").toLowerCase();
  const title = (c.title || "").toLowerCase();

  // 1. 明确匹配 Claude Code
  if (
    rawMode.includes("claude") ||
    model.includes("claude") ||
    title.includes("[claude") ||
    title.includes("claude-")
  ) {
    return { id: "claude_code", name: "Claude Code", brandId: "claude_code" };
  }

  // 2. 明确匹配 Google Antigravity
  if (
    rawMode.includes("antigravity") ||
    rawMode.includes("agy") ||
    model.includes("gemini") ||
    title.includes("[antigravity") ||
    title.includes("[agy")
  ) {
    return { id: "antigravity", name: "Google Antigravity", brandId: "antigravity" };
  }

  // 3. 明确匹配 OpenAI Codex / ChatGPT
  if (
    rawMode.includes("codex") ||
    rawMode.includes("openai") ||
    model.includes("gpt") ||
    model.includes("o1") ||
    model.includes("o3") ||
    model.includes("o4") ||
    title.includes("[codex")
  ) {
    return { id: "codex", name: "OpenAI Codex", brandId: "codex" };
  }

  // 4. 明确匹配 Tencent WorkBuddy
  if (
    rawMode.includes("workbuddy") ||
    rawMode.includes("codebuddy") ||
    title.includes("[workbuddy")
  ) {
    return { id: "workbuddy", name: "WorkBuddy", brandId: "workbuddy" };
  }

  // 5. 终端 Shell
  if (rawMode === "shell" || rawMode === "bash" || rawMode === "sh" || title.includes("[shell]")) {
    return { id: "shell", name: "终端 Shell" };
  }

  // 6. 默认回退（系统主力 Agent 为 Claude Code）
  return { id: "claude_code", name: "Claude Code", brandId: "claude_code" };
}

interface HistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  conversations: AskConversationSummary[];
  activeConversationId: string | null;
  selectedDevice: string;
  devices: DeviceSummary[];
  onSelectConversation: (id: string) => void;
  onStartNewChat: () => void;
  onDeleteConversation: (e: React.MouseEvent, id: string) => void;
  onRenameConversation: (id: string, newTitle: string) => void;
  onTogglePinConversation: (e: React.MouseEvent, id: string, pinned?: boolean) => void;
  onOpenSingleShare: (id: string, title?: string) => void;
  onOpenBatchShare: (selectedIds: string[]) => void;
  onPrefetchTurns?: (id: string) => void;
  onFilterDeviceChange?: (filterCurrent: boolean) => void;
  isZh: boolean;
  t: any;
  runningConversationIds?: Set<string>;
}

function HighlightMatch({ text, query }: { text: string; query?: string }) {
  if (!query || !query.trim()) return <span>{text}</span>;
  const q = query.trim();
  const lowerText = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const index = lowerText.indexOf(lowerQ);
  if (index === -1) return <span>{text}</span>;
  const before = text.slice(0, index);
  const match = text.slice(index, index + q.length);
  const after = text.slice(index + q.length);
  return (
    <span>
      {before}
      <mark
        style={{
          background: "rgba(245, 158, 11, 0.35)",
          color: "var(--aurora-fg1)",
          padding: "1px 2px",
          borderRadius: 3,
        }}
      >
        {match}
      </mark>
      <HighlightMatch text={after} query={query} />
    </span>
  );
}

const ConversationItem = memo(function ConversationItem({
  conversation: c,
  isActive,
  isBatchMode,
  isSelected,
  isRunning,
  searchQuery,
  onSelect,
  onToggleBatch,
  onPrefetch,
  onTogglePin,
  onShare,
  onRename,
  onDelete,
  isZh,
  t,
}: {
  conversation: AskConversationSummary;
  isActive: boolean;
  isBatchMode: boolean;
  isSelected: boolean;
  isRunning?: boolean;
  searchQuery?: string;
  onSelect: (id: string) => void;
  onToggleBatch: (id: string) => void;
  onPrefetch?: (id: string) => void;
  onTogglePin: (e: React.MouseEvent, id: string, pinned?: boolean) => void;
  onShare: (id: string, title?: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  isZh: boolean;
  t: any;
}) {
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(c.title || "");
  const agent = useMemo(() => resolveConversationAgent(c), [c]);

  const dateStr = useMemo(() => {
    if (!c.updated_at) return "";
    try {
      return new Date(c.updated_at).toLocaleString(undefined, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }, [c.updated_at]);

  const handleSaveRename = () => {
    if (editTitle.trim()) {
      onRename(c.id, editTitle.trim());
    }
    setEditing(false);
  };

  return (
    <div
      onFocus={() => onPrefetch?.(c.id)}
      onClick={() => {
        triggerHapticFeedback(12);
        if (isBatchMode) {
          onToggleBatch(c.id);
        } else {
          onSelect(c.id);
        }
      }}
      style={{
        padding: "11px 13px",
        borderRadius: 10,
        background: isSelected
          ? "var(--aurora-accent-soft)"
          : isActive
          ? "var(--aurora-chip)"
          : isRunning
          ? "rgba(109, 40, 217, 0.05)"
          : "transparent",
        border: "1px solid",
        borderColor: isSelected
          ? "var(--aurora-accent)"
          : isActive
          ? "var(--aurora-accent)"
          : isRunning
          ? "rgba(109, 40, 217, 0.35)"
          : "transparent",
        cursor: "pointer",
        transition: "all 0.15s ease",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        contentVisibility: "auto",
        containIntrinsicSize: "0 54px",
      }}
      onMouseEnter={(e) => {
        onPrefetch?.(c.id);
        if (!isActive && !isSelected) {
          e.currentTarget.style.background = isRunning
            ? "rgba(109, 40, 217, 0.08)"
            : "var(--aurora-chip)";
          e.currentTarget.style.borderColor = isRunning
            ? "var(--aurora-accent)"
            : "var(--aurora-border)";
        }
      }}
      onMouseLeave={(e) => {
        cancelPrefetchConversationTurns(c.id);
        if (!isActive && !isSelected) {
          e.currentTarget.style.background = isRunning
            ? "rgba(109, 40, 217, 0.05)"
            : "transparent";
          e.currentTarget.style.borderColor = isRunning
            ? "rgba(109, 40, 217, 0.35)"
            : "transparent";
        }
      }}
    >
      {isBatchMode && (
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleBatch(c.id)}
          style={{
            width: 16,
            height: 16,
            accentColor: "var(--aurora-accent)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        />
      )}
      {editing ? (
        <div
          style={{ flex: 1, display: "flex", alignItems: "center", gap: 6 }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="text"
            autoFocus
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleSaveRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
            style={{
              flex: 1,
              padding: "4px 8px",
              borderRadius: 6,
              fontSize: 12.5,
              border: "1px solid var(--aurora-accent)",
              background: "var(--aurora-surface-solid)",
              color: "var(--aurora-fg1)",
              outline: "none",
              minWidth: 0,
            }}
          />
          <button
            type="button"
            onClick={handleSaveRename}
            title="保存"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--aurora-accent)",
              cursor: "pointer",
              padding: 4,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="check" size={14} />
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            title="取消"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--aurora-fg4)",
              cursor: "pointer",
              padding: 4,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ) : (
        <>
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
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {isRunning && (
                <span
                  title={isZh ? "任务正在运行中..." : "Task is running..."}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    width: 14,
                    height: 14,
                    color: "var(--aurora-accent)",
                  }}
                >
                  <span
                    className="animate-spin"
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: "50%",
                      border: "2px solid rgba(109, 40, 217, 0.2)",
                      borderTopColor: "var(--aurora-accent)",
                      display: "inline-block",
                      boxSizing: "border-box",
                    }}
                  />
                </span>
              )}
              {/* Agent 智能体图标徽标 */}
              <span
                title={agent.name}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  background:
                    agent.id === "claude_code"
                      ? "rgba(217, 119, 87, 0.12)"
                      : agent.id === "antigravity"
                      ? "rgba(49, 134, 255, 0.12)"
                      : agent.id === "codex"
                      ? "rgba(16, 163, 127, 0.12)"
                      : agent.id === "workbuddy"
                      ? "rgba(14, 199, 168, 0.12)"
                      : "var(--aurora-chip)",
                  border:
                    agent.id === "claude_code"
                      ? "1px solid rgba(217, 119, 87, 0.25)"
                      : agent.id === "antigravity"
                      ? "1px solid rgba(49, 134, 255, 0.25)"
                      : agent.id === "codex"
                      ? "1px solid rgba(16, 163, 127, 0.25)"
                      : agent.id === "workbuddy"
                      ? "1px solid rgba(14, 199, 168, 0.25)"
                      : "1px solid var(--aurora-border)",
                  flexShrink: 0,
                }}
              >
                {agent.brandId ? (
                  <BrandMark id={agent.brandId} size={12} colored />
                ) : (
                  <Icon name="terminal" size={11} style={{ color: "var(--aurora-fg3)" }} />
                )}
              </span>

              {c.config?.pinned && (
                <span
                  title={isZh ? "已置顶会话" : "Pinned"}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    color: "#f59e0b",
                    flexShrink: 0,
                  }}
                >
                  <Icon name="pin" size={12} />
                </span>
              )}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                <HighlightMatch text={c.title || t.ask.title} query={searchQuery} />
              </span>
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
              {isRunning ? (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4.5,
                    color: "var(--aurora-accent)",
                    fontWeight: 600,
                  }}
                >
                  <span
                    className="animate-spin"
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      border: "1.5px solid rgba(109, 40, 217, 0.2)",
                      borderTopColor: "var(--aurora-accent)",
                      display: "inline-block",
                    }}
                  />
                  <span>{isZh ? "执行中..." : "Running..."}</span>
                </span>
              ) : (
                <span>{dateStr}</span>
              )}
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
          <div style={{ display: "flex", alignItems: "center", gap: 2 }} onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={(e) => {
                triggerHapticFeedback([10, 30, 15]);
                onTogglePin(e, c.id, c.config?.pinned);
              }}
              title={c.config?.pinned ? (isZh ? "取消置顶" : "Unpin") : (isZh ? "置顶会话" : "Pin to top")}
              style={{
                background: "transparent",
                border: "none",
                color: c.config?.pinned ? "#f59e0b" : "var(--aurora-fg4)",
                cursor: "pointer",
                padding: 6,
                borderRadius: 6,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                opacity: c.config?.pinned ? 1 : 0.6,
                transition: "all 0.15s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "#f59e0b";
                e.currentTarget.style.opacity = "1";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = c.config?.pinned ? "#f59e0b" : "var(--aurora-fg4)";
                e.currentTarget.style.opacity = c.config?.pinned ? "1" : "0.6";
              }}
            >
              <Icon name="pin" size={13} />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onShare(c.id, c.title);
              }}
              title={isZh ? "分享此会话" : "Share conversation"}
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
                e.currentTarget.style.color = "var(--aurora-accent)";
                e.currentTarget.style.opacity = "1";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--aurora-fg4)";
                e.currentTarget.style.opacity = "0.6";
              }}
            >
              <Icon name="share" size={13} />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(true);
                setEditTitle(c.title || "");
              }}
              title={isZh ? "重命名会话" : "Rename"}
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
                e.currentTarget.style.color = "var(--aurora-accent)";
                e.currentTarget.style.opacity = "1";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--aurora-fg4)";
                e.currentTarget.style.opacity = "0.6";
              }}
            >
              <Icon name="edit" size={13} />
            </button>
            <button
              type="button"
              onClick={(e) => onDelete(e, c.id)}
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
        </>
      )}
    </div>
  );
});

export const HistoryDrawer = memo(function HistoryDrawer({
  open,
  onClose,
  conversations,
  activeConversationId,
  selectedDevice,
  devices,
  onSelectConversation,
  onStartNewChat,
  onDeleteConversation,
  onRenameConversation,
  onTogglePinConversation,
  onOpenSingleShare,
  onOpenBatchShare,
  onPrefetchTurns,
  onFilterDeviceChange,
  isZh,
  t,
  runningConversationIds,
}: HistoryDrawerProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterDevice, setFilterDevice] = useState(false);
  const [batchSelectMode, setBatchSelectMode] = useState(false);
  const [selectedConvIds, setSelectedConvIds] = useState<Set<string>>(new Set());

  // 实时跟踪处于运行中的会话 ID 集合
  const [liveRunningIds, setLiveRunningIds] = useState<Set<string>>(() => new Set(runningConversationIds || []));

  // 当外部传入的 runningConversationIds 变化时，合并保持最新
  useEffect(() => {
    if (!runningConversationIds) return;
    setLiveRunningIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of runningConversationIds) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [runningConversationIds]);

  // 当抽屉打开时，立即向后端拉取最新的活跃任务列表，并在打开期间保持轻量轮询
  useEffect(() => {
    if (!open) return;

    let mounted = true;
    const fetchActiveRuns = async () => {
      try {
        const runs = await api.listAskRuns(0);
        if (!mounted || !Array.isArray(runs)) return;
        const activeIds = new Set<string>();
        runs.forEach((r) => {
          if (!r.done && !r.cancelled && !r.failed) {
            activeIds.add(r.conversation_id);
          }
        });
        if (runningConversationIds) {
          runningConversationIds.forEach((id) => activeIds.add(id));
        }
        setLiveRunningIds(activeIds);
      } catch {
        // 静默兜底
      }
    };

    void fetchActiveRuns();
    const interval = setInterval(fetchActiveRuns, 2500);

    // 监听实时任务启动、完成和全局广播事件，达成 0ms 零延迟更新
    const handleStart = (e: any) => {
      const convId = e?.detail?.conversation_id;
      if (convId) {
        setLiveRunningIds((prev) => new Set([...prev, convId]));
      }
    };
    const handleDone = (e: any) => {
      const convId = e?.detail?.conversation_id;
      if (convId) {
        setLiveRunningIds((prev) => {
          const next = new Set(prev);
          next.delete(convId);
          return next;
        });
      }
    };
    const handleUpdate = (e: any) => {
      const ids = e?.detail?.conversation_ids;
      if (Array.isArray(ids)) {
        const set = new Set<string>(ids);
        if (runningConversationIds) {
          runningConversationIds.forEach((id) => set.add(id));
        }
        setLiveRunningIds(set);
      }
    };

    window.addEventListener("memento_ask_start", handleStart);
    window.addEventListener("memento_ask_done", handleDone);
    window.addEventListener("memento_active_runs_update", handleUpdate);

    return () => {
      mounted = false;
      clearInterval(interval);
      window.removeEventListener("memento_ask_start", handleStart);
      window.removeEventListener("memento_ask_done", handleDone);
      window.removeEventListener("memento_active_runs_update", handleUpdate);
    };
  }, [open, runningConversationIds]);

  const handleToggleBatch = useCallback((id: string) => {
    setSelectedConvIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const filteredConversations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let list = conversations;

    if (filterDevice && selectedDevice && selectedDevice !== "auto" && selectedDevice !== "ask_only") {
      const targetDev = devices?.find(
        (d) => d.device_id === selectedDevice || d.id === selectedDevice || d.name === selectedDevice
      );
      list = list.filter((c) => {
        if (!c.device_id) return false;
        if (c.device_id === selectedDevice) return true;
        if (targetDev) {
          return (
            c.device_id === targetDev.device_id ||
            c.device_id === targetDev.id ||
            c.device_id === targetDev.name
          );
        }
        return false;
      });
    }

    if (q) {
      list = list.filter((c) => {
        const matchTitle = (c.title || "").toLowerCase().includes(q);
        const matchDev = (c.device_id || "").toLowerCase().includes(q);
        const matchId = c.id.toLowerCase().includes(q);
        return matchTitle || matchDev || matchId;
      });
    }

    return [...list].sort((a, b) => {
      const aPinned = a.config?.pinned ? 1 : 0;
      const bPinned = b.config?.pinned ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      const aRunning = liveRunningIds.has(a.id) ? 1 : 0;
      const bRunning = liveRunningIds.has(b.id) ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      const aTime = a.updated_at ? new Date(a.updated_at).getTime() : 0;
      const bTime = b.updated_at ? new Date(b.updated_at).getTime() : 0;
      return bTime - aTime;
    });
  }, [conversations, searchQuery, liveRunningIds, filterDevice, selectedDevice, devices]);

  // Group conversations chronologically into distinct visual timeline sections
  const conversationGroups = useMemo(() => {
    if (!filteredConversations.length) return [];
    if (searchQuery.trim()) {
      return [
        {
          id: "search",
          title: isZh ? "搜索结果" : "Search Results",
          items: filteredConversations,
        },
      ];
    }

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 86400000;
    const sevenDaysStart = todayStart - 6 * 86400000;
    const thirtyDaysStart = todayStart - 29 * 86400000;

    const runningItems: AskConversationSummary[] = [];
    const pinnedItems: AskConversationSummary[] = [];
    const todayItems: AskConversationSummary[] = [];
    const yesterdayItems: AskConversationSummary[] = [];
    const past7DaysItems: AskConversationSummary[] = [];
    const past30DaysItems: AskConversationSummary[] = [];
    const olderItems: AskConversationSummary[] = [];

    for (const c of filteredConversations) {
      if (liveRunningIds.has(c.id)) {
        runningItems.push(c);
        continue;
      }
      if (c.config?.pinned) {
        pinnedItems.push(c);
        continue;
      }
      const t = c.updated_at ? new Date(c.updated_at).getTime() : 0;
      if (t >= todayStart) {
        todayItems.push(c);
      } else if (t >= yesterdayStart) {
        yesterdayItems.push(c);
      } else if (t >= sevenDaysStart) {
        past7DaysItems.push(c);
      } else if (t >= thirtyDaysStart) {
        past30DaysItems.push(c);
      } else {
        olderItems.push(c);
      }
    }

    const groups: { id: string; title: string; items: AskConversationSummary[] }[] = [];
    if (runningItems.length) groups.push({ id: "running", title: isZh ? "正在执行" : "Running", items: runningItems });
    if (pinnedItems.length) groups.push({ id: "pinned", title: isZh ? "置顶会话" : "Pinned", items: pinnedItems });
    if (todayItems.length) groups.push({ id: "today", title: isZh ? "今天" : "Today", items: todayItems });
    if (yesterdayItems.length) groups.push({ id: "yesterday", title: isZh ? "昨天" : "Yesterday", items: yesterdayItems });
    if (past7DaysItems.length) groups.push({ id: "past7", title: isZh ? "前 7 天" : "Past 7 Days", items: past7DaysItems });
    if (past30DaysItems.length) groups.push({ id: "past30", title: isZh ? "近 30 天" : "Past 30 Days", items: past30DaysItems });
    if (olderItems.length) groups.push({ id: "older", title: isZh ? "更早之前" : "Earlier", items: olderItems });

    return groups;
  }, [filteredConversations, searchQuery, liveRunningIds, isZh]);

  // Keyboard shortcut: Escape to close drawer
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const currentDevName = devices.find((d) => d.device_id === selectedDevice)?.name || selectedDevice.slice(0, 8);

  return (
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
        onClick={onClose}
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
                  {searchQuery ? `${filteredConversations.length}/${conversations.length}` : conversations.length}
                </span>
              )}
              {liveRunningIds.size > 0 && (
                <span
                  title={isZh ? `${liveRunningIds.size} 个任务正在运行中` : `${liveRunningIds.size} running`}
                  style={{
                    fontSize: 11,
                    padding: "2px 8px",
                    borderRadius: 999,
                    background: "var(--aurora-accent-soft)",
                    color: "var(--aurora-accent)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    fontWeight: 500,
                  }}
                >
                  <span
                    className="animate-spin"
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: "50%",
                      border: "1.5px solid rgba(109, 40, 217, 0.25)",
                      borderTopColor: "var(--aurora-accent)",
                      display: "inline-block",
                    }}
                  />
                  <span>{liveRunningIds.size} {isZh ? "运行中" : "running"}</span>
                </span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button
                type="button"
                onClick={() => {
                  const next = !batchSelectMode;
                  setBatchSelectMode(next);
                  if (!next) setSelectedConvIds(new Set());
                }}
                title={batchSelectMode ? (isZh ? "退出多选" : "Exit selection") : (isZh ? "多选分享" : "Batch share")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 4,
                  padding: "0 8px",
                  height: 30,
                  borderRadius: 8,
                  background: batchSelectMode ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                  border: batchSelectMode ? "1px solid var(--aurora-accent)" : "1px solid var(--aurora-border)",
                  color: batchSelectMode ? "var(--aurora-accent)" : "var(--aurora-fg2)",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                <Icon name="share" size={13} />
                <span>{batchSelectMode ? (isZh ? "退出" : "Cancel") : (isZh ? "多选" : "Select")}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  triggerHapticFeedback(15);
                  onClose();
                  onStartNewChat();
                }}
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
                onClick={onClose}
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
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => {
                  setFilterDevice(false);
                  onFilterDeviceChange?.(false);
                }}
                style={{
                  padding: "4px 10px",
                  borderRadius: 14,
                  fontSize: 11.5,
                  fontWeight: !filterDevice ? 600 : 400,
                  cursor: "pointer",
                  border: "1px solid",
                  borderColor: !filterDevice ? "var(--aurora-accent)" : "var(--aurora-border)",
                  background: !filterDevice ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                  color: !filterDevice ? "var(--aurora-accent)" : "var(--aurora-fg3)",
                }}
              >
                🌐 全部设备
              </button>
              <button
                type="button"
                onClick={() => {
                  setFilterDevice(true);
                  onFilterDeviceChange?.(true);
                }}
                style={{
                  padding: "4px 10px",
                  borderRadius: 14,
                  fontSize: 11.5,
                  fontWeight: filterDevice ? 600 : 400,
                  cursor: "pointer",
                  border: "1px solid",
                  borderColor: filterDevice ? "var(--aurora-accent)" : "var(--aurora-border)",
                  background: filterDevice ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                  color: filterDevice ? "var(--aurora-accent)" : "var(--aurora-fg3)",
                }}
              >
                🖥️ 当前设备 ({currentDevName})
              </button>
            </div>
          )}

          {/* 会话过滤搜索框 */}
          <div
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              width: "100%",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 10,
                display: "flex",
                alignItems: "center",
                pointerEvents: "none",
                color: "var(--aurora-fg4)",
              }}
            >
              <Icon name="search" size={13} />
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={isZh ? "搜索会话标题或设备 ID..." : "Search sessions or device..."}
              style={{
                width: "100%",
                padding: "6px 28px 6px 30px",
                borderRadius: 8,
                fontSize: 12.5,
                border: "1px solid var(--aurora-border)",
                background: "var(--aurora-chip)",
                color: "var(--aurora-fg1)",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                style={{
                  position: "absolute",
                  right: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: "transparent",
                  border: "none",
                  color: "var(--aurora-fg4)",
                  cursor: "pointer",
                }}
              >
                <Icon name="close" size={12} />
              </button>
            )}
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
          {conversationGroups.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "48px 20px",
                color: "var(--aurora-fg4)",
                fontSize: 13,
              }}
            >
              {searchQuery ? (isZh ? "未找到匹配的会话" : "No matching sessions found") : t.ask.noHistory}
            </div>
          ) : (
            conversationGroups.map((group) => (
              <div key={group.id} style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 8 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "6px 6px 4px 6px",
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--aurora-fg4)",
                    letterSpacing: "0.02em",
                    userSelect: "none",
                  }}
                >
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      background:
                        group.id === "running"
                          ? "#10b981"
                          : group.id === "pinned"
                          ? "#f59e0b"
                          : "var(--aurora-accent)",
                      opacity: 0.85,
                      flexShrink: 0,
                    }}
                  />
                  <span>{group.title}</span>
                  <span style={{ fontSize: 10.5, opacity: 0.6, fontVariantNumeric: "tabular-nums" }}>
                    ({group.items.length})
                  </span>
                </div>
                {group.items.map((c) => (
                  <ConversationItem
                    key={c.id}
                    conversation={c}
                    isActive={c.id === activeConversationId}
                    isBatchMode={batchSelectMode}
                    isSelected={selectedConvIds.has(c.id)}
                    isRunning={liveRunningIds.has(c.id)}
                    searchQuery={searchQuery}
                    onSelect={(id) => {
                      onClose();
                      onSelectConversation(id);
                    }}
                    onToggleBatch={handleToggleBatch}
                    onPrefetch={onPrefetchTurns}
                    onTogglePin={onTogglePinConversation}
                    onShare={onOpenSingleShare}
                    onRename={onRenameConversation}
                    onDelete={onDeleteConversation}
                    isZh={isZh}
                    t={t}
                  />
                ))}
              </div>
            ))
          )}
          {batchSelectMode && (
            <div
              style={{
                position: "sticky",
                bottom: 0,
                margin: "12px -16px -16px -16px",
                padding: "12px 16px",
                background: "var(--aurora-surface-solid)",
                borderTop: "1px solid var(--aurora-border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                zIndex: 10,
                backdropFilter: "blur(12px)",
              }}
            >
              <div style={{ fontSize: 12, color: "var(--aurora-fg2)", fontWeight: 500 }}>
                {isZh ? "已选择 " : "Selected "}
                <span style={{ color: "var(--aurora-accent)", fontWeight: 700 }}>{selectedConvIds.size}</span>
                {isZh ? " 个对话" : " sessions"}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    if (selectedConvIds.size === filteredConversations.length) {
                      setSelectedConvIds(new Set());
                    } else {
                      setSelectedConvIds(new Set(filteredConversations.map((c) => c.id)));
                    }
                  }}
                  style={{
                    padding: "5px 10px",
                    borderRadius: 8,
                    fontSize: 11.5,
                    background: "var(--aurora-chip)",
                    border: "1px solid var(--aurora-border)",
                    color: "var(--aurora-fg2)",
                    cursor: "pointer",
                  }}
                >
                  {selectedConvIds.size === filteredConversations.length
                    ? (isZh ? "取消全选" : "Deselect")
                    : (isZh ? "全选" : "Select all")}
                </button>
                <Btn
                  variant="primary"
                  size="sm"
                  icon="share"
                  disabled={selectedConvIds.size === 0}
                  onClick={() => onOpenBatchShare(Array.from(selectedConvIds))}
                >
                  {isZh ? "生成多对话分享链接 ↗" : "Batch Share ↗"}
                </Btn>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
