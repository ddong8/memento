"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type PublicStats } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { BrandMark } from "@/components/aurora/BrandMark";

type StageScenario = "recall" | "dispatch" | "evolve";

const SCENARIOS: Record<
  StageScenario,
  {
    label: string;
    device: string;
    agent: "claude_code" | "antigravity" | "codex";
    agentName: string;
    prompt: string;
    trace: string[];
    answer: string;
    meta: string;
  }
> = {
  recall: {
    label: "跨工具记忆召回",
    device: "Mac Studio",
    agent: "claude_code",
    agentName: "Claude Code",
    prompt: "汇总上周在 Cursor 和 Antigravity 里定下来的数据库连接池与索引方案",
    trace: [
      "memory_context(\"memento\") -> 命中 6 条历史对话、2 份架构计划",
      "memory_check_rule -> 自动载入 4 条性能铁律与历史避坑记录",
    ],
    answer: "已对齐三端记录：连接池上限固定为 20，日历查询走 conversation_messages 真实消息部分索引（耗时从 806ms 降至 1.2ms），核心画像响应走 Redis 缓存。",
    meta: "BGE-M3 + 全文混合检索 · 47ms",
  },
  dispatch: {
    label: "跨设备远程调度",
    device: "Windows 工作站",
    agent: "codex",
    agentName: "Codex",
    prompt: "拉取最新分支、在 Windows 工作站跑完单机模式测试并回传日志",
    trace: [
      "device_dispatch(\"DESKTOP-WIN\") -> WebSocket 直连通道已建立",
      "run_tests -> 33 / 33 用例通过，单机 pgvector 扩展校验正常",
    ],
    answer: "Windows 端构建与单机数据库初始化测试全部通过，详细对比日志已同步至工作台，可直接在手机端或桌面端查看。",
    meta: "端到端实时流式回传 · 0 丢包",
  },
  evolve: {
    label: "夜间自进化沉淀",
    device: "全设备同步",
    agent: "antigravity",
    agentName: "Antigravity",
    prompt: "回顾今日排障过程，把重复踩坑固化为可复用技能和规则",
    trace: [
      "dreaming_consolidate -> 提炼 3 条新观察并压缩 18 条陈旧碎片",
      "skill_sync -> 生成部署验收 Skill 并写入 ~/.claude/skills",
    ],
    answer: "已完成夜间认知固化：新增 1 份可执行发布技能，更新 2 条常驻沟通与工程规则，并已通过增量同步下发至全部在线终端。",
    meta: "23:30 昼夜节律自动归档",
  },
};

export function Hero() {
  const { t } = useI18n();
  const { token, loading } = useAuth();
  const [stats, setStats] = useState<PublicStats | null>(null);
  const [scenario, setScenario] = useState<StageScenario>("recall");

  useEffect(() => {
    api.getPublicStats().then(setStats).catch(() => {});
  }, []);

  const current = SCENARIOS[scenario];

  return (
    <section
      style={{
        padding: "clamp(40px, 6vw, 72px) 20px 36px",
        maxWidth: 1120,
        margin: "0 auto",
      }}
    >
      {/* Centered editorial opening headline — zero decorative eyebrow chips */}
      <div style={{ textAlign: "center", maxWidth: 760, margin: "0 auto" }}>
        <h1
          style={{
            margin: 0,
            fontSize: "clamp(28px, 4.7vw, 52px)",
            fontWeight: 700,
            letterSpacing: "-0.036em",
            lineHeight: 1.14,
            color: "var(--aurora-fg1)",
            textWrap: "balance",
          }}
        >
          {t.landing.hero_title === "给你的 AI 工具建个共享大脑与全能工作台" ? (
            <>
              <span style={{ display: "inline-block" }}>给你的 AI 工具建个</span>
              <span style={{ display: "inline-block" }}>共享大脑与全能工作台</span>
            </>
          ) : (
            t.landing.hero_title
          )}
        </h1>
        <p
          style={{
            margin: "18px auto 28px",
            fontSize: "clamp(14.5px, 1.75vw, 16.5px)",
            color: "var(--aurora-fg3)",
            letterSpacing: "-0.01em",
            lineHeight: 1.62,
            maxWidth: 620,
            textWrap: "balance",
          }}
        >
          {t.landing.hero_sub}
        </p>

        {/* Single primary CTA + quiet architectural secondary link */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 20,
            flexWrap: "wrap",
          }}
        >
          {!loading && (
            <Link href={token ? "/ask" : "/auth/login"} style={{ textDecoration: "none" }}>
              <button type="button" className="aurora-btn aurora-btn-lg">
                {token ? t.landing.cta_dashboard : t.landing.cta_login}
                <Icon name="arrow_right" size={15} />
              </button>
            </Link>
          )}
          <a
            href="#install"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 14,
              fontWeight: 500,
              color: "var(--aurora-fg2)",
              textDecoration: "none",
              padding: "8px 4px",
              transition: "color 150ms ease",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--aurora-accent)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--aurora-fg2)")}
          >
            <Icon name="terminal" size={14} />
            <span>{t.landing.cta_install}</span>
          </a>
        </div>
      </div>

      {/* Interactive Product Stage — macOS frosted glass container anchoring the opening viewport */}
      <div
        className="aurora-glass-panel"
        style={{
          marginTop: "clamp(32px, 4.5vw, 48px)",
          borderRadius: 18,
          overflow: "hidden",
        }}
      >
        {/* Stage Header Chrome */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            padding: "12px 18px",
            borderBottom: "1px solid var(--aurora-border)",
            background: "var(--aurora-surface-mute)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {(Object.keys(SCENARIOS) as StageScenario[]).map((key) => {
              const active = scenario === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setScenario(key)}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 8,
                    border: active ? "1px solid var(--aurora-border-strong)" : "1px solid transparent",
                    background: active ? "var(--aurora-surface-solid)" : "transparent",
                    color: active ? "var(--aurora-fg1)" : "var(--aurora-fg3)",
                    fontSize: 13,
                    fontWeight: active ? 600 : 500,
                    cursor: "pointer",
                    transition: "background-color 150ms ease, color 150ms ease, border-color 150ms ease",
                  }}
                >
                  {SCENARIOS[key].label}
                </button>
              );
            })}
          </div>

          {/* Real live instance telemetry integrated cleanly into the console header */}
          {stats ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                fontSize: 12.5,
                color: "var(--aurora-fg3)",
                fontVariantNumeric: "tabular-nums",
                flexWrap: "wrap",
              }}
            >
              <span>
                <strong style={{ color: "var(--aurora-fg1)", fontWeight: 600 }}>{stats.total_documents.toLocaleString()}</strong>{" "}
                {t.landing.stats_files}
              </span>
              <span style={{ color: "var(--aurora-fg5)" }}>/</span>
              <span>
                <strong style={{ color: "var(--aurora-fg1)", fontWeight: 600 }}>{stats.total_devices.toLocaleString()}</strong>{" "}
                {t.landing.stats_devices}
              </span>
              <span style={{ color: "var(--aurora-fg5)" }}>/</span>
              <span>
                <strong style={{ color: "var(--aurora-fg1)", fontWeight: 600 }}>{stats.total_messages.toLocaleString()}</strong>{" "}
                {t.landing.stats_messages}
              </span>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {(["claude_code", "codex", "antigravity", "workbuddy", "cursor"] as const).map((id) => (
                <BrandMark key={id} id={id} size={15} colored />
              ))}
            </div>
          )}
        </div>

        {/* Stage Body — 2-column architectural workspace preview */}
        <div className="grid grid-cols-1 md:grid-cols-[240px_1fr]">
          {/* Left Context Rail */}
          <div
            className="border-b md:border-b-0 md:border-r"
            style={{
              borderColor: "var(--aurora-border)",
              padding: "18px 16px",
              display: "flex",
              flexDirection: "column",
              gap: 16,
              background: "var(--aurora-surface-mute)",
            }}
          >
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--aurora-fg3)", marginBottom: 10 }}>
                已接入智能体
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {[
                  { id: "claude_code", name: "Claude Code", state: "MCP 已连接" },
                  { id: "antigravity", name: "Antigravity", state: "实时采集" },
                  { id: "codex", name: "Codex", state: "会话同步" },
                  { id: "workbuddy", name: "WorkBuddy", state: "产物联动" },
                ].map((item) => {
                  const isCurrent = item.id === current.agent;
                  return (
                    <div
                      key={item.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        padding: "7px 10px",
                        borderRadius: 8,
                        background: isCurrent ? "var(--aurora-surface-solid)" : "transparent",
                        border: isCurrent ? "1px solid var(--aurora-border-strong)" : "1px solid transparent",
                      }}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: isCurrent ? 600 : 500, color: "var(--aurora-fg1)" }}>
                        <BrandMark id={item.id} size={14} colored />
                        {item.name}
                      </span>
                      <span style={{ fontSize: 12, color: isCurrent ? "var(--aurora-accent)" : "var(--aurora-fg4)" }}>
                        {item.state}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ paddingTop: 12, borderTop: "1px solid var(--aurora-border)", fontSize: 12.5, color: "var(--aurora-fg3)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>执行终端</span>
              <span style={{ color: "var(--aurora-fg1)", fontWeight: 500 }}>{current.device}</span>
            </div>
          </div>

          {/* Right Conversation & Recall Stage */}
          <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 14, textAlign: "left" }}>
            {/* User prompt bubble (matches actual Ask UserBubble style) */}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <div
                style={{
                  background: "var(--aurora-accent-soft)",
                  color: "var(--aurora-fg1)",
                  padding: "10px 14px",
                  borderRadius: 12,
                  fontSize: 14,
                  lineHeight: 1.55,
                  maxWidth: "88%",
                }}
              >
                {current.prompt}
              </div>
            </div>

            {/* Thinking / MCP recall trace */}
            <div
              style={{
                borderRadius: 10,
                border: "1px solid var(--aurora-border)",
                background: "var(--aurora-thinking-bg)",
                padding: "10px 14px",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12.5 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600, color: "var(--aurora-fg2)" }}>
                  <BrandMark id={current.agent} size={13} colored />
                  {current.agentName} · 认知上下文已注入
                </span>
                <span style={{ color: "var(--aurora-fg4)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                  {current.meta}
                </span>
              </div>
              {current.trace.map((line) => (
                <div
                  key={line}
                  style={{
                    fontSize: 12.5,
                    fontFamily: "var(--font-mono)",
                    color: "var(--aurora-fg3)",
                    lineHeight: 1.5,
                    overflowWrap: "anywhere",
                  }}
                >
                  {line}
                </div>
              ))}
            </div>

            {/* Assistant reply */}
            <div style={{ fontSize: 14, lineHeight: 1.65, color: "var(--aurora-fg1)" }}>
              {current.answer}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
