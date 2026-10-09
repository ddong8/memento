"use client";

import { useEffect, useState, useTransition } from "react";
import { api, type AgentQuotasResponse, type ToolQuotaInfo } from "@/lib/api-client";
import { Glass, Btn, Chip } from "@/components/aurora/primitives";
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
    return `${hours} 小时 ${remMins} 分钟后重置`;
  } catch {
    return "";
  }
}

export function AgentQuotaPopover({ deviceId, isOpen, onClose }: AgentQuotaPopoverProps) {
  const [data, setData] = useState<AgentQuotasResponse | null>(null);
  const [loading, setLoading] = useState(false);
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
          background: "rgba(0, 0, 0, 0.45)",
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
        }}
      />

      {/* Modal Dialog */}
      <Glass
        padding="0"
        radius={20}
        style={{
          position: "relative",
          width: "100%",
          maxWidth: "520px",
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 20px 48px rgba(0, 0, 0, 0.35)",
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
        <div style={{ padding: "18px 20px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
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
                    {agy?.account_email || agy?.account_name || "已关联本地服务"}
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

            {/* Quota Progress Bar */}
            {agy?.remaining_percent != null && (
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                  <span style={{ color: "var(--aurora-fg3)" }}>
                    主力模型配额 (Gemini 3.8 Flash)
                  </span>
                  <span style={{ fontWeight: 600, color: agy.remaining_percent > 30 ? "var(--aurora-accent)" : "#F59E0B" }}>
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
                      background: agy.remaining_percent > 30
                        ? "linear-gradient(90deg, #38BDF8, #818CF8)"
                        : "linear-gradient(90deg, #F59E0B, #EF4444)",
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
            )}

            {/* Models Details Accordion */}
            {agy?.models && agy.models.length > 0 && (
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
                    {agy.models.map((m, idx) => (
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
                          <span style={{ fontWeight: 600, color: m.remaining_percent > 30 ? "var(--aurora-accent)" : "#F59E0B" }}>
                            {m.remaining_percent}%
                          </span>
                        </div>
                      </div>
                    ))}
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
              gap: 10,
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
                    {claude?.account_email || "Anthropic 智能体"}
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

            <div style={{ fontSize: 12, color: "var(--aurora-fg3)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>订阅等级：{claude?.tier || "PRO"} 计划</span>
              <span style={{ color: "var(--aurora-fg4)" }}>5小时滑动窗口活跃</span>
            </div>
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
              gap: 10,
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
                    {codex?.account_email ? `${codex.account_name ? codex.account_name + " · " : ""}${codex.account_email}` : "Codex 智能体"}
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

            <div style={{ fontSize: 12, color: "var(--aurora-fg3)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>授权模式：OAuth ChatGPT Token</span>
              <span style={{ color: "var(--aurora-fg4)" }}>实时轮转正常</span>
            </div>
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
          <span>数据来源：被控设备驻留服务与原生语言服务通道</span>
          <span>{data?.updated_at ? `更新于 ${new Date(data.updated_at).toLocaleTimeString()}` : ""}</span>
        </div>
      </Glass>
    </div>
  );
}
