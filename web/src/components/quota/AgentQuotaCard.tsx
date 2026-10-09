"use client";

import { useEffect, useState, useTransition } from "react";
import { api, type AgentQuotasResponse } from "@/lib/api-client";
import { Glass, Btn } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";

interface AgentQuotaCardProps {
  deviceId?: string;
}

function formatRelativeReset(isoStr?: string | null): string {
  if (!isoStr) return "";
  try {
    const d = new Date(isoStr);
    const diffMs = d.getTime() - Date.now();
    if (diffMs <= 0) return "即将重置";
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `${mins} 分钟后重置`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hours} 小时 ${remMins} 分钟后重置`;
  } catch {
    return "";
  }
}

export function AgentQuotaCard({ deviceId }: AgentQuotaCardProps) {
  const [data, setData] = useState<AgentQuotasResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedAgy, setExpandedAgy] = useState(false);
  const [, startTransition] = useTransition();

  const loadQuotas = async (forceRefresh = false) => {
    try {
      if (forceRefresh) setRefreshing(true);
      else setLoading(true);

      const res = forceRefresh
        ? await api.refreshAgentQuotas(deviceId)
        : await api.getAgentQuotas(deviceId);

      startTransition(() => {
        setData(res);
      });
    } catch (e) {
      console.error("Failed to load agent quotas:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadQuotas(false);
  }, [deviceId]);

  const tools = data?.tools || {};
  const agy = tools.antigravity;
  const claude = tools.claude_code;
  const codex = tools.codex;

  return (
    <Glass className="p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5 pb-4 border-b border-[var(--aurora-border)]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-500/20 to-purple-500/20 flex items-center justify-center text-[var(--aurora-accent)] shadow-sm">
            <Icon name="activity" size={20} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[var(--aurora-fg1)]">
                AI 工具原生订阅与额度监控
              </h3>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 font-medium">
                Live 探测
              </span>
            </div>
            <p className="text-xs text-[var(--aurora-fg4)] mt-0.5">
              {data?.device_name ? `当前探测设备：${data.device_name}` : "实时监控各智能体额度与滑动窗口"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-end sm:self-auto">
          <button
            type="button"
            onClick={() => loadQuotas(true)}
            disabled={refreshing || loading}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "6px 12px",
              borderRadius: 8,
              background: "var(--aurora-chip)",
              border: "1px solid var(--aurora-border)",
              color: "var(--aurora-fg2)",
              fontSize: 12,
              cursor: refreshing ? "not-allowed" : "pointer",
              transition: "all 0.15s ease",
            }}
            title="重新探测并刷新各工具配额"
          >
            <Icon
              name="refresh"
              size={13}
              style={{
                animation: refreshing ? "spin 1s linear infinite" : "none",
                color: refreshing ? "var(--aurora-accent)" : "inherit",
              }}
            />
            <span>{refreshing ? "探测中..." : "刷新额度"}</span>
          </button>
        </div>
      </div>

      {/* Grid of Tools */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Antigravity Card */}
        <div
          style={{
            padding: "14px 16px",
            borderRadius: 14,
            border: "1px solid var(--aurora-border)",
            background: "var(--aurora-card)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: "rgba(59, 130, 246, 0.12)",
                  color: "#3B82F6",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: 14,
                }}
              >
                A
              </div>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--aurora-fg1)" }}>
                  Google Antigravity
                </div>
                <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginTop: 1 }}>
                  {agy?.account_email || agy?.account_name || "已关联本地服务"}
                </div>
              </div>
            </div>

            <span
              style={{
                fontSize: 10.5,
                padding: "2px 7px",
                borderRadius: 999,
                background: "rgba(59, 130, 246, 0.15)",
                color: "#3B82F6",
                fontWeight: 600,
              }}
            >
              {agy?.plan_name || "Google AI Pro"}
            </span>
          </div>

          {/* Quota Progress */}
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11.5, marginBottom: 5 }}>
              <span style={{ color: "var(--aurora-fg3)" }}>Gemini 3.8 Flash (High)</span>
              <span style={{ fontWeight: 600, color: (agy?.remaining_percent ?? 100) > 30 ? "var(--aurora-accent)" : "#F59E0B" }}>
                {agy?.remaining_percent ?? 100}% 剩余
              </span>
            </div>
            <div
              style={{
                height: 6,
                borderRadius: 999,
                background: "rgba(255, 255, 255, 0.08)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${Math.min(100, Math.max(0, agy?.remaining_percent ?? 100))}%`,
                  borderRadius: 999,
                  background: (agy?.remaining_percent ?? 100) > 30
                    ? "linear-gradient(90deg, #38BDF8, #818CF8)"
                    : "linear-gradient(90deg, #F59E0B, #EF4444)",
                  transition: "width 0.4s ease",
                }}
              />
            </div>
            {agy?.reset_time && (
              <div style={{ fontSize: 10.5, color: "var(--aurora-fg4)", marginTop: 4, textAlign: "right" }}>
                ⏳ {formatRelativeReset(agy.reset_time)}
              </div>
            )}
          </div>

          {/* Model accordion */}
          {agy?.models && agy.models.length > 0 && (
            <div style={{ borderTop: "1px dashed var(--aurora-border)", paddingTop: 8, marginTop: 2 }}>
              <button
                type="button"
                onClick={() => setExpandedAgy(!expandedAgy)}
                style={{
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  fontSize: 11,
                  color: "var(--aurora-accent)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <span>{expandedAgy ? "收起明细" : `查看 ${agy.models.length} 个模型额度`}</span>
                <Icon name={expandedAgy ? "chevron_up" : "chevron_down"} size={11} />
              </button>

              {expandedAgy && (
                <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4, maxHeight: "140px", overflowY: "auto" }}>
                  {agy.models.map((m, idx) => (
                    <div key={idx} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--aurora-fg3)" }}>
                      <span style={{ maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {m.label}
                      </span>
                      <span style={{ fontWeight: 600, color: m.remaining_percent > 30 ? "var(--aurora-accent)" : "#F59E0B" }}>
                        {m.remaining_percent}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Claude Code Card */}
        <div
          style={{
            padding: "14px 16px",
            borderRadius: 14,
            border: "1px solid var(--aurora-border)",
            background: "var(--aurora-card)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: "rgba(217, 119, 6, 0.12)",
                  color: "#D97706",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: 14,
                }}
              >
                C
              </div>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--aurora-fg1)" }}>
                  Claude Code
                </div>
                <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginTop: 1 }}>
                  {claude?.account_email || "Anthropic 智能体"}
                </div>
              </div>
            </div>

            <span
              style={{
                fontSize: 10.5,
                padding: "2px 7px",
                borderRadius: 999,
                background: "rgba(217, 119, 6, 0.15)",
                color: "#D97706",
                fontWeight: 600,
              }}
            >
              {claude?.plan_name || "Claude Pro"}
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 11.5 }}>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--aurora-fg3)" }}>
              <span>授权状态</span>
              <span style={{ color: claude?.available ? "#22C55E" : "var(--aurora-fg4)", fontWeight: 500 }}>
                {claude?.available ? "✓ 正常登录授权" : "未检测到凭证"}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--aurora-fg3)" }}>
              <span>订阅计划</span>
              <span style={{ color: "var(--aurora-fg2)", fontWeight: 500 }}>{claude?.tier || "PRO"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--aurora-fg3)" }}>
              <span>限流监控</span>
              <span style={{ color: "var(--aurora-fg4)" }}>5小时滑动窗口利用中</span>
            </div>
          </div>
        </div>

        {/* OpenAI Codex Card */}
        <div
          style={{
            padding: "14px 16px",
            borderRadius: 14,
            border: "1px solid var(--aurora-border)",
            background: "var(--aurora-card)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: "rgba(16, 185, 129, 0.12)",
                  color: "#10B981",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: 14,
                }}
              >
                O
              </div>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--aurora-fg1)" }}>
                  OpenAI Codex
                </div>
                <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginTop: 1 }}>
                  {codex?.account_email ? `${codex.account_name ? codex.account_name + " · " : ""}${codex.account_email}` : "Codex 智能体"}
                </div>
              </div>
            </div>

            <span
              style={{
                fontSize: 10.5,
                padding: "2px 7px",
                borderRadius: 999,
                background: "rgba(16, 185, 129, 0.15)",
                color: "#10B981",
                fontWeight: 600,
              }}
            >
              {codex?.plan_name || "ChatGPT Free"}
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 11.5 }}>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--aurora-fg3)" }}>
              <span>授权状态</span>
              <span style={{ color: codex?.available ? "#22C55E" : "var(--aurora-fg4)", fontWeight: 500 }}>
                {codex?.available ? "✓ 正常登录授权" : "未检测到凭证"}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--aurora-fg3)" }}>
              <span>订阅计划</span>
              <span style={{ color: "var(--aurora-fg2)", fontWeight: 500 }}>{codex?.tier || "FREE"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--aurora-fg3)" }}>
              <span>协议连接</span>
              <span style={{ color: "var(--aurora-fg4)" }}>OAuth 令牌自动续签</span>
            </div>
          </div>
        </div>
      </div>
    </Glass>
  );
}
