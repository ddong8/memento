"use client";

import { memo, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getApiBase, authFetch, ConversationMessage } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { ChatBubble } from "@/components/viewers/ConversationViewer";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";
import { Icon } from "@/components/aurora/Icon";
import { Btn, TopBar } from "@/components/aurora/primitives";

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
  messages: (ConversationMessage & { subagent_name?: string })[];
  artifacts: Artifact[];
}

interface ProjectConversationsResponse {
  project: { id: string; slug: string; title: string; source_path: string };
  total_sessions: number;
  sessions: Session[];
}

export default function ProjectTimelinePage() {
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

  const loadMore = async (reset = false) => {
    setLoading(true);
    try {
      const off = reset ? 0 : offsetRef.current;
      // /timeline 是略览页，每 session 只要最后 40 条消息就够看——完整对话走
      // /conversations/<doc_id>。backend 把 message_count 单独返回，所以卡片
      // 仍能显示真实总条数 + "truncated" 旗标提醒"本 session 还有更多"。
      const res: ProjectConversationsResponse = await authFetch(
        `${getApiBase()}/api/projects/${projectId}/conversations?session_offset=${off}&session_limit=5&max_messages_per_session=40&order=${order}`
      ).then((r) => r.json());

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
    loadMore(true);
  }, [projectId, order]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data && loading) {
    return <div style={{ color: "var(--aurora-fg4)", textAlign: "center", marginTop: 80 }}>{t.loading}</div>;
  }

  return (
    <div className="max-w-4xl mx-auto pb-12 overflow-x-hidden">
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--aurora-fg4)", marginBottom: 8 }}>
        <Link href="/projects" style={{ color: "var(--aurora-fg4)" }}>{t.projects}</Link>
        <Icon name="chevron_right" size={12} />
        {data?.project && (
          <Link href={`/projects/${data.project.id}`} style={{ color: "var(--aurora-fg4)" }}>
            {data.project.title}
          </Link>
        )}
      </div>
      <TopBar
        title={data?.project?.title || ""}
        subtitle={`${data?.project?.source_path || ""} · ${data?.total_sessions || 0}`}
        right={
          <Btn variant="glass" size="sm" icon={order === "asc" ? "arrow_up" : "arrow_down"}
               onClick={() => setOrder(order === "asc" ? "desc" : "asc")}>
            {order === "asc" ? t.timeline?.oldToNew || "Oldest first" : t.timeline?.newToOld || "Newest first"}
          </Btn>
        }
      />

      {/* Continuous message flow */}
      <div className="space-y-3">
        {sessions.map((session, sIdx) => (
          <SessionMessages key={session.session_id || sIdx} session={session} dateFmt={dateFmt} locale={locale} t={t} />
        ))}
      </div>

      {hasMore && (
        <div style={{ textAlign: "center", marginTop: 24 }}>
          <Btn variant="glass" size="sm" onClick={() => loadMore()} disabled={loading}>
            {loading ? t.loading : t.timeline.loadMore}
          </Btn>
        </div>
      )}
      {!hasMore && sessions.length > 0 && (
        <div style={{ textAlign: "center", color: "var(--aurora-fg4)", fontSize: 12, marginTop: 20 }}>{t.timeline.allLoaded}</div>
      )}
      {!loading && sessions.length === 0 && (
        <div className="aurora-card" style={{ textAlign: "center", padding: 40, color: "var(--aurora-fg4)", fontSize: 13 }}>{t.timeline.noEvents}</div>
      )}
    </div>
  );
}

type SessionMessage = ConversationMessage & { subagent_name?: string };

const SessionMessages = memo(function SessionMessages({
  session, dateFmt, locale, t,
}: {
  session: Session;
  dateFmt: string;
  locale: string;
  t: ReturnType<typeof useI18n>["t"];
}) {
  // Group consecutive subagent messages for collapsible rendering
  type MsgItem = { msg: SessionMessage; isSubagent: boolean; subagentName: string };
  const items: MsgItem[] = session.messages.map((m) => ({
    msg: m,
    isSubagent: !!m.subagent_name,
    subagentName: m.subagent_name || "",
  }));

  // Build render groups: consecutive subagent messages → one collapsible block
  type RenderGroup = { type: "msg"; item: MsgItem } | { type: "subagent"; name: string; items: MsgItem[] };
  const groups: RenderGroup[] = [];
  for (const item of items) {
    if (item.isSubagent) {
      const last = groups[groups.length - 1];
      if (last && last.type === "subagent" && last.name === item.subagentName) {
        last.items.push(item);
      } else {
        groups.push({ type: "subagent", name: item.subagentName, items: [item] });
      }
    } else {
      groups.push({ type: "msg", item });
    }
  }

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "24px 0" }}>
        <div style={{ flex: 1, borderTop: "1px solid var(--aurora-border)", minWidth: 20 }} />
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
            maxWidth: "80%",
            flexWrap: "wrap",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              fontWeight: 600,
              color: "var(--aurora-fg2)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: 180,
              whiteSpace: "nowrap",
            }}
          >
            {session.title}
          </span>
          <span>·</span>
          <span style={{ whiteSpace: "nowrap" }}>{new Date(session.timestamp).toLocaleDateString(dateFmt)}</span>
          {session.message_count > 0 && (<><span>·</span><span>{session.message_count}</span></>)}
        </div>
        <div style={{ flex: 1, borderTop: "1px solid var(--aurora-border)", minWidth: 20 }} />
      </div>

      {/* Messages with subagent groups collapsed inline */}
      <div className="space-y-4 max-w-3xl mx-auto">
        {groups.map((g, gIdx) => {
          if (g.type === "msg") {
            const m = g.item.msg;
            const cm: ConversationMessage = {
              id: gIdx, line_number: gIdx + 1, role: m.role, content: m.content,
              thinking: m.thinking || null, tool_name: m.tool_name || "",
              tool_input: m.tool_input || "", raw_type: m.raw_type || "",
              timestamp: m.timestamp || null,
            };
            return <ChatBubble key={`${session.session_id}-${gIdx}`} msg={cm} locale={locale} t={t} />;
          }
          // Subagent group — collapsed inline
          return (
            <details
              key={`${session.session_id}-sub-${gIdx}`}
              style={{
                border: "1px solid var(--aurora-border)",
                borderRadius: 14,
                overflow: "hidden",
                background: "var(--aurora-accent-soft)",
              }}
            >
              <summary
                style={{
                  cursor: "pointer",
                  padding: "8px 14px",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  color: "var(--aurora-accent)",
                  fontWeight: 500,
                }}
              >
                <Icon name="layers" size={13} />
                <span style={{ fontWeight: 600 }}>{g.name}</span>
                <span style={{ opacity: 0.7 }}>· {g.items.length}</span>
              </summary>
              <div className="space-y-3" style={{ padding: "12px 8px", borderTop: "1px solid var(--aurora-border)", background: "var(--aurora-surface-solid)" }}>
                {g.items.map((item, iIdx) => {
                  const m = item.msg;
                  const cm: ConversationMessage = {
                    id: iIdx, line_number: iIdx + 1, role: m.role, content: m.content,
                    thinking: m.thinking || null, tool_name: m.tool_name || "",
                    tool_input: m.tool_input || "", raw_type: m.raw_type || "",
                    timestamp: m.timestamp || null,
                  };
                  return <ChatBubble key={`sub-${gIdx}-${iIdx}`} msg={cm} locale={locale} t={t} />;
                })}
              </div>
            </details>
          );
        })}
      </div>

      {/* Artifacts inline */}
      {session.artifacts.length > 0 && (
        <div className="space-y-2 my-4 max-w-3xl mx-auto">
          {session.artifacts.map((art) => (
            <InlineArtifact key={art.id} artifact={art} />
          ))}
        </div>
      )}
    </>
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
        </div>
      </div>
    </div>
  );
}
