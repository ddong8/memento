"use client";

import Link from "next/link";
import { Icon } from "@/components/aurora/Icon";
import { Chip } from "@/components/aurora/primitives";

interface CognitiveCompassProps {
  currentTab: "memory" | "persona" | "skills";
  variant?: "full" | "compact";
  summaryStats?: {
    memoryCount?: number;
    personaVersion?: number | string;
    syncedTargetsCount?: number;
    skillsCount?: number;
  };
}

export default function CognitiveCompass({ currentTab, variant = "full", summaryStats }: CognitiveCompassProps) {
  const pillars = [
    {
      id: "memory" as const,
      href: "/memory",
      title: "长期记忆",
      tagline: "知识储备库",
      desc: "AI 记住了什么 · 项目事实、架构准则与经验拓扑",
      icon: "brain" as const,
      color: "#8B5CF6",
      bgSoft: "rgba(139, 92, 246, 0.08)",
      borderSoft: "rgba(139, 92, 246, 0.24)",
      badge: summaryStats?.memoryCount !== undefined ? `${summaryStats.memoryCount} 条核心沉淀` : "分层知识树",
    },
    {
      id: "persona" as const,
      href: "/memory/persona",
      title: "个人画像",
      tagline: "行为与铁律",
      desc: "AI 怎么为你做事 · 沟通习惯、避坑准则与跨端热注入",
      icon: "user" as const,
      color: "#EC4899",
      bgSoft: "rgba(236, 72, 153, 0.08)",
      borderSoft: "rgba(236, 72, 153, 0.24)",
      badge: summaryStats?.personaVersion
        ? `v${summaryStats.personaVersion} · 已守护 ${summaryStats.syncedTargetsCount ?? 5} 终端`
        : "全域 AI 规则同步",
    },
    {
      id: "skills" as const,
      href: "/skills",
      title: "技能进化",
      tagline: "特长与工具箱",
      desc: "AI 会执行什么 · 自动化工作流、专属执行脚本与 SOP",
      icon: "zap" as const,
      color: "#F59E0B",
      bgSoft: "rgba(245, 158, 11, 0.08)",
      borderSoft: "rgba(245, 158, 11, 0.24)",
      badge: summaryStats?.skillsCount !== undefined ? `${summaryStats.skillsCount} 个自进化技能` : "标准化能力",
    },
  ];

  if (variant === "compact") {
    return (
      <div className="w-full flex items-center justify-between gap-3 px-3 py-1.5 rounded-2xl border border-[var(--aurora-border)] bg-[var(--aurora-surface)] shadow-2xs">
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none py-0.5">
          <span className="text-[10px] font-bold text-[var(--aurora-fg4)] uppercase tracking-wider font-mono mr-1 shrink-0">
            认知大脑
          </span>
          {pillars.map((p) => {
            const isActive = currentTab === p.id;
            return (
              <Link
                key={p.id}
                href={p.href}
                className={`px-3 py-1 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 shrink-0 ${
                  isActive
                    ? "bg-[var(--aurora-surface-solid)] text-[var(--aurora-fg1)] shadow-xs font-semibold border border-[var(--aurora-border-strong)]"
                    : "text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)]"
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: p.color }} />
                <span>{p.title}</span>
                <span className="text-[10px] text-[var(--aurora-fg4)] font-normal hidden sm:inline">
                  · {p.tagline}
                </span>
              </Link>
            );
          })}
        </div>

        <div className="hidden lg:flex items-center gap-2 text-[10px] font-medium text-[var(--aurora-fg4)] shrink-0">
          <span>记忆输入</span>
          <span className="opacity-40">→</span>
          <span>提炼</span>
          <span className="opacity-40">→</span>
          <span className="text-[var(--aurora-accent)] font-semibold">画像注入</span>
          <span className="opacity-40">→</span>
          <span>技能固化</span>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full mb-6 rounded-2xl p-4 sm:p-5 border border-[var(--aurora-border)] bg-[var(--aurora-surface)] shadow-xs transition-all">
      {/* Header Info */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 mb-3 border-b border-[var(--aurora-border)]">
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-xl flex items-center justify-center"
            style={{ background: "var(--aurora-accent-soft)", color: "var(--aurora-accent)" }}
          >
            <Icon name="sparkles" size={17} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm sm:text-base font-bold text-[var(--aurora-fg1)] tracking-tight">
                认知大脑自进化中枢
              </h2>
              <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-[var(--aurora-chip)] text-[var(--aurora-fg3)]">
                三维闭环
              </span>
            </div>
            <p className="text-xs text-[var(--aurora-fg3)] mt-0.5">
              从日常事实中提炼记忆，沉淀个性化行为铁律，衍生专业自动化技能
            </p>
          </div>
        </div>

        {/* Quick Lifecycle Legend */}
        <div className="hidden lg:flex items-center gap-1.5 text-[11px] text-[var(--aurora-fg4)] bg-[var(--aurora-chip)] px-3 py-1.5 rounded-xl border border-[var(--aurora-border)]">
          <span className="font-semibold text-[var(--aurora-fg2)]">进化流向：</span>
          <span>记忆输入</span>
          <span className="opacity-40">→</span>
          <span>夜间梦境提炼</span>
          <span className="opacity-40">→</span>
          <span>画像跨端注入</span>
          <span className="opacity-40">→</span>
          <span>技能固化</span>
        </div>
      </div>

      {/* 3 Pillars Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {pillars.map((p) => {
          const isActive = currentTab === p.id;
          return (
            <Link
              key={p.id}
              href={p.href}
              className={`group relative p-3.5 sm:p-4 rounded-xl transition-all border block ${
                isActive
                  ? "bg-[var(--aurora-surface-solid)] shadow-sm scale-[1.01]"
                  : "bg-transparent hover:bg-[var(--aurora-surface-mute)] border-[var(--aurora-border)] opacity-85 hover:opacity-100"
              }`}
              style={{
                borderColor: isActive ? p.borderSoft : undefined,
                boxShadow: isActive ? `0 4px 20px -4px ${p.bgSoft}` : undefined,
              }}
            >
              {/* Active Marker Line */}
              {isActive && (
                <div
                  className="absolute top-0 left-4 right-4 h-[2.5px] rounded-b-md"
                  style={{ backgroundColor: p.color }}
                />
              )}

              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center transition-transform group-hover:scale-110"
                    style={{
                      background: isActive ? p.bgSoft : "var(--aurora-chip)",
                      color: isActive ? p.color : "var(--aurora-fg3)",
                    }}
                  >
                    <Icon name={p.icon} size={15} />
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold text-[var(--aurora-fg1)]">
                        {p.title}
                      </span>
                      <span
                        className="text-[10px] font-medium px-1.5 py-0.2 rounded"
                        style={{
                          backgroundColor: isActive ? p.bgSoft : "var(--aurora-chip)",
                          color: isActive ? p.color : "var(--aurora-fg3)",
                        }}
                      >
                        {p.tagline}
                      </span>
                    </div>
                  </div>
                </div>

                {isActive && (
                  <span className="flex h-2 w-2 relative">
                    <span
                      className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                      style={{ backgroundColor: p.color }}
                    />
                    <span
                      className="relative inline-flex rounded-full h-2 w-2"
                      style={{ backgroundColor: p.color }}
                    />
                  </span>
                )}
              </div>

              <p className="text-[11.5px] text-[var(--aurora-fg3)] mt-2 leading-relaxed">
                {p.desc}
              </p>

              <div className="mt-3 pt-2 border-t border-[var(--aurora-border)] flex items-center justify-between text-[11px]">
                <span
                  className="font-mono text-[10.5px]"
                  style={{ color: isActive ? p.color : "var(--aurora-fg4)" }}
                >
                  {p.badge}
                </span>
                <span
                  className={`flex items-center gap-0.5 transition-transform group-hover:translate-x-0.5 ${
                    isActive ? "font-semibold" : "text-[var(--aurora-fg4)]"
                  }`}
                  style={{ color: isActive ? p.color : undefined }}
                >
                  {isActive ? "当前查看" : "进入查看"}
                  <Icon name="chevron_right" size={11} />
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
