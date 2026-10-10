"use client";

import { useEffect, useState, useTransition } from "react";
import { api, type AgentQuotasResponse, type ToolQuotaInfo } from "@/lib/api-client";
import { Glass } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";

interface AgentQuotaPopoverProps {
  deviceId?: string;
  isOpen: boolean;
  onClose: () => void;
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
    if (hours < 24) return `${hours} 小时 ${remMins} 分钟后重置`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days} 天 ${remHours} 小时后重置`;
  } catch {
    return "";
  }
}

function getQuotaColor(percent: number): { text: string; gradient: string } {
  if (percent <= 15) {
    return {
      text: "#EF4444",
      gradient: "linear-gradient(90deg, #EF4444, #DC2626)",
    };
  }
  if (percent <= 35) {
    return {
      text: "#F59E0B",
      gradient: "linear-gradient(90deg, #F59E0B, #D97706)",
    };
  }
  return {
    text: "var(--aurora-accent, #38BDF8)",
    gradient: "linear-gradient(90deg, #38BDF8, #818CF8)",
  };
}

export function AgentQuotaPopover({ deviceId, isOpen, onClose }: AgentQuotaPopoverProps) {
  const [data, setData] = useState<AgentQuotasResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedAgy, setExpandedAgy] = useState(true);
  const [expandedClaude, setExpandedClaude] = useState(true);
  const [expandedCodex, setExpandedCodex] = useState(false);
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
    if (isOpen) {
      loadQuotas(false);
    }
  }, [isOpen, deviceId]);

  if (!isOpen) return null;

  const tools = data?.tools || {};
  const agy = tools.antigravity;
  const claude = tools.claude_code;
  const codex = tools.codex;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0, 0, 0, 0.5)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
        }}
      />

      {/* Modal Dialog */}
      <Glass
        padding="0"
        radius={20}
        style={{
          position: "relative",
          width: "100%",
          maxWidth: "540px",
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 24px 50px rgba(0, 0, 0, 0.45)",
          border: "1px solid var(--aurora-border)",
          background: "var(--aurora-surface)",
          zIndex: 10,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--aurora-border)",
            background: "rgba(255, 255, 255, 0.03)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 10,
                background: "linear-gradient(135deg, rgba(56, 189, 248, 0.2), rgba(168, 85, 247, 0.2))",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--aurora-accent)",
              }}
            >
              <Icon name="activity" size={17} />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "var(--aurora-fg1)" }}>
                AI 工具订阅与额度监控
              </div>
              <div style={{ fontSize: 11.5, color: "var(--aurora-fg4)", marginTop: 2 }}>
                {data?.device_name ? `探测设备: ${data.device_name}` : "实时监控各智能体额度与滑动窗口"}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
              <span>{refreshing ? "探测中..." : "刷新"}</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 30,
                height: 30,
                borderRadius: 8,
                background: "transparent",
                border: "none",
                color: "var(--aurora-fg3)",
                cursor: "pointer",
              }}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        </div>

        {/* Content list */}
        <div style={{ padding: "16px 20px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Tool Card: Google Antigravity */}
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
                    width: 30,
                    height: 30,
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
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)" }}>
                    Google Antigravity
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--aurora-fg3)", marginTop: 1 }}>
                    {agy?.account_email || agy?.account_name || (agy?.available ? "已关联本地服务" : "未检测到本地服务")}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    fontSize: 11,
                    padding: "2px 8px",
                    borderRadius: 999,
                    background: "rgba(59, 130, 246, 0.15)",
                    color: "#3B82F6",
                    fontWeight: 600,
                  }}
                >
                  {agy?.plan_name || "Google AI Pro"}
                </span>
                <span
                  style={{
                    fontSize: 10.5,
                    padding: "2px 7px",
                    borderRadius: 999,
                    background: agy?.available ? "rgba(34, 197, 94, 0.15)" : "rgba(239, 68, 68, 0.15)",
                    color: agy?.available ? "#22C55E" : "#EF4444",
                    fontWeight: 500,
                  }}
                >
                  {agy?.available ? "在线" : "未启动"}
                </span>
              </div>
            </div>

            {/* Error or Offline Alert */}
            {!agy?.available && (
              <div
                style={{
                  fontSize: 12,
                  color: "#EF4444",
                  background: "rgba(239, 68, 68, 0.08)",
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid rgba(239, 68, 68, 0.2)",
                }}
              >
                {agy?.error || "无法连接本地 Antigravity 语言服务，请确保已启动客户端并点击刷新。"}
              </div>
            )}

            {/* Quota Progress Bar */}
            {agy?.available && agy?.remaining_percent != null && (() => {
              const quotaColor = getQuotaColor(agy.remaining_percent);
              return (
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                    <span style={{ color: "var(--aurora-fg3)" }}>
                      主力模型配额 ({agy?.models?.[0]?.label || "Gemini 3.8 Flash"})
                    </span>
                    <span style={{ fontWeight: 600, color: quotaColor.text }}>
                      {agy.remaining_percent}% 剩余
                    </span>
                  </div>
                  <div
                    style={{
                      height: 7,
                      borderRadius: 999,
                      background: "rgba(255, 255, 255, 0.08)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${Math.min(100, Math.max(0, agy.remaining_percent))}%`,
                        borderRadius: 999,
                        background: quotaColor.gradient,
                        transition: "width 0.4s ease",
                      }}
                    />
                  </div>
                  {agy.reset_time && (
                    <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginTop: 5, textAlign: "right" }}>
                      ⏳ {formatRelativeReset(agy.reset_time)}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Antigravity Credits details */}
            {agy?.available && agy?.details && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: "rgba(0, 0, 0, 0.12)",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>Prompt Credits</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--aurora-fg2)" }}>
                    {agy.details.available_prompt_credits ?? "-"} / {agy.details.monthly_prompt_credits ?? "-"}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>Flow Credits</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--aurora-fg2)" }}>
                    {agy.details.available_flow_credits ?? "-"} / {agy.details.monthly_flow_credits ?? "-"}
                  </span>
                </div>
              </div>
            )}

            {/* Models Details Accordion */}
            {agy?.available && agy?.models && agy.models.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setExpandedAgy(!expandedAgy)}
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    fontSize: 11.5,
                    color: "var(--aurora-accent)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <span>{expandedAgy ? "收起全模型额度" : `查看全部 ${agy.models.length} 个模型阶梯配额`}</span>
                  <Icon name={expandedAgy ? "chevron_up" : "chevron_down"} size={12} />
                </button>

                {expandedAgy && (
                  <div
                    style={{
                      marginTop: 8,
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: "rgba(0, 0, 0, 0.15)",
                      maxHeight: "180px",
                      overflowY: "auto",
                    }}
                  >
                    {agy.models.map((m, idx) => {
                      const mc = getQuotaColor(m.remaining_percent);
                      return (
                        <div
                          key={idx}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            fontSize: 11.5,
                            padding: "2px 0",
                          }}
                        >
                          <span style={{ color: "var(--aurora-fg2)", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap", maxWidth: "260px" }}>
                            {m.label}
                          </span>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontWeight: 600, color: mc.text }}>
                              {m.remaining_percent}%
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Tool Card: Claude Code */}
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
                    width: 30,
                    height: 30,
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
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)" }}>
                    Claude Code
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--aurora-fg3)", marginTop: 1 }}>
                    {claude?.account_email || claude?.account_name || (claude?.available ? "已授权 Anthropic 智能体" : "未检测到本地凭据")}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    fontSize: 11,
                    padding: "2px 8px",
                    borderRadius: 999,
                    background: "rgba(217, 119, 6, 0.15)",
                    color: "#D97706",
                    fontWeight: 600,
                  }}
                >
                  {claude?.plan_name || "Claude Pro"}
                </span>
                <span
                  style={{
                    fontSize: 10.5,
                    padding: "2px 7px",
                    borderRadius: 999,
                    background: claude?.available ? "rgba(34, 197, 94, 0.15)" : "rgba(239, 68, 68, 0.15)",
                    color: claude?.available ? "#22C55E" : "#EF4444",
                    fontWeight: 500,
                  }}
                >
                  {claude?.available ? "已授权" : "未检测到"}
                </span>
              </div>
            </div>

            {/* Error or Offline Alert */}
            {!claude?.available && (
              <div
                style={{
                  fontSize: 12,
                  color: "#EF4444",
                  background: "rgba(239, 68, 68, 0.08)",
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid rgba(239, 68, 68, 0.2)",
                }}
              >
                {claude?.error || "未找到 Claude Code 登录凭据，请确认 CLI 已登录。"}
              </div>
            )}

            {/* Claude Code Sliding Window & Progress */}
            {claude?.available && claude?.remaining_percent != null && (() => {
              const quotaColor = getQuotaColor(claude.remaining_percent);
              const sevenDay = claude.details?.seven_day_utilization;
              const fiveHour = claude.details?.five_hour_utilization;
              const isCritical = claude.details?.severity === "critical" || (sevenDay != null && sevenDay >= 95);

              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {/* Critical badge */}
                  {isCritical && (
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "#EF4444",
                        background: "rgba(239, 68, 68, 0.12)",
                        border: "1px solid rgba(239, 68, 68, 0.3)",
                        padding: "6px 10px",
                        borderRadius: 6,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        fontWeight: 500,
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                      <span>7天滑动窗口用量已达极限 (已消耗 {sevenDay ?? 97}%)，面临速率限制</span>
                    </div>
                  )}

                  {/* Dual Sliding Windows */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 8,
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: "rgba(0, 0, 0, 0.12)",
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>7天滑动窗口已用</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: sevenDay != null && sevenDay > 85 ? "#EF4444" : "var(--aurora-fg2)" }}>
                        {sevenDay != null ? `${sevenDay}%` : "-"}
                      </span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>5小时会话窗口已用</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--aurora-fg2)" }}>
                        {fiveHour != null ? `${fiveHour}%` : "-"}
                      </span>
                    </div>
                  </div>

                  {/* Remaining bar */}
                  <div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                      <span style={{ color: "var(--aurora-fg3)" }}>综合剩余可用额度</span>
                      <span style={{ fontWeight: 600, color: quotaColor.text }}>
                        {claude.remaining_percent}% 剩余
                      </span>
                    </div>
                    <div
                      style={{
                        height: 7,
                        borderRadius: 999,
                        background: "rgba(255, 255, 255, 0.08)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${Math.min(100, Math.max(0, claude.remaining_percent))}%`,
                          borderRadius: 999,
                          background: quotaColor.gradient,
                          transition: "width 0.4s ease",
                        }}
                      />
                    </div>
                    {claude.reset_time && (
                      <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginTop: 5, textAlign: "right" }}>
                        ⏳ {formatRelativeReset(claude.reset_time)}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Models Details Accordion */}
            {claude?.available && claude?.models && claude.models.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setExpandedClaude(!expandedClaude)}
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    fontSize: 11.5,
                    color: "var(--aurora-accent)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <span>{expandedClaude ? "收起模型列表" : `查看支持模型 (${claude.models.length})`}</span>
                  <Icon name={expandedClaude ? "chevron_up" : "chevron_down"} size={12} />
                </button>

                {expandedClaude && (
                  <div
                    style={{
                      marginTop: 8,
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: "rgba(0, 0, 0, 0.15)",
                      maxHeight: "180px",
                      overflowY: "auto",
                    }}
                  >
                    {claude.models.map((m, idx) => {
                      const mc = getQuotaColor(m.remaining_percent);
                      return (
                        <div
                          key={idx}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            fontSize: 11.5,
                            padding: "2px 0",
                          }}
                        >
                          <span style={{ color: "var(--aurora-fg2)" }}>{m.label}</span>
                          <span style={{ fontWeight: 600, color: mc.text }}>
                            {m.remaining_percent}%
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Tool Card: OpenAI Codex */}
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
                    width: 30,
                    height: 30,
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
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)" }}>
                    OpenAI Codex
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--aurora-fg3)", marginTop: 1 }}>
                    {codex?.account_email ? `${codex.account_name ? codex.account_name + " · " : ""}${codex.account_email}` : (codex?.available ? "Codex 智能体" : "未检测到本地凭据")}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    fontSize: 11,
                    padding: "2px 8px",
                    borderRadius: 999,
                    background: "rgba(16, 185, 129, 0.15)",
                    color: "#10B981",
                    fontWeight: 600,
                  }}
                >
                  {codex?.plan_name || "ChatGPT Free"}
                </span>
                <span
                  style={{
                    fontSize: 10.5,
                    padding: "2px 7px",
                    borderRadius: 999,
                    background: codex?.available ? "rgba(34, 197, 94, 0.15)" : "rgba(239, 68, 68, 0.15)",
                    color: codex?.available ? "#22C55E" : "#EF4444",
                    fontWeight: 500,
                  }}
                >
                  {codex?.available ? "已授权" : "未配置"}
                </span>
              </div>
            </div>

            {/* Error or Offline Alert */}
            {!codex?.available && (
              <div
                style={{
                  fontSize: 12,
                  color: "#EF4444",
                  background: "rgba(239, 68, 68, 0.08)",
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid rgba(239, 68, 68, 0.2)",
                }}
              >
                {codex?.error || "未找到 OpenAI Codex 凭据，请确认 CLI 已登录。"}
              </div>
            )}

            {/* Codex Free or Pro Rate Details */}
            {codex?.available && (
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "rgba(0, 0, 0, 0.12)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12 }}>
                  <span style={{ color: "var(--aurora-fg3)" }}>配额计费模式</span>
                  <span style={{ fontWeight: 600, color: "var(--aurora-fg2)" }}>
                    {codex.remaining_percent != null ? `${codex.remaining_percent}% (固定额度)` : "动态速率限制 (Free)"}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "var(--aurora-fg4)", lineHeight: 1.4 }}>
                  {codex.remaining_percent != null
                    ? "按订阅周期固定分配算力配额。"
                    : "ChatGPT Free 订阅依据官方动态队列与滑动速率轮转，无静态百分比限制。"}
                </div>
              </div>
            )}

            {/* Models Details Accordion */}
            {codex?.available && codex?.models && codex.models.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setExpandedCodex(!expandedCodex)}
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    fontSize: 11.5,
                    color: "var(--aurora-accent)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <span>{expandedCodex ? "收起可用模型" : `查看可用模型 (${codex.models.length})`}</span>
                  <Icon name={expandedCodex ? "chevron_up" : "chevron_down"} size={12} />
                </button>

                {expandedCodex && (
                  <div
                    style={{
                      marginTop: 8,
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: "rgba(0, 0, 0, 0.15)",
                      maxHeight: "180px",
                      overflowY: "auto",
                    }}
                  >
                    {codex.models.map((m, idx) => (
                      <div
                        key={idx}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          fontSize: 11.5,
                          padding: "2px 0",
                        }}
                      >
                        <span style={{ color: "var(--aurora-fg2)" }}>{m.label}</span>
                        <span style={{ fontSize: 10.5, color: "var(--aurora-fg4)" }}>{m.model_id}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer info */}
        <div
          style={{
            padding: "10px 20px",
            background: "rgba(0, 0, 0, 0.1)",
            borderTop: "1px solid var(--aurora-border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 11,
            color: "var(--aurora-fg4)",
          }}
        >
          <span>数据来源：设备驻留探测进程与语言服务实时接口</span>
          <span>{data?.updated_at ? `更新于 ${new Date(data.updated_at).toLocaleTimeString()}` : ""}</span>
        </div>
      </Glass>
    </div>
  );
}
