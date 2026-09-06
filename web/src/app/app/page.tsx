"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { getApiBase, authFetch } from "@/lib/api-client";
import { useSSE } from "@/lib/use-sse";
import { useNow } from "@/lib/use-now";
import { timeAgo } from "@/lib/constants";
import { Icon, ToolGlyph, PlatformGlyph, TOOL_HUE } from "@/components/aurora/Icon";
import { Glass, Chip, TopBar, SectionLabel, StatCard } from "@/components/aurora/primitives";

const QUICK_PROMPTS = [
  { icon: "📅", label: "总结昨天开发进展", prompt: "总结一下我昨天在各个设备和工具上的开发工作与对话" },
  { icon: "💻", label: "检查在线设备状态", prompt: "列出当前所有在线的设备，并检查它们的运行状态与端口" },
  { icon: "🔍", label: "检索近期架构讨论", prompt: "回顾一下我最近关于项目架构设计与关键方案的讨论" },
  { icon: "⚡", label: "排查服务与报错", prompt: "帮我排查一下开发机上的服务运行日志与最新报错" },
];

interface DashboardData {
  tools: {
    id: string;
    display_name: string;
    total_files: number;
    last_sync_at: string | null;
    categories: Record<string, number>;
    today_count: number;
    conversation_count: number;
  }[];
  recent_conversations: {
    id: string;
    tool_id: string;
    title: string;
    synced_at: string;
    project_title: string | null;
    message_count: number;
  }[];
  daily: { date: string; count: number }[];
  tool_daily: Record<string, { date: string; count: number }[]>;
  devices: {
    id: string;
    device_id: string;
    name: string;
    last_heartbeat: string | null;
    collector_version: string | null;
    total_files: number;
  }[];
  stats: {
    total_documents: number;
    total_projects: number;
    total_tools: number;
    total_devices: number;
    today_total: number;
    today_conversations: number;
  };
}

export default function Dashboard() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastEvent, setLastEvent] = useState("");
  const [askPrompt, setAskPrompt] = useState("");
  const [askDevice, setAskDevice] = useState("auto");
  const { t } = useI18n();
  const now = useNow();

  const handleAskSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = askPrompt.trim();
    if (!q) return;
    const params = new URLSearchParams({ q });
    if (askDevice && askDevice !== "auto") params.set("device", askDevice);
    router.push(`/ask?${params.toString()}`);
  };

  const fetchData = useCallback(() => {
    const tz = new Date().getTimezoneOffset();
    authFetch(`${getApiBase()}/api/dashboard?tz_offset=${tz}`)
      .then((r) => r.json())
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  useSSE((event) => {
    setLastEvent(`${event.data.tool_id}: ${event.data.title || event.data.relative_path}`);
    fetchData();
  });

  if (loading) return <div style={{ color: "var(--aurora-fg4)", textAlign: "center", marginTop: 80 }}>{t.loading}</div>;
  if (!data) return <div style={{ color: "var(--aurora-fg4)", textAlign: "center", marginTop: 80 }}>Failed to load dashboard</div>;

  const { stats, tools, recent_conversations, daily, devices } = data;
  const maxDaily = Math.max(...daily.map((d) => d.count), 1);

  return (
    <div className="max-w-6xl mx-auto">
      <TopBar
        title={t.nav.dashboard}
        subtitle={`${stats.total_documents.toLocaleString()} ${t.files} · ${stats.total_tools} ${t.nav.tools} · ${stats.total_devices} ${t.nav.devices}`}
        right={lastEvent && (
          <Chip tone="success" icon="activity">
            {lastEvent.length > 48 ? lastEvent.slice(0, 48) + "…" : lastEvent}
          </Chip>
        )}
      />

      {/* Ask AI Hero Card */}
      <div style={{ position: "relative", marginBottom: 20 }}>
        <Glass padding={24} radius={24} style={{ overflow: "hidden", position: "relative" }}>
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: -80,
              right: -40,
              width: 340,
              height: 340,
              borderRadius: "50%",
              background: "radial-gradient(circle, rgba(124,58,237,0.32), transparent 70%)",
              filter: "blur(40px)",
              pointerEvents: "none",
            }}
          />
          <div style={{ position: "relative" }}>
            <div className="flex items-center justify-between gap-4 mb-3">
              <div className="flex items-center gap-2.5">
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 10,
                    background: "var(--aurora-brand-grad)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 4px 12px -2px rgba(124,58,237,0.4)",
                  }}
                >
                  <Icon name="sparkles" size={16} style={{ color: "#fff" }} />
                </div>
                <div>
                  <h2 style={{ fontSize: 17, fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.02em" }}>
                    {t.nav.ask || "问记忆"} · 跨设备调度
                  </h2>
                  <p style={{ fontSize: 12, color: "var(--aurora-fg4)", marginTop: 1 }}>
                    基于全设备沉淀的编程知识问答，或直接向在线物理机调度排查任务
                  </p>
                </div>
              </div>
              <div className="hidden sm:flex items-center gap-2 text-xs" style={{ color: "var(--aurora-fg3)" }}>
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span>{devices.length} 台设备就绪</span>
              </div>
            </div>

            {/* Prompt Input Box */}
            <form onSubmit={handleAskSubmit} className="relative mt-4">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  background: "var(--aurora-input)",
                  border: "1px solid var(--aurora-border)",
                  borderRadius: 16,
                  padding: "6px 8px 6px 16px",
                  boxShadow: "0 4px 20px -4px rgba(0,0,0,0.06)",
                  transition: "all .2s",
                }}
                className="focus-within:border-purple-500 focus-within:ring-2 focus-within:ring-purple-500/20"
              >
                <Icon name="sparkles" size={18} style={{ color: "var(--aurora-brand-from)", flexShrink: 0 }} />
                <input
                  type="text"
                  value={askPrompt}
                  onChange={(e) => setAskPrompt(e.target.value)}
                  placeholder="向 AI 提问编程记忆，或下发设备指令（如：检查开发机端口、总结昨天工作）..."
                  className="flex-1 bg-transparent border-0 outline-none text-sm px-3 py-2 text-aurora-fg1 placeholder:text-aurora-fg4 min-w-0"
                />

                {/* Target device selector */}
                {devices.length > 0 && (
                  <div
                    className="hidden sm:flex items-center gap-1 px-2.5 py-1.5 rounded-lg mr-2 text-xs"
                    style={{
                      background: "var(--aurora-surface)",
                      border: "1px solid var(--aurora-border)",
                      color: "var(--aurora-fg2)",
                    }}
                  >
                    <Icon name="devices" size={12} style={{ color: "var(--aurora-fg4)" }} />
                    <select
                      value={askDevice}
                      onChange={(e) => setAskDevice(e.target.value)}
                      className="bg-transparent border-0 outline-none text-xs cursor-pointer"
                      style={{ color: "var(--aurora-fg2)" }}
                    >
                      <option value="auto">自动调度</option>
                      {devices.map((d) => (
                        <option key={d.device_id} value={d.device_id}>
                          {d.name.replace(/ \(\w+\)$/, "")}
                        </option>
                      ))}
                      <option value="ask_only">仅查资料</option>
                    </select>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={!askPrompt.trim()}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  style={{
                    background: "var(--aurora-brand-grad)",
                    boxShadow: "0 2px 8px -1px rgba(124,58,237,0.4)",
                  }}
                >
                  <span>发送</span>
                  <Icon name="rocket" size={13} />
                </button>
              </div>
            </form>

            {/* Quick Prompt Chips */}
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <span style={{ fontSize: 11, color: "var(--aurora-fg4)", marginRight: 2 }}>快捷探索:</span>
              {QUICK_PROMPTS.map((qp) => (
                <button
                  key={qp.label}
                  type="button"
                  onClick={() => router.push(`/ask?q=${encodeURIComponent(qp.prompt)}`)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-all hover:border-purple-400"
                  style={{
                    background: "var(--aurora-chip)",
                    border: "1px solid var(--aurora-border)",
                    color: "var(--aurora-fg2)",
                    cursor: "pointer",
                  }}
                >
                  <span>{qp.icon}</span>
                  <span>{qp.label}</span>
                </button>
              ))}
            </div>
          </div>
        </Glass>
      </div>

      {/* Hero stat card */}
      <div style={{ position: "relative", marginBottom: 18 }}>
        <Glass padding={28} radius={24} style={{ overflow: "hidden", position: "relative" }}>
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: -120, right: -80,
              width: 320, height: 320, borderRadius: "50%",
              background: "radial-gradient(circle, rgba(124,58,237,0.35), transparent 70%)",
              filter: "blur(40px)",
              pointerEvents: "none",
            }}
          />
          <div style={{ position: "relative", display: "flex", gap: 36, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <Chip tone="accent" icon="activity" style={{ marginBottom: 10 }}>Live</Chip>
              <div style={{ fontSize: "clamp(32px, 5vw, 44px)", fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.04em", lineHeight: 1 }}>
                {stats.total_documents.toLocaleString()}
                <span style={{ color: "var(--aurora-fg4)", fontWeight: 400 }}> {t.files}</span>
              </div>
              <div style={{ fontSize: 14, color: "var(--aurora-fg3)", marginTop: 8, letterSpacing: "-0.01em" }}>
                across <b style={{ color: "var(--aurora-fg2)" }}>{stats.total_tools} {t.nav.tools}</b>,{" "}
                <b style={{ color: "var(--aurora-fg2)" }}>{stats.total_projects} {t.nav.projects}</b>
              </div>
            </div>
            <div style={{ display: "flex", gap: 24 }}>
              {[
                { v: stats.today_total.toLocaleString(), l: t.dashboard.today },
                { v: stats.today_conversations.toLocaleString(), l: t.dashboard.conversations },
                { v: stats.total_devices.toString(), l: t.nav.devices },
              ].map((s) => (
                <div key={s.l} style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 26, fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.03em" }}>{s.v}</div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--aurora-fg4)",
                      marginTop: 2,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                    }}
                  >
                    {s.l}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Glass>
      </div>

      {/* Stat cards row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label={t.dashboard.todayFiles} value={stats.today_total} sub={`${stats.today_conversations} ${t.dashboard.conversations}`} />
        <StatCard label={t.dashboard.totalFiles} value={stats.total_documents} />
        <StatCard label={t.nav.projects} value={stats.total_projects} />
        <StatCard label={t.nav.devices} value={stats.total_devices} />
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        {/* Left col */}
        <div className="lg:col-span-2 space-y-6">
          {/* 7-day activity bars */}
          <Glass padding={22} radius={22}>
            <SectionLabel style={{ margin: "0 0 16px" }}>{t.dashboard.weeklyActivity}</SectionLabel>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 88 }}>
              {daily.map((d) => {
                const h = Math.max((d.count / maxDaily) * 100, 4);
                return (
                  <div key={d.date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                    <span style={{ fontSize: 10, color: "var(--aurora-fg4)" }}>{d.count}</span>
                    <div
                      style={{
                        width: "100%",
                        height: `${h}%`,
                        borderRadius: "6px 6px 2px 2px",
                        background: "linear-gradient(180deg, #A78BFA, #7C3AED)",
                        boxShadow: "0 4px 12px -4px rgba(124,58,237,0.45)",
                      }}
                    />
                    <span style={{ fontSize: 10, color: "var(--aurora-fg4)" }}>{d.date.slice(5)}</span>
                  </div>
                );
              })}
            </div>
          </Glass>

          {/* Tools grid */}
          <div>
            <SectionLabel>{t.dashboard.toolOverview}</SectionLabel>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 gap-3">
              {tools.map((tool) => {
                const tg = TOOL_HUE[tool.id] ?? TOOL_HUE.claude_code;
                const toolDaily = data.tool_daily[tool.id] ?? [];
                const trend = toolDaily.map((d) => d.count);
                const maxT = Math.max(...trend, 1);
                return (
                  <Link key={tool.id} href={`/tools/${tool.id}`} style={{ textDecoration: "none" }}>
                    <Glass hover padding={18} radius={18} accent={`hsla(${tg.h},80%,55%,0.25)`}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                        <ToolGlyph id={tool.id} size={36} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: 14,
                              fontWeight: 600,
                              color: "var(--aurora-fg1)",
                              textTransform: "capitalize",
                              letterSpacing: "-0.01em",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {tool.display_name}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>
                            {tool.last_sync_at ? timeAgo(tool.last_sync_at) : t.never}
                          </div>
                        </div>
                        {tool.today_count > 0 && <Chip tone="accent">+{tool.today_count}</Chip>}
                      </div>
                      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
                        <div>
                          <div style={{ fontSize: 26, fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.03em", lineHeight: 1 }}>
                            {tool.total_files}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginTop: 4 }}>{t.files}</div>
                        </div>
                        {trend.length > 1 && (
                          <svg width="80" height="32" viewBox="0 0 80 32">
                            <defs>
                              <linearGradient id={`spark-${tool.id}`} x1="0" x2="0" y1="0" y2="1">
                                <stop offset="0" stopColor={`hsl(${tg.h},80%,60%)`} stopOpacity="0.4" />
                                <stop offset="1" stopColor={`hsl(${tg.h},80%,60%)`} stopOpacity="0" />
                              </linearGradient>
                            </defs>
                            <path
                              d={
                                trend
                                  .map((v, i) => `${i === 0 ? "M" : "L"}${(i / (trend.length - 1)) * 78 + 1},${30 - (v / maxT) * 26}`)
                                  .join(" ") + ` L79,32 L1,32 Z`
                              }
                              fill={`url(#spark-${tool.id})`}
                            />
                            <path
                              d={trend
                                .map((v, i) => `${i === 0 ? "M" : "L"}${(i / (trend.length - 1)) * 78 + 1},${30 - (v / maxT) * 26}`)
                                .join(" ")}
                              fill="none"
                              stroke={`hsl(${tg.h},80%,55%)`}
                              strokeWidth="1.5"
                              strokeLinecap="round"
                            />
                          </svg>
                        )}
                      </div>
                    </Glass>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right col */}
        <div className="space-y-6">
          <div>
            <SectionLabel>{t.dashboard.recentConversations}</SectionLabel>
            <Glass padding={6} radius={20}>
              {recent_conversations.length === 0 ? (
                <p style={{ padding: 14, fontSize: 13, color: "var(--aurora-fg4)" }}>{t.noData}</p>
              ) : (
                recent_conversations.map((conv) => (
                  <RecentRow
                    key={conv.id}
                    toolId={conv.tool_id}
                    title={conv.title || "Untitled"}
                    subtitle={[
                      conv.project_title,
                      `${conv.message_count} msg`,
                      timeAgo(conv.synced_at),
                    ].filter(Boolean).join(" · ")}
                    href={`/conversations/${conv.id}`}
                  />
                ))
              )}
            </Glass>
          </div>

          {/* Devices */}
          <div>
            <SectionLabel>{t.nav.devices}</SectionLabel>
            <Glass padding={6} radius={20}>
              {devices.length === 0 ? (
                <p style={{ padding: 14, fontSize: 13, color: "var(--aurora-fg4)" }}>{t.devices.noDevices}</p>
              ) : (
                devices.map((device) => {
                  const isOnline =
                    !!device.last_heartbeat &&
                    now - new Date(device.last_heartbeat).getTime() < 300000;
                  const shortName = device.name.replace(/ \(\w+\)$/, "");
                  return (
                    <div
                      key={device.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "10px 12px",
                        borderRadius: 14,
                      }}
                    >
                      <PlatformGlyph name={device.name} size={32} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--aurora-fg1)", letterSpacing: "-0.01em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {shortName}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginTop: 1 }}>
                          {device.total_files} {t.files}
                          {device.collector_version && ` · v${device.collector_version}`}
                        </div>
                      </div>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: 10.5,
                          fontWeight: 500,
                          padding: "2px 8px",
                          borderRadius: 9999,
                          background: isOnline ? "rgba(16,185,129,0.12)" : "var(--aurora-chip)",
                          color: isOnline ? "#10B981" : "var(--aurora-fg4)",
                        }}
                      >
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 9999,
                            background: isOnline ? "#10B981" : "var(--aurora-fg4)",
                            boxShadow: isOnline ? "0 0 8px #10B981" : "none",
                          }}
                        />
                        {isOnline ? t.online : t.never}
                      </span>
                    </div>
                  );
                })
              )}
            </Glass>
          </div>
        </div>
      </div>

      {devices.length === 0 && (
        <Glass padding={40} radius={22} style={{ marginTop: 24, textAlign: "center" }}>
          <div
            style={{
              width: 52, height: 52, borderRadius: 16, margin: "0 auto 16px",
              background: "var(--aurora-brand-grad)",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 12px 40px -10px rgba(124,58,237,0.5)",
            }}
          >
            <Icon name="devices" size={24} style={{ color: "#fff" }} strokeWidth={2} />
          </div>
          <p style={{ fontSize: 15, fontWeight: 500, color: "var(--aurora-fg1)", marginBottom: 4, letterSpacing: "-0.02em" }}>
            {t.devices.noDevices}
          </p>
          <p style={{ fontSize: 13, color: "var(--aurora-fg4)", marginBottom: 14 }}>{t.devices.installHint}</p>
          <pre
            style={{
              display: "block",
              background: "#111827",
              color: "#34D399",
              borderRadius: 12,
              padding: 14,
              fontSize: 13,
              maxWidth: 560,
              margin: "0 auto",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              textAlign: "left",
              whiteSpace: "pre",
              overflow: "auto",
            }}
          >
{`pip install memento-brain-collector    # ${t.devices.snippetCollectorOnly}
# ${t.devices.snippetMetaOption}
pip install memento-brain

memento-collector setup`}
          </pre>
        </Glass>
      )}
    </div>
  );
}

function RecentRow({
  toolId, title, subtitle, href,
}: { toolId: string; title: string; subtitle: string; href: string }) {
  const [h, setH] = useState(false);
  return (
    <Link
      href={href}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 12px",
        borderRadius: 14,
        background: h ? "var(--aurora-chip)" : "transparent",
        transition: "background .15s",
        textDecoration: "none",
      }}
    >
      <ToolGlyph id={toolId} size={28} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: "var(--aurora-fg1)",
            letterSpacing: "-0.01em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--aurora-fg4)",
            marginTop: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {subtitle}
        </div>
      </div>
      <Icon name="chevron_right" size={14} style={{ color: "var(--aurora-fg4)" }} />
    </Link>
  );
}
