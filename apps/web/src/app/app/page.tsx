"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { getApiBase, authFetch } from "@/lib/api-client";
import { onLiveEvent } from "@/lib/live-events";
import { useNow } from "@/lib/use-now";
import { timeAgo } from "@/lib/constants";
import { Icon, ToolGlyph, PlatformGlyph, TOOL_HUE } from "@/components/aurora/Icon";
import { MementoMark } from "@/components/aurora/MementoMark";
import { Glass, Chip, TopBar, SectionLabel, StatCard, Skeleton } from "@/components/aurora/primitives";

const QUICK_PROMPTS: { icon: Parameters<typeof Icon>[0]["name"]; label: string; prompt: string }[] = [
  { icon: "calendar", label: "总结昨天开发进展", prompt: "总结一下我昨天在各个设备和工具上的开发工作与对话" },
  { icon: "devices", label: "检查在线设备状态", prompt: "列出当前所有在线的设备，并检查它们的运行状态与端口" },
  { icon: "search", label: "检索近期架构讨论", prompt: "回顾一下我最近关于项目架构设计与关键方案的讨论" },
  { icon: "terminal", label: "排查服务与报错", prompt: "帮我排查一下开发机上的服务运行日志与最新报错" },
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

let cachedDashboardData: DashboardData | null = null;

export default function Dashboard() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(() => cachedDashboardData);
  const [loading, setLoading] = useState(() => !cachedDashboardData);
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
      .then((res: DashboardData) => {
        cachedDashboardData = res;
        setData(res);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const sseDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (sseDebounceTimerRef.current) {
        clearTimeout(sseDebounceTimerRef.current);
      }
    };
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  // Files synced are pushed over the page's one live connection (at most every 5 s while a collector
  // uploads), not a second EventSource with the token in its URL
  useEffect(
    () =>
      onLiveEvent("file_synced", (event) => {
        const d = event.data as { tool_id?: string; title?: string; relative_path?: string };
        // Readable: the tool's name and what was synced; a bare session id or path says nothing to a person
        const tool = cachedDashboardData?.tools.find((x) => x.id === d.tool_id)?.display_name || d.tool_id || "";
        const raw = (d.title || "").trim();
        const meaningless = !raw || /^[0-9a-f]{8}-[0-9a-f-]{20,}/i.test(raw) || /[\\/]/.test(raw) || /\.(jsonl?|md|db|pb)$/i.test(raw);
        setLastEvent(meaningless ? `${tool} 刚刚同步了新内容` : `${tool} 刚刚同步：${raw}`);
        if (sseDebounceTimerRef.current) {
          clearTimeout(sseDebounceTimerRef.current);
        }
        sseDebounceTimerRef.current = setTimeout(() => {
          fetchData();
        }, 800);
      }),
    [fetchData]
  );

  if (loading)
    return (
      <div className="max-w-6xl mx-auto" aria-busy="true" aria-label={t.loading}>
        <Skeleton width={160} height={26} style={{ margin: "10px 0 8px" }} />
        <Skeleton width={260} height={14} style={{ marginBottom: 24 }} />
        <Skeleton height={150} radius={16} style={{ marginBottom: 16 }} />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" style={{ marginBottom: 16 }}>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={104} radius={16} />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Skeleton height={220} radius={16} style={{ gridColumn: "span 2" }} />
          <Skeleton height={220} radius={16} />
        </div>
      </div>
    );
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

      {/* Ask AI Command Bar Card */}
      <div style={{ position: "relative", marginBottom: 16 }}>
        <Glass padding="18px 20px" radius={16} style={{ overflow: "hidden", position: "relative" }}>
          <div style={{ position: "relative" }}>
            <div className="flex items-center justify-between gap-4 mb-2.5">
              <div className="flex items-center gap-2.5">
                <MementoMark size={30} radius={8} />
                <div>
                  <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.015em", lineHeight: 1.2 }}>
                    {t.nav.ask || "AI 执事"} · 跨设备调度
                  </h2>
                  <p style={{ fontSize: 12.5, color: "var(--aurora-fg3)", marginTop: 2 }}>
                    基于全设备沉淀的编程知识问答，或直接向在线物理机派发任务
                  </p>
                </div>
              </div>
              <div className="hidden sm:flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full" style={{ background: "var(--aurora-chip)", color: "var(--aurora-fg2)" }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--aurora-success)" }} />
                <span style={{ fontSize: 12, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{devices.length} 台设备就绪</span>
              </div>
            </div>

            {/* Prompt Input Box */}
            <form onSubmit={handleAskSubmit} className="relative mt-3">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  background: "var(--aurora-thinking-bg)",
                  border: "1px solid var(--aurora-border-strong)",
                  borderRadius: 11,
                  padding: "4px 6px 4px 12px",
                  transition: "border-color 180ms ease, background-color 180ms ease",
                }}
              >
                <Icon name="search" size={15} style={{ color: "var(--aurora-fg3)", flexShrink: 0 }} />
                <input
                  type="text"
                  value={askPrompt}
                  onChange={(e) => setAskPrompt(e.target.value)}
                  placeholder="向 AI 提问编程记忆，或下发设备指令（如：检查开发机端口、总结昨天工作）..."
                  className="flex-1 bg-transparent border-0 outline-none text-[13.5px] px-2.5 py-1.5 text-[var(--aurora-fg1)] placeholder:text-[var(--aurora-fg4)] min-w-0"
                />

                {/* Target device selector */}
                {devices.length > 0 && (
                  <div
                    className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg mr-1.5 text-xs"
                    style={{
                      background: "var(--aurora-surface-solid)",
                      border: "1px solid var(--aurora-border)",
                      color: "var(--aurora-fg2)",
                    }}
                  >
                    <Icon name="devices" size={12} style={{ color: "var(--aurora-fg3)" }} />
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
                  className="aurora-btn aurora-btn-sm disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span>发送</span>
                  <Icon name="arrow_right" size={12.5} />
                </button>
              </div>
            </form>

            {/* Quick Prompt Chips */}
            <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
              <span style={{ fontSize: 12, color: "var(--aurora-fg4)", marginRight: 2 }}>快捷指令:</span>
              {QUICK_PROMPTS.map((qp) => (
                <button
                  key={qp.label}
                  type="button"
                  onClick={() => router.push(`/ask?q=${encodeURIComponent(qp.prompt)}`)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-colors duration-150 hover:border-[var(--aurora-accent)]"
                  style={{
                    background: "var(--aurora-chip)",
                    border: "1px solid var(--aurora-border)",
                    color: "var(--aurora-fg2)",
                    cursor: "pointer",
                  }}
                >
                  <Icon name={qp.icon} size={12} style={{ color: "var(--aurora-accent)" }} />
                  <span>{qp.label}</span>
                </button>
              ))}
            </div>
          </div>
        </Glass>
      </div>

      {/* Stat cards row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <StatCard label={t.dashboard.todayFiles} value={stats.today_total} sub={`${stats.today_conversations} ${t.dashboard.conversations}`} />
        <StatCard label={t.dashboard.totalFiles} value={stats.total_documents} sub={`${stats.total_tools} ${t.nav.tools}`} />
        <StatCard label={t.nav.projects} value={stats.total_projects} />
        <StatCard label={t.nav.devices} value={stats.total_devices} />
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        {/* Left col */}
        <div className="lg:col-span-2 space-y-6">
          {/* 7-day activity bars */}
          <Glass padding={20} radius={16}>
            <SectionLabel style={{ margin: "0 0 16px" }}>{t.dashboard.weeklyActivity}</SectionLabel>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 120 }}>
              {daily.map((d) => {
                const h = Math.max((d.count / maxDaily) * 100, 4);
                return (
                  <div key={d.date} style={{ flex: 1, height: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                    <span style={{ fontSize: 11, color: "var(--aurora-fg4)", fontVariantNumeric: "tabular-nums" }}>{d.count}</span>
                    {/* The bar's % height needs a parent with a height: this box takes what the labels leave */}
                    <div style={{ flex: 1, minHeight: 0, width: "100%", display: "flex", alignItems: "flex-end" }}>
                    <div
                      style={{
                        width: "100%",
                        height: `${h}%`,
                        borderRadius: "5px 5px 2px 2px",
                        background: "var(--aurora-accent)",
                        opacity: d.count > 0 ? 0.88 : 0.2,
                      }}
                    />
                    </div>
                    <span style={{ fontSize: 11, color: "var(--aurora-fg4)", fontVariantNumeric: "tabular-nums" }}>{d.date.slice(5)}</span>
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
                            <path
                              d={
                                trend
                                  .map((v, i) => `${i === 0 ? "M" : "L"}${(i / (trend.length - 1)) * 78 + 1},${30 - (v / maxT) * 26}`)
                                  .join(" ") + ` L79,32 L1,32 Z`
                              }
                              fill={`hsla(${tg.h},70%,52%,0.10)`}
                            />
                            <path
                              d={trend
                                .map((v, i) => `${i === 0 ? "M" : "L"}${(i / (trend.length - 1)) * 78 + 1},${30 - (v / maxT) * 26}`)
                                .join(" ")}
                              fill="none"
                              stroke={`hsl(${tg.h},70%,50%)`}
                              strokeWidth="1.6"
                              strokeLinecap="round"
                              strokeLinejoin="round"
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
                      `${conv.message_count} 条消息`,
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
                            background: isOnline ? "var(--aurora-success)" : "var(--aurora-fg4)",
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
              width: 48, height: 48, borderRadius: 14, margin: "0 auto 16px",
              background: "var(--aurora-brand-grad)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <Icon name="devices" size={22} style={{ color: "#fff" }} strokeWidth={2} />
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
              fontSize: 12,
              lineHeight: 1.6,
              maxWidth: 580,
              margin: "0 auto",
              fontFamily: "var(--font-mono)",
              textAlign: "left",
              whiteSpace: "pre-wrap",
              overflow: "auto",
            }}
          >
{`# 方式一：下载桌面客户端（推荐 · 免装环境 · 托盘常驻）
前往 GitHub Releases 下载 macOS / Windows / Linux 客户端，登录后自动开始采集

# 方式二：命令行守护进程（Node.js ≥ 20）
node packages/daemon/dist/cli.js install-service`}
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
