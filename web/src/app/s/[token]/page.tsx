"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getApiBase } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { Btn, Glass, Chip } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";
import { ChatBubble } from "@/components/viewers/ConversationViewer";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";

interface ShareMeta {
  kind: "timeline" | "daily" | "memory" | "conversation";
  target_id: string;
  title: string | null;
  owner_name: string;
  expires_at: string | null;
  created_at: string;
  view_count: number;
  directed: boolean;
}

export interface SharedTurn {
  role: string;
  content: string;
  images?: string[];
  thinking?: string | null;
  toolCalls?: Array<{
    name?: string;
    args?: any;
    result?: any;
  }>;
  sources?: any[];
  created_at?: string | null;
}

export interface SharedConversationItem {
  id: string;
  title: string;
  type: "ask" | "collected";
  tool_id?: string;
  created_at: string | null;
  updated_at?: string | null;
  message_count?: number;
  turns: SharedTurn[];
}

export interface ConversationShareData {
  total_conversations: number;
  conversations: SharedConversationItem[];
}

type ShareData =
  | { kind: "timeline"; data: TimelineData }
  | { kind: "daily"; data: DailyData }
  | { kind: "memory"; data: MemoryData }
  | { kind: "conversation"; data: ConversationShareData };

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
interface MemoryNode {
  id: string;
  name: string;
  type: string;
  summary: string | null;
}
interface MemoryEdge {
  source: string;
  target: string;
  type: string;
  strength: number;
}
interface MemoryData {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  total_entities: number;
  total_relations: number;
}

type ErrState = "not_found" | "expired" | "revoked" | "load_failed" | "login_required" | "forbidden" | null;

function shareFetch(url: string): Promise<Response> {
  // Plain fetch + bearer if available. Bypasses authFetch's auto-redirect on
  // 401, since on /s/<token> we want to show our own "login required" UI
  // (which preserves the share URL so the visitor returns here after login).
  const headers: Record<string, string> = {};
  if (typeof window !== "undefined") {
    const token = localStorage.getItem("dr_token");
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }
  return fetch(url, { headers });
}

export default function PublicSharePage() {
  const params = useParams();
  const token = params.token as string;
  const { t, locale } = useI18n();
  const [meta, setMeta] = useState<ShareMeta | null>(null);
  const [payload, setPayload] = useState<ShareData | null>(null);
  const [error, setError] = useState<ErrState>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await shareFetch(`${getApiBase()}/api/share/public/${token}`);
        if (r.status === 401) { if (alive) setError("login_required"); return; }
        if (r.status === 403) { if (alive) setError("forbidden"); return; }
        if (r.status === 404) { if (alive) setError("not_found"); return; }
        if (r.status === 410) {
          const d = await r.json().catch(() => ({}));
          if (alive) setError(d.detail === "expired" ? "expired" : "revoked");
          return;
        }
        const m = await r.json();
        if (!alive) return;
        setMeta(m);

        const r2 = await shareFetch(`${getApiBase()}/api/share/public/${token}/data`);
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
  if (error === "forbidden") return <Centered msg={t.share.revokedNotice} />;
  if (error === "login_required") {
    const next = typeof window !== "undefined"
      ? `${window.location.pathname}${window.location.search}`
      : `/s/${token}`;
    return (
      <div style={{ minHeight: "80vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <Glass padding={28} radius={20} style={{ maxWidth: 380, textAlign: "center" }}>
          <Icon name="lock" size={28} style={{ color: "var(--aurora-fg3)", marginBottom: 12 }} />
          <div style={{ fontSize: 14, color: "var(--aurora-fg2)", marginBottom: 16 }}>
            {t.share.directedHint}
          </div>
          <Link href={`/auth/login?next=${encodeURIComponent(next)}`} style={{ textDecoration: "none" }}>
            <Btn size="sm" icon="arrow_right">{t.login}</Btn>
          </Link>
        </Glass>
      </div>
    );
  }

  if (!meta || !payload) return <Centered msg={t.loading} />;

  const kindLabel =
    meta.kind === "timeline" ? t.share.targetTimeline :
    meta.kind === "daily" ? t.share.targetDaily :
    meta.kind === "conversation" ? ((t.share as any).targetConversation || "对话分享") :
    t.share.targetMemory;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 pb-16">
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: "var(--aurora-fg4)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          {kindLabel}
        </div>
        <h1 style={{ margin: "6px 0 8px", fontSize: 22, fontWeight: 600, color: "var(--aurora-fg1)" }}>
          {meta.title || meta.target_id}
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--aurora-fg3)", flexWrap: "wrap" }}>
          <span>{t.share.sharedBy} {meta.owner_name}</span>
          {meta.directed && <Chip>{t.share.audienceUser}</Chip>}
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
      {payload.kind === "memory" && <MemoryView data={payload.data} />}
      {payload.kind === "conversation" && <ConversationShareView data={payload.data} locale={locale} t={t} />}

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
              <MarkdownViewer content={s.summary} />
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

function MemoryView({ data }: { data: MemoryData }) {
  // Simple list view of entities + relation count summary. The real graph
  // viz on /memory uses canvas + force layout — too heavy to bundle into the
  // share page just for a read-only snapshot.
  const byType = data.nodes.reduce<Record<string, MemoryNode[]>>((acc, n) => {
    (acc[n.type] = acc[n.type] || []).push(n);
    return acc;
  }, {});
  return (
    <>
      <Glass padding={18} radius={16} style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 16, fontSize: 13, color: "var(--aurora-fg3)" }}>
          <span>{data.total_entities} entities</span>
          <span>·</span>
          <span>{data.total_relations} relations</span>
        </div>
      </Glass>
      {Object.keys(byType).sort().map((type) => (
        <Glass key={type} padding={18} radius={16} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "var(--aurora-fg4)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
            {type} · {byType[type].length}
          </div>
          {byType[type].map((n) => (
            <div key={n.id} style={{
              padding: "8px 0", borderBottom: "1px solid var(--aurora-border)",
              fontSize: 13,
            }}>
              <div style={{ fontWeight: 500, color: "var(--aurora-fg1)" }}>{n.name}</div>
              {n.summary && (
                <div style={{ fontSize: 12, color: "var(--aurora-fg3)", marginTop: 2 }}>{n.summary}</div>
              )}
            </div>
          ))}
        </Glass>
      ))}
    </>
  );
}

function ConversationShareView({
  data,
  locale,
  t,
}: {
  data: ConversationShareData;
  locale: string;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const [showAll, setShowAll] = useState<boolean>(false);
  const isMulti = data.conversations.length > 1;

  return (
    <div>
      {/* 多会话切换栏 */}
      {isMulti && (
        <div className="mb-6 p-2 rounded-2xl bg-[var(--aurora-chip)] border border-[var(--aurora-border)]">
          <div className="flex items-center justify-between px-2 pb-2 mb-2 border-b border-[var(--aurora-border)]">
            <span className="text-xs font-semibold text-[var(--aurora-fg2)] flex items-center gap-1.5">
              <span>📚</span>
              <span>合并分享的对话列表 ({data.conversations.length})</span>
            </span>
            <div className="flex items-center gap-1.5 text-xs">
              <button
                type="button"
                onClick={() => setShowAll(false)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium cursor-pointer transition-colors ${
                  !showAll
                    ? "bg-[var(--aurora-accent)] text-slate-900 font-bold"
                    : "text-[var(--aurora-fg3)] hover:text-white"
                }`}
              >
                单篇切换
              </button>
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium cursor-pointer transition-colors ${
                  showAll
                    ? "bg-[var(--aurora-accent)] text-slate-900 font-bold"
                    : "text-[var(--aurora-fg3)] hover:text-white"
                }`}
              >
                展开全部
              </button>
            </div>
          </div>

          {!showAll && (
            <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
              {data.conversations.map((c, i) => {
                const active = activeIdx === i;
                return (
                  <button
                    key={c.id || i}
                    type="button"
                    onClick={() => setActiveIdx(i)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium shrink-0 cursor-pointer transition-all flex items-center gap-1.5 select-none ${
                      active
                        ? "bg-[var(--aurora-surface-solid)] border border-[var(--aurora-accent)] text-[var(--aurora-accent)] shadow-sm font-semibold"
                        : "bg-white/5 border border-transparent text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-white/10"
                    }`}
                  >
                    <span>💬</span>
                    <span className="truncate max-w-[150px] sm:max-w-[200px]">{c.title || `对话 ${i + 1}`}</span>
                    <span className="text-[10.5px] opacity-70">({c.turns.length})</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 对话内容呈现 */}
      {showAll ? (
        <div className="flex flex-col gap-6">
          {data.conversations.map((conv, idx) => (
            <ConversationItemCard key={conv.id || idx} conv={conv} locale={locale} index={idx} total={data.conversations.length} />
          ))}
        </div>
      ) : (
        <ConversationItemCard
          conv={data.conversations[activeIdx] || data.conversations[0]}
          locale={locale}
          index={activeIdx}
          total={data.conversations.length}
        />
      )}
    </div>
  );
}

function ConversationItemCard({
  conv,
  locale,
  index,
  total,
}: {
  conv: SharedConversationItem;
  locale: string;
  index: number;
  total: number;
}) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const copyContent = (text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(idx);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  if (!conv) return null;

  return (
    <Glass padding={22} radius={20} style={{ marginBottom: 16 }}>
      {/* 对话顶栏 */}
      <div className="flex items-center justify-between pb-3.5 mb-5 border-b border-[var(--aurora-border)]">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-xl shrink-0">💬</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base sm:text-lg font-semibold text-[var(--aurora-fg1)] truncate">{conv.title}</h2>
              {total > 1 && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--aurora-chip)] text-[var(--aurora-fg3)] font-mono shrink-0">
                  #{index + 1}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-[var(--aurora-fg3)] mt-0.5 flex-wrap">
              {conv.tool_id && <Chip tone="accent">{conv.tool_id}</Chip>}
              <span>{conv.turns.length} 轮消息</span>
              {conv.created_at && (
                <span>· {new Date(conv.created_at).toLocaleString(locale)}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 消息流 */}
      <div className="flex flex-col gap-4">
        {conv.turns.map((turn, idx) => {
          const isUser = turn.role === "user";
          return (
            <div
              key={idx}
              className={`flex gap-3 text-sm ${isUser ? "flex-row-reverse" : "flex-row"}`}
            >
              {/* 头像 */}
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold shadow-sm ${
                  isUser
                    ? "bg-gradient-to-br from-indigo-500 to-purple-600 text-white"
                    : "bg-gradient-to-br from-cyan-400 to-blue-600 text-slate-900"
                }`}
              >
                {isUser ? "你" : "AI"}
              </div>

              {/* 消息气泡 */}
              <div
                className={`max-w-[88%] sm:max-w-[84%] rounded-2xl p-3.5 sm:p-4 border transition-all ${
                  isUser
                    ? "bg-gradient-to-br from-indigo-600/20 to-purple-600/15 border-indigo-500/30 text-[var(--aurora-fg1)] shadow-sm"
                    : "bg-[var(--aurora-surface-solid)] border-[var(--aurora-border)] text-[var(--aurora-fg1)] shadow-md"
                }`}
              >
                {/* 思考过程展开块 */}
                {turn.thinking && (
                  <details className="mb-3 rounded-xl border border-purple-500/25 bg-purple-500/10 p-2.5 text-xs group/think">
                    <summary className="cursor-pointer font-semibold text-purple-300 flex items-center gap-1.5 select-none">
                      <span>💭</span>
                      <span>深度思考过程</span>
                      <span className="text-[10px] text-purple-400/60 font-mono">(展开)</span>
                    </summary>
                    <div className="mt-2 text-purple-200/80 whitespace-pre-wrap font-mono text-[11px] max-h-52 overflow-y-auto leading-relaxed border-t border-purple-500/15 pt-2">
                      {turn.thinking}
                    </div>
                  </details>
                )}

                {/* 工具调用指示 */}
                {turn.toolCalls && turn.toolCalls.length > 0 && (
                  <div className="mb-2.5 flex flex-wrap gap-1.5">
                    {turn.toolCalls.map((tc, tcIdx) => (
                      <span
                        key={tcIdx}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-[11px] font-mono text-amber-300"
                        title={typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args)}
                      >
                        <span>⚡</span>
                        <span>{tc.name || "tool"}</span>
                      </span>
                    ))}
                  </div>
                )}

                {/* 消息正文 */}
                {isUser ? (
                  <div className="whitespace-pre-wrap break-words leading-relaxed text-[var(--aurora-fg1)]">
                    {turn.content}
                  </div>
                ) : (
                  <div className="overflow-x-auto min-w-0">
                    <MarkdownViewer content={turn.content} />
                  </div>
                )}

                {/* 气泡底栏 */}
                <div className="mt-2.5 pt-2 border-t border-white/5 flex items-center justify-between text-[11px] text-[var(--aurora-fg4)]">
                  <span>
                    {turn.created_at
                      ? new Date(turn.created_at).toLocaleTimeString(locale, {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => copyContent(turn.content, idx)}
                    className="hover:text-[var(--aurora-accent)] cursor-pointer transition-colors px-1"
                    title="复制消息内容"
                  >
                    {copiedIndex === idx ? "✓ 已复制" : "复制"}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Glass>
  );
}
