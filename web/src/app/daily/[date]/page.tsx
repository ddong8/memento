"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getApiBase, authFetch, ConversationMessage } from "@/lib/api-client";
import { useI18n, fmt } from "@/lib/i18n";
import { ChatBubble } from "@/components/viewers/ConversationViewer";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";
import { Icon, ToolGlyph } from "@/components/aurora/Icon";
import { Btn, Chip, Glass, TopBar, SectionLabel } from "@/components/aurora/primitives";

export default function DailyDetailPage() {
  const params = useParams();
  const dateStr = params.date as string;
  const [data, setData] = useState<any>(null);
  const [generating, setGenerating] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const { t, locale } = useI18n();

  useEffect(() => {
    const tz = new Date().getTimezoneOffset();
    authFetch(`${getApiBase()}/api/daily/${dateStr}?tz_offset=${tz}`).then((r) => r.json()).then((d) => {
      setData(d);
      // summary title is produced server-side by the AI summary pipeline; match any title that
      // contains a known marker. The English pipeline emits "AI Daily Summary", Chinese "AI 日报".
      const existing = d.summaries?.find((s: any) => s.title && /AI\s*(?:\u65e5\u62a5|Daily)/i.test(s.title));
      if (existing) setAiSummary(existing.summary);
    }).catch(console.error);
  }, [dateStr]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await authFetch(`${getApiBase()}/api/daily/${dateStr}/generate-summary`, { method: "POST" });
      if (res.ok) {
        const result = await res.json();
        setAiSummary(result.summary);
      } else {
        alert(t.daily.generateFailed);
      }
    } catch { alert(t.daily.generateFailed); }
    finally { setGenerating(false); }
  };

  if (!data) return <div style={{ color: "var(--aurora-fg4)", marginTop: 80, textAlign: "center" }}>{t.loading}</div>;

  const overview = data.overview || {};
  const conversations = overview.conversations || [];
  const keyChanges = overview.key_changes || [];
  const toolStats = overview.tool_stats || {};

  return (
    <div className="max-w-5xl mx-auto pb-12">
      <TopBar
        title={dateStr}
        subtitle={fmt(t.daily.subtitle, {
          conversations: conversations.length,
          tools: Object.keys(toolStats).length,
          messages: data.total_messages || 0,
        })}
        right={
          <Btn onClick={handleGenerate} disabled={generating} icon="sparkles">
            {generating ? t.daily.generating : aiSummary ? t.daily.regenerate : t.daily.generate}
          </Btn>
        }
      />

      {aiSummary && (
        <Glass padding={22} radius={22} style={{ marginBottom: 18, position: "relative", overflow: "hidden" }}>
          <div
            aria-hidden
            style={{
              position: "absolute", top: -80, right: -60, width: 240, height: 240, borderRadius: "50%",
              background: "radial-gradient(circle, rgba(124,58,237,0.25), transparent 70%)",
              filter: "blur(40px)", pointerEvents: "none",
            }}
          />
          <div style={{ position: "relative" }}>
            <Chip tone="accent" icon="sparkles" style={{ marginBottom: 10 }}>{t.daily.aiSummaryChip}</Chip>
            <div className="prose prose-sm max-w-none">
              <MarkdownViewer content={aiSummary} />
            </div>
          </div>
        </Glass>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4" style={{ marginBottom: 18 }}>
        <Glass padding={18} radius={20}>
          <SectionLabel style={{ margin: "0 0 12px" }}>{t.daily.toolUsage}</SectionLabel>
          {Object.keys(toolStats).length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--aurora-fg4)" }}>{t.daily.noToolMessages}</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {Object.entries(toolStats).sort(([, a], [, b]) => (b as number) - (a as number)).map(([tid, count]) => (
                <div key={tid} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <ToolGlyph id={tid} size={22} />
                    <span style={{ fontSize: 13, color: "var(--aurora-fg1)", textTransform: "capitalize" }}>
                      {tid.replace("_", " ")}
                    </span>
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--aurora-fg1)" }}>{count as number}</span>
                </div>
              ))}
            </div>
          )}
        </Glass>

        <Glass padding={18} radius={20}>
          <SectionLabel style={{ margin: "0 0 12px" }}>{fmt(t.daily.conversationsHeader, { count: conversations.length })}</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {conversations.length === 0 && (
              <p style={{ fontSize: 12, color: "var(--aurora-fg4)" }}>{t.daily.noConversations}</p>
            )}
            {conversations.slice(0, 30).map((c: { id: string; tool_id: string; content_type: string; title: string; user_messages: number; assistant_messages: number }) => (
              <Link key={c.id} href={c.content_type === "jsonl" ? `/conversations/${c.id}` : `/documents/${c.id}`}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "6px 8px", borderRadius: 10,
                  textDecoration: "none", color: "var(--aurora-fg1)",
                }}>
                <ToolGlyph id={c.tool_id} size={20} />
                <span style={{ flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.title}
                </span>
                <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>
                  {(c.user_messages || 0) + (c.assistant_messages || 0)}
                </span>
              </Link>
            ))}
            {conversations.length > 30 && (
              <p style={{ fontSize: 11, color: "var(--aurora-fg4)", padding: "4px 8px" }}>
                {fmt(t.daily.moreItems, { count: conversations.length - 30 })}
              </p>
            )}
          </div>
        </Glass>
      </div>

      {keyChanges.length > 0 && (
        <Glass padding={18} radius={20} style={{ marginBottom: 18 }}>
          <SectionLabel style={{ margin: "0 0 12px" }}>{fmt(t.daily.keyChanges, { count: keyChanges.length })}</SectionLabel>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
            {keyChanges.slice(0, 20).map((c: { id: string; category: string; title: string }) => (
              <Link key={c.id} href={`/documents/${c.id}`}
                style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                  borderRadius: 8, textDecoration: "none",
                  color: "var(--aurora-fg1)",
                }}>
                <Chip>{c.category}</Chip>
                <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.title}
                </span>
              </Link>
            ))}
          </div>
        </Glass>
      )}

      {/* Daily conversation flow */}
      <DailyConversationFlow dateStr={dateStr} t={t} locale={locale} />

    </div>
  );
}

function DailyConversationFlow({ dateStr, t, locale }: { dateStr: string; t: any; locale: string }) {
  const [messages, setMessages] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const PAGE_SIZE = 200;

  const loadMessages = async (append = false) => {
    setLoading(true);
    try {
      const currentOffset = append ? messages.length : 0;
      const tz = new Date().getTimezoneOffset();
      const res = await authFetch(`${getApiBase()}/api/daily/${dateStr}/messages?offset=${currentOffset}&limit=${PAGE_SIZE}&tz_offset=${tz}`);
      const data = await res.json();
      const newMsgs = data.messages || [];
      if (append) {
        setMessages((prev) => [...prev, ...newMsgs]);
      } else {
        setMessages(newMsgs);
      }
      setTotal(data.total || 0);
      setHasMore(currentOffset + newMsgs.length < (data.total || 0));
      setLoaded(true);
    } catch { }
    finally { setLoading(false); }
  };

  // Convert to ChatBubble format
  const chatMessages: ConversationMessage[] = messages.map((m, idx) => ({
    id: idx,
    line_number: idx + 1,
    role: m.role,
    content: m.content,
    thinking: null,
    tool_name: "",
    tool_input: "",
    raw_type: "",
    timestamp: m.timestamp,
  }));

  // Group by conversation for section headers
  let lastConvTitle = "";

  return (
    <div style={{ marginBottom: 18 }}>
      {!loaded ? (
        <Btn variant="glass" onClick={() => loadMessages()} disabled={loading} icon="message" style={{ width: "100%", justifyContent: "center" }}>
          {loading ? t.loading : t.daily.expandFlow}
        </Btn>
      ) : (
        <Glass padding={18} radius={20}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <h3 style={{ fontSize: 12, fontWeight: 600, color: "var(--aurora-fg3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {fmt(t.daily.flowHeader, { count: total })}
            </h3>
            <button
              onClick={() => setLoaded(false)}
              style={{ fontSize: 11, color: "var(--aurora-fg4)", background: "transparent", border: 0, cursor: "pointer" }}
            >
              {t.daily.collapse}
            </button>
          </div>
          <div className="space-y-3 max-w-3xl mx-auto">
            {chatMessages.map((msg, idx) => {
              const raw = messages[idx];
              const convTitle = raw?.conversation_title || "";
              const toolId = raw?.tool_id || "";
              const showHeader = convTitle !== lastConvTitle;
              lastConvTitle = convTitle;
              return (
                <div key={idx}>
                  {showHeader && convTitle && (
                    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "12px 0" }}>
                      <div style={{ flex: 1, borderTop: "1px solid var(--aurora-border)" }} />
                      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 9999, background: "var(--aurora-chip)", color: "var(--aurora-fg3)", fontSize: 11 }}>
                        <ToolGlyph id={toolId} size={16} />
                        <span>{convTitle}</span>
                      </div>
                      <div style={{ flex: 1, borderTop: "1px solid var(--aurora-border)" }} />
                    </div>
                  )}
                  <ChatBubble msg={msg} locale={locale} t={t} />
                </div>
              );
            })}
            {messages.length === 0 && (
              <p style={{ textAlign: "center", color: "var(--aurora-fg4)", fontSize: 13, padding: 16 }}>
                {t.daily.noMessages}
              </p>
            )}
            {hasMore && (
              <div style={{ textAlign: "center", padding: 12 }}>
                <Btn variant="ghost" size="sm" onClick={() => loadMessages(true)} disabled={loading}>
                  {loading ? t.loading : fmt(t.daily.loadMore, { loaded: messages.length, total })}
                </Btn>
              </div>
            )}
          </div>
        </Glass>
      )}
    </div>
  );
}

