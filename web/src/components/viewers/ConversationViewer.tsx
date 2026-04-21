"use client";

import { memo, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, ConversationMessage } from "@/lib/api-client";
import { useI18n, fmt } from "@/lib/i18n";
import MarkdownViewer from "./MarkdownViewer";
import { Icon } from "@/components/aurora/Icon";

interface Artifact {
  id: string;
  title: string;
  relative_path: string;
  content: string | null;
  file_size_bytes: number;
}

export default function ConversationViewer({
  documentId,
  totalMessages,
  artifacts,
}: {
  documentId: string;
  totalMessages: number;
  artifacts?: Artifact[];
}) {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
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

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="h-[calc(100vh-8rem)] sm:h-[calc(100vh-10rem)] md:h-[calc(100vh-12rem)] overflow-y-auto"
    >
      <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginBottom: 16, textAlign: "center" }}>
        {fmt(t.conversation.messagesTotal, { total: totalMessages, loaded: messages.length })}
      </div>

      <div className="space-y-4 max-w-3xl mx-auto pb-8">
        {messages.map((msg, idx) => (
          <ChatBubble key={`${msg.id}-${idx}`} msg={msg} locale={locale} t={t} />
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
    </div>
  );
}

export const ChatBubble = memo(function ChatBubble({
  msg,
  locale,
  t,
}: {
  msg: ConversationMessage;
  locale: string;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const role = msg.role || msg.message_type || "unknown";
  const toolName = msg.tool_name ?? "";
  const toolInput = msg.tool_input ?? "";
  const thinking = msg.thinking?.trim() || "";
  const [expanded, setExpanded] = useState(false);
  const [showThinking, setShowThinking] = useState(false);

  // User — right aligned, violet gradient
  if (role === "user") {
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

    return (
      <div style={{ display: "flex", justifyContent: "flex-start" }}>
        <div style={{ maxWidth: "78%", minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 5, alignItems: "center", padding: "0 4px" }}>
            <span style={{ fontSize: 10.5, fontWeight: 600, color: "#10B981" }}>Assistant</span>
            {msg.timestamp && (
              <span style={{ fontSize: 10.5, color: "var(--aurora-fg4)" }}>
                {new Date(msg.timestamp).toLocaleString(locale)}
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
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--aurora-fg3)", marginBottom: toolInput || msg.content ? 6 : 0 }}>
            <Icon name="terminal" size={13} style={{ color: "var(--aurora-accent)" }} />
            <span style={{ fontFamily: "ui-monospace,monospace", fontWeight: 600, fontSize: 11.5 }}>{toolName || "Tool"}</span>
          </div>
          {toolInput && (
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 128,
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
              {toolInput}
            </pre>
          )}
          {msg.content && msg.content !== `[${toolName}]` && (
            <pre
              style={{
                marginTop: 4,
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
                color: "var(--aurora-fg3)",
              }}
            >
              {msg.content.length > 500 ? msg.content.slice(0, 500) + "..." : msg.content}
            </pre>
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
