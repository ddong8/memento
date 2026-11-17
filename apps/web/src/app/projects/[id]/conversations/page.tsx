"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { authFetch } from "@/lib/api-client";
import { sessionsUrl } from "@/lib/session-preview";
import { MoreMessages } from "@/components/viewers/MoreMessages";
import { useI18n } from "@/lib/i18n";
import { ChatBubble } from "@/components/viewers/ConversationViewer";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";
import { Icon } from "@/components/aurora/Icon";
import { Btn, TopBar } from "@/components/aurora/primitives";
import { useProgressiveCount } from "@/lib/use-progressive";

interface Message {
  role: string;
  content: string;
  tool_name?: string;
  tool_input?: string;
  timestamp?: string | null;
}

interface Artifact {
  id: string;
  title: string;
  doc_type: string;
  content: string | null;
  file_size_bytes: number;
}

interface Session {
  session_id: string;
  title: string;
  conversation_id: string;
  timestamp: string;
  message_count: number;
  messages: Message[];
  /** Only a preview of the messages came; 「展开全部」 fetches the rest */
  truncated?: boolean;
  artifacts: Artifact[];
}

interface ProjectConversationsResponse {
  project: { id: string; slug: string; title: string; source_path: string };
  total_sessions: number;
  session_offset: number;
  session_limit: number;
  order: string;
  sessions: Session[];
}

export default function ProjectConversationsPage() {
  const params = useParams();
  const projectId = params.id as string;
  const { t, locale } = useI18n();
  const dateFmt = locale === "zh-CN" ? "zh-CN" : "en-US";

  const [data, setData] = useState<ProjectConversationsResponse | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const offsetRef = useRef(0);
  // How many messages are on the page. A session can hold thousands (one here has 5,520): rendering
  // the whole page of five at once built 115k DOM nodes and froze a phone for ~4 s. Nothing is cut:
  // more are rendered as the reader scrolls toward the end.
  const loadedMessages = useMemo(() => sessions.reduce((n, s) => n + s.messages.length, 0), [sessions]);
  const { count: budget, done: allRendered, sentinelRef, reset: resetBudget } = useProgressiveCount(loadedMessages);

  // A preview's 「展开全部」: the whole session replaces it in place
  const onWhole = useCallback((conversationId: string, messages: Message[]) => {
    setSessions((prev) => prev.map((s) => (s.conversation_id === conversationId ? { ...s, messages, truncated: false } : s)));
  }, []);

  const loadMore = async (reset = false) => {
    setLoading(true);
    try {
      const off = reset ? 0 : offsetRef.current;
      const res = await authFetch(sessionsUrl(projectId, off, order)).then((r) => r.json()) as ProjectConversationsResponse;

      if (reset) {
        setData(res);
        setSessions(res.sessions);
        offsetRef.current = res.sessions.length;
      } else {
        if (!data) setData(res);
        setSessions((prev) => [...prev, ...res.sessions]);
        offsetRef.current += res.sessions.length;
      }
      setHasMore((reset ? res.sessions.length : offsetRef.current) < res.total_sessions);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    offsetRef.current = 0;
    setHasMore(true);
    setSessions([]);
    resetBudget();
    loadMore(true);
  }, [projectId, order]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data && loading) {
    return <div style={{ color: "var(--aurora-fg4)", textAlign: "center", marginTop: 80 }}>{t.loading}</div>;
  }

  return (
    <div className="max-w-3xl mx-auto pb-12">
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--aurora-fg4)", marginBottom: 8 }}>
        <Link href="/projects" style={{ color: "var(--aurora-fg4)" }}>{t.projects}</Link>
        <Icon name="chevron_right" size={12} />
        {data?.project && (
          <Link href={`/projects/${data.project.id}`} style={{ color: "var(--aurora-fg4)" }}>
            {data.project.title}
          </Link>
        )}
        <Icon name="chevron_right" size={12} />
        <span style={{ color: "var(--aurora-fg3)" }}>{t.conversations}</span>
      </div>
      <TopBar
        title={`${data?.project?.title || ""} · ${t.conversations}`}
        subtitle={`${data?.project?.source_path || ""} · ${locale === "zh-CN" ? `${data?.total_sessions || 0} 个会话` : `${data?.total_sessions || 0} sessions`}`}
        right={
          <Btn variant="glass" size="sm" icon={order === "asc" ? "arrow_up" : "arrow_down"}
               onClick={() => setOrder(order === "asc" ? "desc" : "asc")}>
            {order === "asc" ? t.timeline.oldToNew : t.timeline.newToOld}
          </Btn>
        }
      />

      {/* Continuous conversation flow */}
      <div className="space-y-0">
        {(() => {
          let left = budget;
          return sessions.map((session, sIdx) => {
            if (left <= 0 && sIdx > 0) return null;
            const limit = Math.min(session.messages.length, Math.max(left, 0));
            left -= session.messages.length;
            return (
              <SessionBlock
                key={session.session_id || sIdx} session={session} limit={limit} dateFmt={dateFmt} locale={locale} t={t}
                projectId={projectId} order={order}
                onWhole={onWhole}
              />
            );
          });
        })()}
      </div>

      {!allRendered && (
        <div ref={sentinelRef} style={{ textAlign: "center", color: "var(--aurora-fg4)", fontSize: 12, padding: "20px 0" }}>
          {t.loading}
        </div>
      )}

      {allRendered && hasMore && (
        <div style={{ textAlign: "center", marginTop: 24 }}>
          <Btn variant="glass" size="sm" onClick={() => loadMore()} disabled={loading}>
            {loading ? t.loading : t.timeline.loadMore}
          </Btn>
        </div>
      )}
      {allRendered && !hasMore && sessions.length > 0 && (
        <div style={{ textAlign: "center", color: "var(--aurora-fg4)", fontSize: 12, marginTop: 20 }}>{t.timeline.allLoaded}</div>
      )}
    </div>
  );
}

const SessionBlock = memo(function SessionBlock({
  session, limit, dateFmt, locale, t, projectId, order, onWhole,
}: {
  session: Session;
  projectId: string;
  order: "asc" | "desc";
  onWhole: (conversationId: string, messages: Message[]) => void;
  /** Messages rendered so far; the page raises it as the reader scrolls */
  limit: number;
  dateFmt: string;
  locale: string;
  t: ReturnType<typeof useI18n>["t"];
}) {
  // Each reply's "took N s" needs the question before it: one pass, not a walk back per message
  const prevUserTs = useMemo(() => {
    const out: (string | null)[] = [];
    let last: string | null = null;
    for (const m of session.messages) {
      out.push(last);
      if (m.role === "user" && !m.content?.startsWith("[Result]")) last = m.timestamp || null;
    }
    return out;
  }, [session.messages]);
  const shown = limit >= session.messages.length ? session.messages : session.messages.slice(0, limit);
  const hidden = session.truncated ? Math.max(session.message_count - session.messages.length, 0) : 0;
  const more = hidden > 0 && (
    <MoreMessages<Message>
      projectId={projectId} conversationId={session.conversation_id} hidden={hidden}
      order={order} locale={locale} onLoaded={(m) => onWhole(session.conversation_id, m)}
    />
  );
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "24px 0" }}>
        <div style={{ flex: 1, borderTop: "1px solid var(--aurora-border)" }} />
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 12px",
            borderRadius: 9999,
            background: "var(--aurora-chip)",
            color: "var(--aurora-fg3)",
            fontSize: 11,
            flexShrink: 1,
            minWidth: 0,
            maxWidth: "100%",
          }}
        >
          <span style={{ fontWeight: 600, color: "var(--aurora-fg2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{session.title}</span>
          <span>·</span>
          <span>{new Date(session.timestamp).toLocaleString(dateFmt)}</span>
          <span>·</span>
          <span>{session.message_count} 条消息</span>
        </div>
        <div style={{ flex: 1, borderTop: "1px solid var(--aurora-border)" }} />
      </div>

      {/* Messages */}
      <div className="space-y-3">
        {order === "desc" && more}
        {shown.map((msg, idx) => {
          return (
            <ChatBubble
              key={idx}
              msg={{
                id: idx,
                line_number: idx,
                role: msg.role,
                content: msg.content,
                tool_name: msg.tool_name,
                tool_input: msg.tool_input,
                timestamp: msg.timestamp || null,
              }}
              prevUserTimestamp={prevUserTs[idx]}
              locale={locale}
              t={t}
            />
          );
        })}

        {order === "asc" && shown.length === session.messages.length && more}

        {/* Artifacts inline, once the session is fully on the page */}
        {shown.length === session.messages.length && session.artifacts.length > 0 && (
          <div className="space-y-2 my-4">
            {session.artifacts.map((art) => (
              <InlineArtifact key={art.id} artifact={art} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

function InlineArtifact({ artifact }: { artifact: Artifact }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ display: "flex", justifyContent: "center" }}>
      <div style={{ maxWidth: "85%", width: "100%" }}>
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
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--aurora-fg1)" }}>{artifact.title}</span>
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
        </div>
      </div>
    </div>
  );
}
