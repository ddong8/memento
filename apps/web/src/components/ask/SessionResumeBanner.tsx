"use client";

import type { AskConversationSummary, SessionResumeCost } from "@/lib/api-client";
import { Icon } from "@/components/aurora/Icon";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";
import { useI18n } from "@/lib/i18n";
import { formatContextTokens, isJunkSessionTitle, resumeCostNotes, type AgentSessionItem } from "@/lib/ask/sessions";
import type { ExecutionMode, Turn } from "@/lib/ask/turns";

/**
 * Above the input when a conversation continues an agent session: which session, how big its context is
 * and what resuming it costs, the compact / raw switch, and a preview of its last messages.
 */
export function SessionResumeBanner({
  sessionId,
  sessions,
  activeConversation,
  conversations,
  displayConvTitle,
  turns,
  totalTurns,
  knownCost,
  compactMode,
  onToggleCompact,
  showContext,
  onToggleContext,
  onExit,
  executionMode,
}: {
  sessionId: string;
  sessions: AgentSessionItem[];
  activeConversation: AskConversationSummary | undefined;
  conversations: AskConversationSummary[];
  displayConvTitle: string;
  turns: Turn[];
  totalTurns: number;
  /** The session's size as last read for the banner; else what the session list says */
  knownCost: SessionResumeCost | undefined;
  compactMode: boolean;
  onToggleCompact: () => void;
  showContext: boolean;
  onToggleContext: () => void;
  onExit: () => void;
  executionMode: ExecutionMode;
}) {
  const { locale } = useI18n();
  const isZh = locale.startsWith("zh");
  const activeSession = sessions.find((s) => (s.session_id || s.conversation_id) === sessionId);
  const isCurrentActive = Boolean(
    activeConversation &&
    (activeConversation.config?.session_id === sessionId ||
     activeConversation.id === sessionId)
  );
  const matchedConv = isCurrentActive
    ? activeConversation
    : conversations.find((c) => c.config?.session_id === sessionId || c.id === sessionId);
  
  const convTitle = isCurrentActive ? displayConvTitle : matchedConv?.title;
  const sessionTitle = (!isJunkSessionTitle(convTitle) ? convTitle : undefined)
    || (!isJunkSessionTitle(activeSession?.title) ? activeSession?.title : undefined)
    || convTitle
    || activeSession?.title
    || sessionId;
  
  let msgs: Array<{ role: string; content: string; timestamp?: string; subagent_name?: string }> = activeSession?.messages || [];
  if (msgs.length === 0 && isCurrentActive && turns.length > 0) {
    msgs = turns.map((t) => ({
      role: t.role,
      content: t.content,
    }));
  }
  const previewMsgs = msgs.slice(-5);
  const totalCount = activeSession?.message_count || (isCurrentActive ? (totalTurns || turns.length) : msgs.length);
  const cost = knownCost || activeSession?.resume || null;
  const isHeavy = cost ? cost.heavy : (activeSession?.compact_recommended || totalCount > 35 || ((activeSession?.file_size_bytes || 0) > 300_000));
  const sizeText = cost ? formatContextTokens(cost.context_tokens, isZh) : "";
  const costNotes = resumeCostNotes(cost, compactMode, isZh);

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
          borderRadius: showContext || costNotes.length > 0 ? "10px 10px 0 0" : 10,
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
            {sessionTitle}
          </span>
          <span style={{ fontSize: 11, color: "var(--aurora-fg3)", flexShrink: 0 }}>
            ({sizeText ? `${isZh ? "上下文" : "context "}${sizeText} · ` : ""}{isZh ? `共 ${totalCount} 条消息` : `${totalCount} msgs`})
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
            onClick={onToggleCompact}
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
            onClick={onToggleContext}
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
            title={showContext ? (isZh ? "收起历史上下文" : "Collapse context") : (isZh ? "展开历史上下文" : "Expand context")}
          >
            <Icon name={showContext ? "chevron_up" : "chevron_down"} size={12} />
            <span>{showContext ? (isZh ? "收起上下文" : "Hide Context") : (isZh ? "预览上下文" : "Preview Context")}</span>
          </button>
          <button
            type="button"
            onClick={onExit}
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
  
      {/* What continuing this session costs: its real context, and whether the cache is gone */}
      {costNotes.length > 0 && (
        <div
          style={{
            padding: "6px 12px",
            background: compactMode ? "rgba(16, 185, 129, 0.05)" : "rgba(245, 158, 11, 0.08)",
            borderLeft: `1px solid ${compactMode ? "rgba(16, 185, 129, 0.5)" : "var(--aurora-accent)"}`,
            borderRight: `1px solid ${compactMode ? "rgba(16, 185, 129, 0.5)" : "var(--aurora-accent)"}`,
            borderBottom: showContext ? "none" : `1px solid ${compactMode ? "rgba(16, 185, 129, 0.5)" : "var(--aurora-accent)"}`,
            borderRadius: showContext ? 0 : "0 0 10px 10px",
            fontSize: 11.5,
            lineHeight: 1.6,
            color: "var(--aurora-fg2)",
          }}
        >
          {costNotes.map((note) => (
            <div key={note}>{note}</div>
          ))}
        </div>
      )}
  
      {/* Context Preview Drawer */}
      {showContext && (
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
            {(activeSession?.conversation_id || (isCurrentActive && activeConversation?.id)) && (
              <a
                href={activeSession?.conversation_id ? `/conversations/${activeSession.conversation_id}` : `/ask?id=${activeConversation!.id}`}
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
                {isZh ? "当前会话暂无历史交互记录" : "No textual messages recorded in this session"}
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
                              : `🤖 ${executionMode === "claude" ? "Claude Code" : executionMode === "codex" ? "OpenAI Codex" : executionMode === "antigravity" ? "Google Antigravity" : executionMode === "workbuddy" ? "WorkBuddy" : "Assistant"}`)}
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
                        wordBreak: "break-word",
                        lineHeight: 1.45,
                        maxHeight: 120,
                        overflowY: "auto",
                        fontSize: 12,
                      }}
                    >
                      <MarkdownViewer content={m.content?.trim() || ""} compactText={true} />
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
}
