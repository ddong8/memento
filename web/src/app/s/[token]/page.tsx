"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getApiBase } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { Glass, Chip } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";
import { ChatBubble } from "@/components/viewers/ConversationViewer";

interface ShareMeta {
  kind: "timeline" | "daily";
  target_id: string;
  title: string | null;
  owner_name: string;
  expires_at: string | null;
  created_at: string;
  view_count: number;
}

type ShareData =
  | { kind: "timeline"; data: TimelineData }
  | { kind: "daily"; data: DailyData };

interface SessionMessage {
  role: string;
  content: string;
  thinking?: string | null;
  tool_name?: string;
  tool_input?: string;
  timestamp?: string | null;
}
interface SessionArtifact {
  id: string;
  title: string;
  doc_type: string;
  content: string | null;
}
interface Session {
  session_id: string;
  title: string;
  conversation_id: string;
  timestamp: string;
  message_count: number;
  messages: SessionMessage[];
  artifacts: SessionArtifact[];
  truncated?: boolean;
}
interface TimelineData {
  project: { id: string; title: string; source_path: string };
  total_sessions: number;
  sessions: Session[];
}
interface DailyConv {
  id: string;
  tool_id: string;
  title: string;
  user_messages: number;
  assistant_messages: number;
}
interface DailyData {
  date: string;
  total_messages: number;
  overview: {
    conversations: DailyConv[];
    tool_stats: Record<string, number>;
  };
  summaries: Array<{
    id: string;
    tool_id: string | null;
    title: string;
    summary: string;
  }>;
}

export default function PublicSharePage() {
  const params = useParams();
  const token = params.token as string;
  const { t, locale } = useI18n();
  const [meta, setMeta] = useState<ShareMeta | null>(null);
  const [payload, setPayload] = useState<ShareData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`${getApiBase()}/api/share/public/${token}`);
        if (r.status === 404) { if (alive) setError("not_found"); return; }
        if (r.status === 410) {
          const d = await r.json().catch(() => ({}));
          if (alive) setError(d.detail === "expired" ? "expired" : "revoked");
          return;
        }
        const m = await r.json();
        if (!alive) return;
        setMeta(m);

        const r2 = await fetch(`${getApiBase()}/api/share/public/${token}/data`);
        if (!r2.ok) { if (alive) setError("load_failed"); return; }
        const d2: ShareData = await r2.json();
        if (alive) setPayload(d2);
      } catch {
        if (alive) setError("load_failed");
      }
    })();
    return () => { alive = false; };
  }, [token]);

  if (error === "not_found") return <Centered msg={t.share.revokedNotice} />;
  if (error === "revoked") return <Centered msg={t.share.revokedNotice} />;
  if (error === "expired") return <Centered msg={t.share.expiredNotice} />;
  if (error === "load_failed") return <Centered msg={t.loading} />;

  if (!meta || !payload) return <Centered msg={t.loading} />;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 pb-16">
      {/* Header strip */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: "var(--aurora-fg4)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          {meta.kind === "timeline" ? t.share.targetTimeline : t.share.targetDaily}
        </div>
        <h1 style={{ margin: "6px 0 8px", fontSize: 22, fontWeight: 600, color: "var(--aurora-fg1)" }}>
          {meta.title || meta.target_id}
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--aurora-fg3)" }}>
          <span>{t.share.sharedBy} {meta.owner_name}</span>
          <Chip tone="accent">
            <Icon name="eye" size={11} style={{ marginRight: 4, verticalAlign: -1 }} />
            {meta.view_count}
          </Chip>
          {meta.expires_at && (
            <span style={{ color: "var(--aurora-fg4)" }}>
              · {t.share.expiresAt}: {new Date(meta.expires_at).toLocaleDateString(locale)}
            </span>
          )}
        </div>
      </div>

      {payload.kind === "timeline" && <TimelineView data={payload.data} locale={locale} t={t} />}
      {payload.kind === "daily" && <DailyView data={payload.data} />}

      <div style={{ marginTop: 40, textAlign: "center", fontSize: 11, color: "var(--aurora-fg4)" }}>
        Powered by Memento · <a href="/" style={{ color: "var(--aurora-accent)" }}>memento</a>
      </div>
    </div>
  );
}

function Centered({ msg }: { msg: string }) {
  return (
    <div style={{ minHeight: "80vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ color: "var(--aurora-fg3)", fontSize: 14 }}>{msg}</div>
    </div>
  );
}

function TimelineView({ data, locale, t }: { data: TimelineData; locale: string; t: ReturnType<typeof useI18n>["t"] }) {
  return (
    <>
      {data.sessions.map((s) => (
        <Glass key={s.session_id || s.conversation_id} padding={18} radius={16} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)", marginBottom: 4 }}>
            {s.title}
          </div>
          <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginBottom: 10 }}>
            {new Date(s.timestamp).toLocaleString()} · {s.message_count} msgs
            {s.truncated && " (preview)"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {s.messages.map((m, i) => (
              <ChatBubble
                key={i}
                msg={{ id: i, line_number: i, role: m.role, content: m.content,
                       tool_name: m.tool_name, tool_input: m.tool_input, timestamp: m.timestamp ?? null }}
                locale={locale}
                t={t}
              />
            ))}
          </div>
          {s.artifacts.length > 0 && (
            <div style={{ marginTop: 14, borderTop: "1px solid var(--aurora-border)", paddingTop: 10 }}>
              <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginBottom: 6 }}>Artifacts</div>
              {s.artifacts.map((a) => (
                <details key={a.id} style={{ fontSize: 12, marginBottom: 4 }}>
                  <summary style={{ cursor: "pointer", color: "var(--aurora-fg2)" }}>
                    [{a.doc_type}] {a.title}
                  </summary>
                  <pre style={{
                    marginTop: 6, padding: 10, fontSize: 11, lineHeight: 1.5,
                    background: "var(--aurora-chip)", borderRadius: 8,
                    color: "var(--aurora-fg2)", overflowX: "auto", whiteSpace: "pre-wrap",
                  }}>{a.content}</pre>
                </details>
              ))}
            </div>
          )}
        </Glass>
      ))}
    </>
  );
}

function DailyView({ data }: { data: DailyData }) {
  return (
    <>
      {data.summaries.length > 0 && (
        <Glass padding={20} radius={16} style={{ marginBottom: 16 }}>
          {data.summaries.map((s) => (
            <div key={s.id} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)", marginBottom: 8 }}>
                {s.title}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.65, color: "var(--aurora-fg2)", whiteSpace: "pre-wrap" }}>
                {s.summary}
              </div>
            </div>
          ))}
        </Glass>
      )}
      <Glass padding={18} radius={16}>
        <div style={{ fontSize: 13, color: "var(--aurora-fg3)", marginBottom: 8 }}>
          Conversations ({data.overview.conversations.length}) · {data.total_messages} msgs
        </div>
        {data.overview.conversations.map((c) => (
          <div key={c.id} style={{
            padding: "8px 0", borderBottom: "1px solid var(--aurora-border)",
            fontSize: 13, color: "var(--aurora-fg2)",
            display: "flex", justifyContent: "space-between", gap: 10,
          }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              [{c.tool_id}] {c.title}
            </span>
            <span style={{ color: "var(--aurora-fg4)", fontSize: 11, flexShrink: 0 }}>
              {c.user_messages}↑ {c.assistant_messages}↓
            </span>
          </div>
        ))}
      </Glass>
    </>
  );
}
