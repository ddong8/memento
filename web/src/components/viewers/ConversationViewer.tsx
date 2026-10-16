"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { api, ConversationMessage } from "@/lib/api-client";
import { useI18n, fmt } from "@/lib/i18n";
import MarkdownViewer from "./MarkdownViewer";
import { Icon } from "@/components/aurora/Icon";
import { MediaInspectorProvider, useMediaInspector } from "./MediaInspectorContext";

const MediaInspectorPanel = dynamic(
  () => import("./MediaInspectorPanel").then((m) => m.MediaInspectorPanel),
  { ssr: false }
);

interface Artifact {
  id: string;
  title: string;
  relative_path: string;
  content: string | null;
  file_size_bytes: number;
}

function ConversationViewerContent({
  documentId,
  totalMessages,
  artifacts,
}: {
  documentId: string;
  totalMessages: number;
  artifacts?: Artifact[];
}) {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const inspector = useMediaInspector();
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  const loadingRef = useRef(false);
  const { t, locale } = useI18n();

  const loadMore = async () => {
    if (loadingRef.current || !hasMore) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const res = await api.getMessages(documentId, offsetRef.current, 50);
      if (res.messages.length > 0) {
        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.id));
          const newMsgs = res.messages.filter((m) => !existingIds.has(m.id));
          return [...prev, ...newMsgs];
        });
        offsetRef.current += res.messages.length;
      }
      setHasMore(offsetRef.current < res.total);
    } catch (e) {
      console.error("Failed to load messages:", e);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  };

  useEffect(() => {
    setMessages([]);
    offsetRef.current = 0;
    loadingRef.current = false;
    setHasMore(true);
    loadMore();
  }, [documentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 300) {
      loadMore();
    }
  };

  const syncTurnsMedia = inspector?.syncTurnsMedia;
  useEffect(() => {
    if (syncTurnsMedia && messages.length > 0) {
      syncTurnsMedia(messages.map((m) => ({ content: m.content || "", role: m.role })));
    }
  }, [messages, syncTurnsMedia]);

  // Precompute previous user message timestamps in a single O(N) linear pass
  // to eliminate O(N^2) backward scans during message list rendering.
  const prevUserTimestamps = useMemo(() => {
    const arr: (string | null)[] = new Array(messages.length).fill(null);
    let lastUserTs: string | null = null;
    for (let i = 0; i < messages.length; i++) {
      arr[i] = lastUserTs;
      const r = messages[i].role || messages[i].message_type;
      if (r === "user" && !messages[i].content?.startsWith("[Result]")) {
        lastUserTs = messages[i].timestamp || null;
      }
    }
    return arr;
  }, [messages]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="h-[calc(100vh-8rem)] sm:h-[calc(100vh-10rem)] md:h-[calc(100vh-12rem)] overflow-y-auto transition-all duration-300"
      style={{
        marginRight: inspector?.isOpen ? "clamp(380px, 32vw, 540px)" : undefined,
      }}
    >
      <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginBottom: 16, textAlign: "center" }}>
        {fmt(t.conversation.messagesTotal, { total: totalMessages, loaded: messages.length })}
      </div>

      <div className="space-y-4 max-w-3xl mx-auto pb-8">
        {messages.map((msg, idx) => (
          <div
            key={`${msg.id}-${idx}`}
            style={{
              contentVisibility: "auto",
              containIntrinsicSize: msg.role === "user" ? "0 80px" : "0 160px",
            }}
          >
            <ChatBubble
              msg={msg}
              prevUserTimestamp={prevUserTimestamps[idx]}
              locale={locale}
              t={t}
            />
          </div>
        ))}

        {artifacts && artifacts.length > 0 && !hasMore && (
          <>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 12px",
                  borderRadius: 9999,
                  border: "1px solid var(--aurora-border)",
                  background: "rgba(251,191,36,0.12)",
                  color: "#A16207",
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                <Icon name="file_text" size={12} /> Brain Artifacts ({artifacts.length})
              </div>
            </div>
            {artifacts.map((art) => (
              <ArtifactBubble key={art.id} artifact={art} />
            ))}
          </>
        )}
      </div>

      {loading && (
        <div style={{ textAlign: "center", padding: 12, color: "var(--aurora-fg4)", fontSize: 13 }}>{t.conversation.loadingMore}</div>
      )}
      {!hasMore && messages.length > 0 && (
        <div style={{ textAlign: "center", padding: 12, color: "var(--aurora-fg4)", fontSize: 13 }}>{t.conversation.allLoaded}</div>
      )}

      {/* 右侧媒体独立视窗 */}
      <MediaInspectorPanel />
    </div>
  );
}

export default function ConversationViewer(props: {
  documentId: string;
  totalMessages: number;
  artifacts?: Artifact[];
}) {
  return (
    <MediaInspectorProvider>
      <ConversationViewerContent {...props} />
    </MediaInspectorProvider>
  );
}

export const ChatBubble = memo(function ChatBubble({
  msg,
  prevUserTimestamp,
  locale,
  t,
}: {
  msg: ConversationMessage;
  prevUserTimestamp?: string | null;
  locale: string;
  t: ReturnType<typeof useI18n>["t"];
}) {
  let role = msg.role || msg.message_type || "unknown";
  let toolName = msg.tool_name ?? "";
  let toolInput = msg.tool_input ?? "";
  let content = msg.content || "";
  const thinking = msg.thinking?.trim() || "";
  const [expanded, setExpanded] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = (text: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  // Legacy fallback: convert old [Result] / [Tool: ...] messages into tool roles
  if (role === "user" && content.startsWith("[Result]")) {
    role = "tool";
    content = content.replace(/^\[Result\]\s*/, "");
  } else if (role === "assistant" && content.startsWith("[Tool:")) {
    role = "tool";
    const match = content.match(/^\[Tool:\s*([^\]]+)\]\s*([\s\S]*)$/);
    if (match) {
      toolName = toolName || match[1].trim();
      toolInput = toolInput || match[2].trim();
      content = "";
    }
  }

  // Format toolInput: if it's JSON containing "command" (e.g. Bash), extract command cleanly
  let displayInput = toolInput;
  if (toolInput) {
    try {
      const parsed = JSON.parse(toolInput);
      if (typeof parsed === "object" && parsed !== null) {
        if (parsed.command) {
          displayInput = parsed.command;
        } else {
          displayInput = JSON.stringify(parsed, null, 2);
        }
      }
    } catch {}
  }

  // User — right aligned, violet gradient.
  // OpenClaw subagent sessions inject a synthetic "user" message at the top
  // that starts with `[Subagent Context]` — it's the parent agent's task
  // dispatch, not a human chat. Render these as a gray "子任务派发" card
  // (centered, muted) so users don't mistake them for their own chat input.
  if (role === "user") {
    const isSubagentDispatch = msg.content.startsWith("[Subagent Context]")
      || msg.content.includes("\n[Subagent Context]");
    if (isSubagentDispatch) {
      const isLong = msg.content.length > 300;
      const displayContent = isLong && !expanded ? msg.content.slice(0, 300) + "..." : msg.content;
      return (
        <div style={{ display: "flex", justifyContent: "center", margin: "6px 0" }}>
          <div
            style={{
              maxWidth: "92%",
              minWidth: 0,
              padding: "10px 14px",
              borderRadius: 12,
              background: "var(--aurora-chip)",
              border: "1px dashed var(--aurora-border)",
              fontSize: 12,
              lineHeight: 1.5,
              color: "var(--aurora-fg3)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              overflowWrap: "anywhere",
            }}
          >
            <div style={{
              fontSize: 10,
              fontWeight: 600,
              color: "var(--aurora-fg4)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: 6,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}>
              <span>{t.conversation.subagentDispatch}</span>
              {msg.timestamp && (
                <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: "var(--aurora-fg4)" }}>
                  · {new Date(msg.timestamp).toLocaleString(locale)}
                </span>
              )}
            </div>
            {displayContent}
            {isLong && (
              <button
                onClick={() => setExpanded(!expanded)}
                style={{
                  display: "block",
                  marginTop: 6,
                  fontSize: 11,
                  color: "var(--aurora-accent)",
                  background: "transparent",
                  border: 0,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                {expanded ? t.conversation.collapse : t.conversation.expandAll}
              </button>
            )}
          </div>
        </div>
      );
    }

    const isLong = msg.content.length > 500;
    const displayContent = isLong && !expanded ? msg.content.slice(0, 500) + "..." : msg.content;
    return (
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <div style={{ maxWidth: "78%", minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 5, alignItems: "center", padding: "0 4px" }}>
            {msg.timestamp && (
              <span style={{ fontSize: 10.5, color: "var(--aurora-fg4)" }}>
                {new Date(msg.timestamp).toLocaleString(locale)}
              </span>
            )}
            <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--aurora-accent)" }}>User</span>
          </div>
          <div
            style={{
              padding: "12px 16px",
              borderRadius: "20px 20px 6px 20px",
              background: "var(--aurora-accent)",
              color: "#fff",
              fontSize: 13.5,
              lineHeight: 1.55,
              letterSpacing: "-0.005em",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              overflowWrap: "anywhere",
              boxShadow: "0 6px 18px -6px color-mix(in srgb, var(--aurora-accent) 50%, transparent)",
            }}
          >
            {displayContent}
            {isLong && (
              <button
                onClick={() => setExpanded(!expanded)}
                style={{
                  display: "block",
                  marginTop: 6,
                  fontSize: 11,
                  color: "rgba(255,255,255,0.85)",
                  background: "transparent",
                  border: 0,
                  cursor: "pointer",
                }}
              >
                {expanded ? t.conversation.collapse : t.conversation.expandAll}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Assistant — left aligned, glass white
  if (role === "assistant") {
    const isLong = msg.content.length > 500;
    const displayContent = isLong && !expanded ? msg.content.slice(0, 500) + "..." : msg.content;
    const hasSeparateThinking = Boolean(thinking && thinking !== msg.content.trim());
    let durText: string | null = null;
    if (prevUserTimestamp && msg.timestamp) {
      const diffMs = new Date(msg.timestamp).getTime() - new Date(prevUserTimestamp).getTime();
      if (Number.isFinite(diffMs) && diffMs > 0) {
        const sec = diffMs / 1000;
        if (sec < 60) {
          durText = `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`;
        } else {
          const m = Math.floor(sec / 60);
          const s = Math.round(sec % 60);
          durText = s > 0 ? `${m}m ${s}s` : `${m}m`;
        }
      }
    }

    return (
      <div style={{ display: "flex", justifyContent: "flex-start" }}>
        <div style={{ maxWidth: "78%", minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 5, alignItems: "center", padding: "0 4px" }}>
            <span style={{ fontSize: 10.5, fontWeight: 600, color: "#10B981" }}>Assistant</span>
            {msg.timestamp && (
              <span style={{ fontSize: 10.5, color: "var(--aurora-fg4)", fontVariantNumeric: "tabular-nums" }}>
                {new Date(msg.timestamp).toLocaleString(locale)}
              </span>
            )}
            {durText && (
              <span
                style={{
                  fontSize: 10,
                  color: "var(--aurora-fg4)",
                  padding: "0px 5px",
                  borderRadius: 4,
                  background: "var(--aurora-chip)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {locale.startsWith("zh") ? `耗时 ${durText}` : `${durText}`}
              </span>
            )}
          </div>
          <div
            style={{
              padding: "12px 16px",
              borderRadius: "20px 20px 20px 6px",
              background: "var(--aurora-surface-solid)",
              color: "var(--aurora-fg1)",
              fontSize: 13.5,
              lineHeight: 1.55,
              letterSpacing: "-0.005em",
              border: "1px solid var(--aurora-border)",
              boxShadow: "0 1px 0 rgba(255,255,255,0.5) inset",
            }}
          >
            <div className="prose prose-sm max-w-none">
              <MarkdownViewer content={displayContent} />
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 8 }}>
              {isLong && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  style={{ fontSize: 11, color: "var(--aurora-accent)", background: "transparent", border: 0, cursor: "pointer", textDecoration: "underline" }}
                >
                  {expanded ? t.conversation.collapse : t.conversation.expandAll}
                </button>
              )}
              {hasSeparateThinking && (
                <button
                  onClick={() => setShowThinking((v) => !v)}
                  style={{ fontSize: 11, color: "#D97706", background: "transparent", border: 0, cursor: "pointer", textDecoration: "underline" }}
                >
                  {showThinking ? t.conversation.hideThinking : t.conversation.showThinking}
                </button>
              )}
            </div>
            {showThinking && hasSeparateThinking && (
              <div
                style={{
                  marginTop: 12,
                  borderRadius: 12,
                  border: "1px solid var(--aurora-border)",
                  background: "rgba(251,191,36,0.08)",
                  padding: "10px 12px",
                }}
              >
                <div style={{ marginBottom: 6, fontSize: 10.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "#D97706" }}>
                  {t.conversation.thinking}
                </div>
                <div className="prose prose-sm max-w-none" style={{ color: "#78350F" }}>
                  <MarkdownViewer content={thinking} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Tool use — centered
  if (role === "tool") {
    return (
      <div style={{ display: "flex", justifyContent: "center" }}>
        <div
          style={{
            background: "var(--aurora-chip)",
            border: "1px solid var(--aurora-border)",
            borderRadius: 14,
            padding: "8px 14px",
            fontSize: 12,
            color: "var(--aurora-fg2)",
            maxWidth: "90%",
          }}
        >
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--aurora-fg3)", marginBottom: displayInput || content ? 6 : 0, flexWrap: "wrap" }}>
            <Icon name="terminal" size={13} style={{ color: "var(--aurora-accent)" }} />
            <span style={{ fontFamily: "ui-monospace,monospace", fontWeight: 600, fontSize: 11.5 }}>{toolName || "Tool"}</span>
            {msg.status && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: "1px 6px",
                  borderRadius: 999,
                  background:
                    msg.status === "failed" || (typeof msg.exit_code === "number" && msg.exit_code !== 0)
                      ? "rgba(239, 68, 68, 0.12)"
                      : msg.status === "running"
                      ? "rgba(59, 130, 246, 0.12)"
                      : "rgba(16, 185, 129, 0.12)",
                  color:
                    msg.status === "failed" || (typeof msg.exit_code === "number" && msg.exit_code !== 0)
                      ? "#EF4444"
                      : msg.status === "running"
                      ? "#3B82F6"
                      : "#10B981",
                  border: `1px solid ${
                    msg.status === "failed" || (typeof msg.exit_code === "number" && msg.exit_code !== 0)
                      ? "rgba(239, 68, 68, 0.25)"
                      : msg.status === "running"
                      ? "rgba(59, 130, 246, 0.25)"
                      : "rgba(16, 185, 129, 0.25)"
                  }`,
                }}
              >
                {msg.status === "failed" || (typeof msg.exit_code === "number" && msg.exit_code !== 0)
                  ? (msg.exit_code !== undefined && msg.exit_code !== null ? `exit ${msg.exit_code}` : "failed")
                  : msg.status === "running"
                  ? "running"
                  : (msg.exit_code === 0 ? "exit 0" : "succeeded")}
              </span>
            )}
            {msg.timestamp && (
              <span style={{ fontSize: 10, color: "var(--aurora-fg4)", fontVariantNumeric: "tabular-nums" }}>
                {new Date(msg.timestamp).toLocaleString(locale)}
              </span>
            )}
            <button
              type="button"
              onClick={(e) => handleCopy(content || displayInput || "", e)}
              title={copied ? (locale.startsWith("zh") ? "已复制" : "Copied") : (locale.startsWith("zh") ? "复制内容" : "Copy content")}
              style={{
                marginLeft: "auto",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: "2px 6px",
                borderRadius: 4,
                color: copied ? "#10B981" : "var(--aurora-fg4)",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 10.5,
                transition: "all 0.15s ease",
              }}
            >
              <Icon name={copied ? "check" : "copy"} size={11} />
              <span>{copied ? (locale.startsWith("zh") ? "已复制" : "Copied") : ""}</span>
            </button>
          </div>
          {msg.error && (
            <div
              style={{
                marginTop: 4,
                marginBottom: 6,
                padding: "4px 8px",
                borderRadius: 6,
                background: "rgba(239, 68, 68, 0.08)",
                border: "1px solid rgba(239, 68, 68, 0.2)",
                fontSize: 11,
                color: "#EF4444",
                fontFamily: "ui-monospace,monospace",
              }}
            >
              ⚠️ {msg.error}
            </div>
          )}
          {displayInput && (
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 180,
                overflow: "hidden",
                background: "var(--aurora-surface-solid)",
                border: "1px solid var(--aurora-border)",
                borderRadius: 8,
                padding: 8,
                fontFamily: "ui-monospace,monospace",
                fontSize: 11,
                color: "var(--aurora-fg2)",
              }}
            >
              {displayInput}
            </pre>
          )}
          {content && content !== `[${toolName}]` && (
            <div>
              <pre
                style={{
                  marginTop: 4,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: expanded ? "none" : 240,
                  overflow: "hidden",
                  background: "var(--aurora-surface-solid)",
                  border: "1px solid var(--aurora-border)",
                  borderRadius: 8,
                  padding: 8,
                  fontFamily: "ui-monospace,monospace",
                  fontSize: 11,
                  color: "var(--aurora-fg3)",
                }}
              >
                {content.length > 800 && !expanded ? content.slice(0, 800) + "..." : content}
              </pre>
              {content.length > 800 && (
                <button
                  type="button"
                  onClick={() => setExpanded(!expanded)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    marginTop: 4,
                    fontSize: 11,
                    color: "var(--aurora-accent)",
                    background: "transparent",
                    border: 0,
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  <Icon name={expanded ? "chevron_up" : "chevron_down"} size={12} />
                  <span>{expanded ? t.conversation.collapse : t.conversation.expandAll}</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // System — centered amber
  return (
    <div style={{ display: "flex", justifyContent: "center" }}>
      <div
        style={{
          background: "rgba(251,191,36,0.08)",
          border: "1px solid var(--aurora-border)",
          borderRadius: 12,
          padding: "6px 12px",
          fontSize: 12,
          color: "#A16207",
          maxWidth: "80%",
        }}
      >
        <span style={{ fontWeight: 600 }}>System: </span>
        {msg.content.length > 200 ? msg.content.slice(0, 200) + "..." : msg.content}
      </div>
    </div>
  );
});

function ArtifactBubble({ artifact }: { artifact: Artifact }) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", justifyContent: "center" }}>
      <div style={{ maxWidth: "90%", width: "100%" }}>
        <div
          style={{
            border: "1px solid var(--aurora-border)",
            borderRadius: 14,
            overflow: "hidden",
            background: "var(--aurora-accent-soft)",
          }}
        >
          <button
            onClick={() => setExpanded(!expanded)}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              textAlign: "left",
              background: "transparent",
              border: 0,
              cursor: "pointer",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 28, height: 28, borderRadius: 8,
                  background: "var(--aurora-accent)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                <Icon name="file_text" size={13} style={{ color: "#fff" }} />
              </div>
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--aurora-fg1)", letterSpacing: "-0.01em" }}>
                {artifact.title}
              </span>
              <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>
                {(artifact.file_size_bytes / 1024).toFixed(1)}KB
              </span>
            </div>
            <Icon
              name="chevron_down"
              size={14}
              style={{
                color: "var(--aurora-fg4)",
                transform: expanded ? "rotate(180deg)" : "none",
                transition: "transform .15s",
              }}
            />
          </button>
          {expanded && artifact.content && (
            <div
              style={{
                padding: "12px 16px",
                borderTop: "1px solid var(--aurora-border)",
                maxHeight: 400,
                overflowY: "auto",
                background: "var(--aurora-surface-solid)",
              }}
            >
              <MarkdownViewer content={artifact.content} />
            </div>
          )}
          {expanded && !artifact.content && (
            <div
              style={{
                padding: "12px 16px",
                borderTop: "1px solid var(--aurora-border)",
                background: "var(--aurora-surface-solid)",
              }}
            >
              <Link
                href={`/documents/${artifact.id}`}
                style={{ fontSize: 13, color: "var(--aurora-accent)", fontWeight: 500, textDecoration: "none" }}
              >
                {t.common.viewFullDocument}
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
