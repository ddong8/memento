"use client";

import { memo, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getApiBase } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { ChatBubble } from "@/components/viewers/ConversationViewer";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";
import { Icon } from "@/components/aurora/Icon";
import { Btn, TopBar } from "@/components/aurora/primitives";

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

  const loadMore = async (reset = false) => {
    setLoading(true);
    try {
      const off = reset ? 0 : offsetRef.current;
      const res = await fetch(
        `${getApiBase()}/api/projects/${projectId}/conversations?session_offset=${off}&session_limit=5&order=${order}`
      ).then((r) => r.json()) as ProjectConversationsResponse;

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
        subtitle={`${data?.project?.source_path || ""} · ${data?.total_sessions || 0} sessions`}
        right={
          <Btn variant="glass" size="sm" icon={order === "asc" ? "arrow_up" : "arrow_down"}
               onClick={() => setOrder(order === "asc" ? "desc" : "asc")}>
            {order === "asc" ? t.timeline.oldToNew : t.timeline.newToOld}
          </Btn>
        }
      />

      {/* Continuous conversation flow */}
      <div className="space-y-0">
        {sessions.map((session, sIdx) => (
          <SessionBlock key={session.session_id || sIdx} session={session} dateFmt={dateFmt} locale={locale} t={t} />
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
    </div>
  );
}

const SessionBlock = memo(function SessionBlock({
  session, dateFmt, locale, t,
}: {
  session: Session;
  dateFmt: string;
  locale: string;
  t: ReturnType<typeof useI18n>["t"];
}) {
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
            flexShrink: 0,
          }}
        >
          <span style={{ fontWeight: 600, color: "var(--aurora-fg2)" }}>{session.title}</span>
          <span>·</span>
          <span>{new Date(session.timestamp).toLocaleString(dateFmt)}</span>
          <span>·</span>
          <span>{session.message_count} msgs</span>
        </div>
        <div style={{ flex: 1, borderTop: "1px solid var(--aurora-border)" }} />
      </div>

      {/* Messages */}
      <div className="space-y-3">
        {session.messages.map((msg, idx) => (
          <ChatBubble key={idx} msg={{
            id: idx, line_number: idx, role: msg.role, content: msg.content,
            tool_name: msg.tool_name, tool_input: msg.tool_input,
            timestamp: msg.timestamp || null,
          }} locale={locale} t={t} />
        ))}

        {/* Artifacts inline */}
        {session.artifacts.length > 0 && (
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
