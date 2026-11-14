"use client";

import { useEffect, useState, useTransition, useMemo } from "react";
import { api, type AgentQuotasResponse, type ToolQuotaInfo } from "@/lib/api-client";
import { Glass } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";
import { BrandMark } from "@/components/aurora/BrandMark";
import { showInAppToast } from "@/lib/native-notify";

export type QuotaToolKey = "antigravity" | "claude_code" | "codex" | "workbuddy";

export const DEFAULT_QUOTA_TOOLS_ORDER: QuotaToolKey[] = [
  "antigravity",
  "claude_code",
  "codex",
  "workbuddy",
];

export function normalizeToolKey(tool?: string | null): QuotaToolKey | null {
  if (!tool) return null;
  const t = tool.toLowerCase().trim();
  if (t === "antigravity" || t === "agy" || t === "ai") return "antigravity";
  if (t === "claude" || t === "claude_code" || t === "claudecode") return "claude_code";
  if (t === "codex" || t === "openai" || t === "openai_codex") return "codex";
  if (t === "workbuddy" || t === "codebuddy") return "workbuddy";
  return null;
}

export function resolveQuotaToolsOrder(
  activeTool?: string | null,
  recentTools?: (string | null | undefined)[]
): QuotaToolKey[] {
  const normalizedActive = normalizeToolKey(activeTool);
  const result: QuotaToolKey[] = [];

  if (normalizedActive) {
    result.push(normalizedActive);
  }

  if (recentTools && Array.isArray(recentTools)) {
    for (const r of recentTools) {
      const norm = normalizeToolKey(r);
      if (norm && !result.includes(norm)) {
        result.push(norm);
      }
    }
  }

  for (const def of DEFAULT_QUOTA_TOOLS_ORDER) {
    if (!result.includes(def)) {
      result.push(def);
    }
  }

  return result;
}

export interface AgentQuotaPopoverProps {
  deviceId?: string;
  isOpen: boolean;
  onClose: () => void;
  initialData?: AgentQuotasResponse | null;
  onDataChange?: (data: AgentQuotasResponse) => void;
  activeTool?: string;
  recentTools?: string[];
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

function getQuotaColor(percent?: number | null): { text: string; gradient: string } {
  if (percent == null) {
    return {
      text: "var(--aurora-fg2)",
      gradient: "linear-gradient(90deg, #64748B, #94A3B8)",
    };
  }
  if (percent <= 15) {
    return {
      text: "#DC2626",
      gradient: "linear-gradient(90deg, #EF4444, #DC2626)",
    };
  }
  if (percent <= 35) {
    return {
      text: "#D97706",
      gradient: "linear-gradient(90deg, #F59E0B, #D97706)",
    };
  }
  return {
    text: "var(--aurora-accent, #6D28D9)",
    gradient: "linear-gradient(90deg, #38BDF8, #818CF8)",
  };
}

const CACHED_QUOTA_KEY = "memento_agent_quotas_cache";

function getCachedQuotas(deviceId?: string): AgentQuotasResponse | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(deviceId ? `${CACHED_QUOTA_KEY}_${deviceId}` : CACHED_QUOTA_KEY) || localStorage.getItem(CACHED_QUOTA_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {}
  return null;
}

export function AgentQuotaPopover({
  deviceId,
  isOpen,
  onClose,
  initialData,
  onDataChange,
  activeTool,
  recentTools,
}: AgentQuotaPopoverProps) {
  const [data, setData] = useState<AgentQuotasResponse | null>(() => initialData || getCachedQuotas(deviceId));
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedMap, setExpandedMap] = useState<Record<QuotaToolKey, boolean>>({
    antigravity: true,
    claude_code: true,
    codex: false,
    workbuddy: false,
  });
  const [, startTransition] = useTransition();

  const normalizedActive = normalizeToolKey(activeTool);
  const toolsOrder = useMemo(
    () => resolveQuotaToolsOrder(activeTool, recentTools),
    [activeTool, recentTools]
  );

  // Auto-expand current active tool when popover opens or active tool changes
  useEffect(() => {
    if (isOpen && normalizedActive) {
      setExpandedMap((prev) => ({
        ...prev,
        [normalizedActive]: true,
      }));
    }
  }, [isOpen, normalizedActive]);

  // Sync initialData if provided from parent
  useEffect(() => {
    if (initialData) {
      setData(initialData);
    }
  }, [initialData]);

  // Support closing dialog via ESC key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const allExpanded = Object.values(expandedMap).every(Boolean);
  const toggleAll = () => {
    const next = !allExpanded;
    setExpandedMap({
      antigravity: next,
      claude_code: next,
      codex: next,
      workbuddy: next,
    });
  };

  const loadQuotas = async (forceRefresh = false) => {
    try {
      if (forceRefresh) {
        setRefreshing(true);
        showInAppToast("正在校准 AI 额度", "后台静默探活各 Agent 最新配额...");
      } else if (!data) {
        setLoading(true);
      }

      const res = forceRefresh
        ? await api.refreshAgentQuotas(deviceId)
        : await api.getAgentQuotas(deviceId);

      startTransition(() => {
        setData(res);
        onDataChange?.(res);
        try {
          const key = deviceId ? `${CACHED_QUOTA_KEY}_${deviceId}` : CACHED_QUOTA_KEY;
          localStorage.setItem(key, JSON.stringify(res));
          localStorage.setItem(CACHED_QUOTA_KEY, JSON.stringify(res));
        } catch {}
      });
      if (forceRefresh) {
        showInAppToast("AI 额度已就绪", "已获取最新 Agent 订阅与模型配额");
      }
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
  const workbuddy = tools.workbuddy;

  const getCardStyle = (toolKey: QuotaToolKey) => {
    const isCurrentActive = toolKey === normalizedActive;
    return {
      padding: "14px 16px",
      borderRadius: 14,
      border: isCurrentActive
        ? "1.5px solid var(--aurora-accent, #6366F1)"
        : "1px solid var(--aurora-border)",
      background: "var(--aurora-card)",
      boxShadow: isCurrentActive
        ? "0 0 0 1px rgba(99, 102, 241, 0.22), 0 4px 16px -2px rgba(99, 102, 241, 0.14)"
        : undefined,
      display: "flex",
      flexDirection: "column" as const,
      gap: 12,
      transition: "all 0.2s ease",
    };
  };

  const renderActiveBadge = (toolKey: QuotaToolKey) => {
    if (toolKey !== normalizedActive) return null;
    return (
      <span
        className="px-2 py-0.5 rounded-full text-[10.5px] font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
        style={{
          background: "rgba(99, 102, 241, 0.12)",
          color: "var(--aurora-accent, #6366F1)",
          border: "1px solid rgba(99, 102, 241, 0.3)",
        }}
        title="当前会话正在使用的智能体工具"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse shrink-0" />
        当前会话使用
      </span>
    );
  };

  const renderAntigravityCard = () => (
    <div key="antigravity" style={getCardStyle("antigravity")}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1, overflow: "hidden" }}>
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
              flexShrink: 0,
            }}
          >
            A
          </div>
          <div style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              Google Antigravity
            </div>
            <div style={{ fontSize: 11.5, color: "var(--aurora-fg3)", marginTop: 1, display: "flex", alignItems: "center", gap: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agy?.account_email || agy?.account_name || (agy?.available ? "已关联本地服务" : "未检测到本地服务")}</span>
              {agy?.probe_source && (
                <span style={{ fontSize: 10, color: "var(--aurora-fg4)", flexShrink: 0 }}>· 📡 {agy.probe_source}</span>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {renderActiveBadge("antigravity")}
          {agy?.available ? (
            <span className="quota-badge-blue px-2.5 py-0.5 rounded-full text-[11px] font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0" title="本地服务在线">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
              <span>{agy?.plan_name || "Google AI Pro"}</span>
              <span className="text-[10px] font-normal opacity-75 hidden sm:inline">· 在线</span>
            </span>
          ) : (
            <span className="quota-badge-neutral px-2.5 py-0.5 rounded-full text-[11px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 text-red-500" title={agy?.error || "服务未启动"}>
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
              未启动
            </span>
          )}
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
        const primaryModel = agy?.models?.find((m) => m.remaining_percent != null) || agy?.models?.[0];
        return (
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
              <span style={{ color: "var(--aurora-fg3)" }}>
                主力模型配额 ({primaryModel?.label || "Gemini 3.8 Flash"})
              </span>
              <span style={{ fontWeight: 600, color: quotaColor.text }}>
                {agy.remaining_percent}% 剩余
              </span>
            </div>
            <div
              style={{
                height: 7,
                borderRadius: 999,
                background: "var(--aurora-chip)",
                border: "1px solid var(--aurora-border)",
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
            background: "var(--aurora-chip)",
            border: "1px solid var(--aurora-border)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 11, color: "var(--aurora-fg3)" }}>Prompt Credits</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--aurora-fg1)" }}>
              {agy.details.available_prompt_credits ?? "-"} / {agy.details.monthly_prompt_credits ?? "-"}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 11, color: "var(--aurora-fg3)" }}>Flow Credits</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--aurora-fg1)" }}>
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
            onClick={() => setExpandedMap((prev) => ({ ...prev, antigravity: !prev.antigravity }))}
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
            <span>{expandedMap.antigravity ? "收起全模型额度" : `查看全部 ${agy.models.length} 个模型阶梯配额`}</span>
            <Icon name={expandedMap.antigravity ? "chevron_up" : "chevron_down"} size={12} />
          </button>

          {expandedMap.antigravity && (
            <div
              style={{
                marginTop: 8,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "8px 10px",
                borderRadius: 8,
                background: "var(--aurora-chip)",
                border: "1px solid var(--aurora-border)",
                maxHeight: "180px",
                overflowY: "auto",
              }}
            >
              {agy.models.map((m, idx) => {
                return (
                  <div
                    key={idx}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      fontSize: 11.5,
                      padding: "3px 0",
                    }}
                  >
                    <span style={{ color: "var(--aurora-fg1)", fontWeight: 500, textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap", maxWidth: "260px" }}>
                      {m.label}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {m.remaining_percent != null ? (
                        <span className="quota-badge-blue px-2 py-0.5 rounded text-[11px] font-semibold">
                          {m.status_text || `${m.remaining_percent}%`}
                        </span>
                      ) : (
                        <span className="quota-badge-neutral px-2 py-0.5 rounded text-[10.5px] font-medium">
                          {m.status_text || "无配额限制"}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const renderClaudeCodeCard = () => (
    <div key="claude_code" style={getCardStyle("claude_code")}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1, overflow: "hidden" }}>
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
              flexShrink: 0,
            }}
          >
            C
          </div>
          <div style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              Claude Code
            </div>
            <div style={{ fontSize: 11.5, color: "var(--aurora-fg3)", marginTop: 1, display: "flex", alignItems: "center", gap: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{claude?.account_email || claude?.account_name || (claude?.available ? "已授权 Anthropic 智能体" : "未检测到本地凭据")}</span>
              {claude?.probe_source && (
                <span style={{ fontSize: 10, color: "var(--aurora-fg4)", flexShrink: 0 }}>· 📡 {claude.probe_source}</span>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {renderActiveBadge("claude_code")}
          {claude?.available ? (
            <span className="quota-badge-amber px-2.5 py-0.5 rounded-full text-[11px] font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0" title="已完成授权">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
              <span>{claude?.plan_name || "Claude Pro"}</span>
              <span className="text-[10px] font-normal opacity-75 hidden sm:inline">· 已授权</span>
            </span>
          ) : (
            <span className="quota-badge-neutral px-2.5 py-0.5 rounded-full text-[11px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 text-red-500" title={claude?.error || "未检测到凭证"}>
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
              未检测到
            </span>
          )}
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
      {claude?.available && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {claude.remaining_percent != null ? (() => {
            const quotaColor = getQuotaColor(claude.remaining_percent);
            const sevenDay = claude.details?.seven_day_utilization;
            const fiveHour = claude.details?.five_hour_utilization;
            const isCritical = claude.details?.severity === "critical" || (sevenDay != null && sevenDay >= 95);

            return (
              <>
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
                    <span>滑动窗口用量已达瓶颈 (5小时已用 {fiveHour ?? 0}%, 7天已用 {sevenDay ?? 0}%)</span>
                  </div>
                )}

                {/* Dual Sliding Windows */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 8,
                    padding: "10px 12px",
                    borderRadius: 10,
                    background: "var(--aurora-chip)",
                    border: "1px solid var(--aurora-border)",
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={{ fontSize: 11, color: "var(--aurora-fg3)" }}>7天滑动窗口 (周额度)</span>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: sevenDay != null && sevenDay > 85 ? "#EF4444" : "var(--aurora-fg1)" }}>
                        {sevenDay != null ? `已用 ${sevenDay}%` : "-"}
                      </span>
                      {sevenDay != null && (
                        <span style={{ fontSize: 11, color: "var(--aurora-fg3)" }}>
                          (剩 {Math.max(0, 100 - sevenDay)}%)
                        </span>
                      )}
                    </div>
                    {claude.details?.seven_day_resets_at && (
                      <span style={{ fontSize: 10.5, color: "var(--aurora-fg3)", marginTop: 2 }}>
                        ⏳ {formatRelativeReset(claude.details.seven_day_resets_at)}
                      </span>
                    )}
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={{ fontSize: 11, color: "var(--aurora-fg3)" }}>5小时会话窗口 (速率)</span>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: fiveHour != null && fiveHour > 85 ? "#EF4444" : "var(--aurora-fg1)" }}>
                        {fiveHour != null ? `已用 ${fiveHour}%` : "-"}
                      </span>
                      {fiveHour != null && (
                        <span style={{ fontSize: 11, color: "var(--aurora-fg3)" }}>
                          (剩 {Math.max(0, 100 - fiveHour)}%)
                        </span>
                      )}
                    </div>
                    {claude.details?.five_hour_resets_at && (
                      <span style={{ fontSize: 10.5, color: "var(--aurora-fg3)", marginTop: 2 }}>
                        ⏳ {formatRelativeReset(claude.details.five_hour_resets_at)}
                      </span>
                    )}
                  </div>
                </div>

                {/* Remaining bar */}
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                    <span style={{ color: "var(--aurora-fg3)" }}>综合瓶颈可用额度 (全模型共享)</span>
                    <span style={{ fontWeight: 600, color: quotaColor.text }}>
                      {claude.remaining_percent}% 剩余
                    </span>
                  </div>
                  <div
                    style={{
                      height: 7,
                      borderRadius: 999,
                      background: "var(--aurora-chip)",
                      border: "1px solid var(--aurora-border)",
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
                </div>
              </>
            );
          })() : (
            <div
              style={{
                padding: "10px 12px",
                borderRadius: 8,
                background: "var(--aurora-chip)",
                border: "1px solid var(--aurora-border)",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12 }}>
                <span style={{ color: "var(--aurora-fg3)" }}>限流机制</span>
                <span style={{ fontWeight: 600, color: "#D97706" }}>
                  {claude.quota_type === "token_payg" ? "API Key 按量计费" : "动态滑动窗口"}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--aurora-fg2)", lineHeight: 1.5 }}>
                {claude.quota_desc || "Claude 订阅根据官方动态队列与滑动速率轮转。"}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Models Details Accordion */}
      {claude?.available && claude?.models && claude.models.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setExpandedMap((prev) => ({ ...prev, claude_code: !prev.claude_code }))}
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
            <span>
              {expandedMap.claude_code
                ? "收起可用模型"
                : `查看支持模型 (${claude.models.length} 个，${claude.quota_type === "token_payg" ? "按量计费" : "共享订阅额度"})`}
            </span>
            <Icon name={expandedMap.claude_code ? "chevron_up" : "chevron_down"} size={12} />
          </button>

          {expandedMap.claude_code && (
            <div
              style={{
                marginTop: 8,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "8px 10px",
                borderRadius: 8,
                background: "var(--aurora-chip)",
                border: "1px solid var(--aurora-border)",
                maxHeight: "180px",
                overflowY: "auto",
              }}
            >
              <div style={{ fontSize: 10.5, color: "var(--aurora-fg3)", paddingBottom: 4, borderBottom: "1px dashed var(--aurora-border)" }}>
                {claude.quota_type === "token_payg"
                  ? (claude.details?.custom_gateway ? `所有模型通过反向网关 (${claude.details.custom_gateway}) 直连按 Token 计费` : "所有模型通过 API Key 直连按 Token 计费")
                  : "所有模型共享 Anthropic Pro 滑动窗口配额"}
              </div>
              {claude.models.map((m, idx) => {
                return (
                  <div
                    key={idx}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      fontSize: 11.5,
                      padding: "3px 0",
                    }}
                  >
                    <span style={{ color: "var(--aurora-fg1)", fontWeight: 500 }}>{m.label}</span>
                    <span className="quota-badge-amber px-2 py-0.5 rounded text-[11px] font-semibold">
                      {m.status_text || (m.remaining_percent != null ? `${m.remaining_percent}%` : "可用")}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const renderCodexCard = () => (
    <div key="codex" style={getCardStyle("codex")}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1, overflow: "hidden" }}>
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
              flexShrink: 0,
            }}
          >
            O
          </div>
          <div style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              OpenAI Codex
            </div>
            <div style={{ fontSize: 11.5, color: "var(--aurora-fg3)", marginTop: 1, display: "flex", alignItems: "center", gap: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{codex?.account_email ? `${codex.account_name ? codex.account_name + " · " : ""}${codex.account_email}` : (codex?.available ? "Codex 智能体" : "未检测到本地凭据")}</span>
              {codex?.probe_source && (
                <span style={{ fontSize: 10, color: "var(--aurora-fg4)", flexShrink: 0 }}>· 📡 {codex.probe_source}</span>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {renderActiveBadge("codex")}
          {codex?.available ? (
            <span className="quota-badge-emerald px-2.5 py-0.5 rounded-full text-[11px] font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0" title="已完成授权">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
              <span>{codex?.plan_name || "ChatGPT Plus"}</span>
              <span className="text-[10px] font-normal opacity-75 hidden sm:inline">· 已授权</span>
            </span>
          ) : (
            <span className="quota-badge-neutral px-2.5 py-0.5 rounded-full text-[11px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 text-red-500" title={codex?.error || "未配置凭据"}>
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
              未配置
            </span>
          )}
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
            background: "var(--aurora-chip)",
            border: "1px solid var(--aurora-border)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ color: "var(--aurora-fg3)" }}>额度计算机制</span>
            <span className="quota-badge-emerald px-2 py-0.5 rounded text-[11px] font-semibold whitespace-nowrap shrink-0">
              {codex.quota_type === "token_payg"
                ? "API Key 按量扣费"
                : (codex.tier === "FREE" ? "动态队列 (Free)" : "Plus 动态滑动限流")}
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--aurora-fg2)", lineHeight: 1.5 }}>
            {codex.quota_desc || "ChatGPT Plus 依据 3 小时滑动窗口频次动态限流，不设单一百分比电池池，全模型均受 Plus 通道保障。"}
          </div>
        </div>
      )}

      {/* Models Details Accordion */}
      {codex?.available && codex?.models && codex.models.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setExpandedMap((prev) => ({ ...prev, codex: !prev.codex }))}
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
            <span>{expandedMap.codex ? "收起可用模型" : `查看可用模型 (${codex.models.length})`}</span>
            <Icon name={expandedMap.codex ? "chevron_up" : "chevron_down"} size={12} />
          </button>

          {expandedMap.codex && (
            <div
              style={{
                marginTop: 8,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "8px 10px",
                borderRadius: 8,
                background: "var(--aurora-chip)",
                border: "1px solid var(--aurora-border)",
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
                    padding: "3px 0",
                  }}
                >
                  <span style={{ color: "var(--aurora-fg1)", fontWeight: 500 }}>{m.label}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="quota-badge-emerald px-2 py-0.5 rounded text-[11px] font-semibold">
                      {m.status_text || "Plus 动态保障"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const renderWorkbuddyCard = () => (
    <div key="workbuddy" style={getCardStyle("workbuddy")}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1, overflow: "hidden" }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: "rgba(14, 199, 168, 0.12)",
              color: "#0EC7A8",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <BrandMark id="workbuddy" size={18} colored />
          </div>
          <div style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              WorkBuddy
            </div>
            <div style={{ fontSize: 11.5, color: "var(--aurora-fg3)", marginTop: 1, display: "flex", alignItems: "center", gap: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {workbuddy?.account_name
                  ? `${workbuddy.account_name}${workbuddy.account_email ? " · " + workbuddy.account_email : ""}`
                  : (workbuddy?.available ? "腾讯全场景智能体工作台" : "未检测到本地凭据")}
              </span>
              {workbuddy?.probe_source && (
                <span style={{ fontSize: 10, color: "var(--aurora-fg4)", flexShrink: 0 }}>· 📡 {workbuddy.probe_source}</span>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {renderActiveBadge("workbuddy")}
          {workbuddy?.available ? (
            <span className="quota-badge-teal px-2.5 py-0.5 rounded-full text-[11px] font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0" title="已成功连接">
              <span className="w-1.5 h-1.5 rounded-full bg-teal-500 shrink-0" />
              <span>{workbuddy?.plan_name || "WorkBuddy 个人版"}</span>
              <span className="text-[10px] font-normal opacity-75 hidden sm:inline">· 已连接</span>
            </span>
          ) : (
            <span className="quota-badge-neutral px-2.5 py-0.5 rounded-full text-[11px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 text-red-500" title={workbuddy?.error || "未运行"}>
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
              未运行
            </span>
          )}
        </div>
      </div>

      {!workbuddy?.available && (
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
          {workbuddy?.error || "未检测到 WorkBuddy 账号快照或本地网关。"}
        </div>
      )}

      {workbuddy?.available && (
        <div
          style={{
            padding: "10px 12px",
            borderRadius: 8,
            background: "var(--aurora-chip)",
            border: "1px solid var(--aurora-border)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ color: "var(--aurora-fg3)" }}>本地网关与额度</span>
            <span className="quota-badge-teal px-2 py-0.5 rounded text-[11px] font-semibold whitespace-nowrap shrink-0">
              {(workbuddy.details?.gateway_online || workbuddy.details?.gateway_alive) ? "ACP 网关在线" : "动态免费调用"}
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--aurora-fg2)", lineHeight: 1.5 }}>
            {workbuddy.quota_desc || "WorkBuddy 个人版支持免费动态调用，自定义模型通过本地端点直连。"}
          </div>
        </div>
      )}

      {workbuddy?.available && workbuddy?.models && workbuddy.models.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setExpandedMap((prev) => ({ ...prev, workbuddy: !prev.workbuddy }))}
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
            <span>{expandedMap.workbuddy ? "收起可用模型" : `查看可用模型 (${workbuddy.models.length})`}</span>
            <Icon name={expandedMap.workbuddy ? "chevron_up" : "chevron_down"} size={12} />
          </button>

          {expandedMap.workbuddy && (
            <div
              style={{
                marginTop: 8,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "8px 10px",
                borderRadius: 8,
                background: "var(--aurora-chip)",
                border: "1px solid var(--aurora-border)",
                maxHeight: "180px",
                overflowY: "auto",
              }}
            >
              {workbuddy.models.map((m, idx) => (
                <div
                  key={idx}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: 11.5,
                    padding: "3px 0",
                  }}
                >
                  <span style={{ color: "var(--aurora-fg1)", fontWeight: 500 }}>{m.label}</span>
                  <span className="quota-badge-teal px-2 py-0.5 rounded text-[11px] font-semibold">
                    {m.status_text || "免费额度可用"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const renderToolCard = (key: QuotaToolKey) => {
    switch (key) {
      case "antigravity":
        return renderAntigravityCard();
      case "claude_code":
        return renderClaudeCodeCard();
      case "codex":
        return renderCodexCard();
      case "workbuddy":
        return renderWorkbuddyCard();
    }
  };

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
            padding: "14px 18px",
            borderBottom: "1px solid var(--aurora-border)",
            background: "rgba(255, 255, 255, 0.03)",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1, paddingRight: 4 }}>
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
                flexShrink: 0,
              }}
            >
              <Icon name="activity" size={17} />
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: "var(--aurora-fg1)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                AI 工具订阅与额度监控
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--aurora-fg4)",
                  marginTop: 2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={data?.device_name ? `探测设备: ${data.device_name}` : "实时监控各智能体额度与滑动窗口"}
              >
                {data?.device_name ? `探测设备: ${data.device_name}` : "实时监控各智能体额度与滑动窗口"}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              onClick={toggleAll}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "6px 10px",
                borderRadius: 8,
                background: "var(--aurora-chip)",
                border: "1px solid var(--aurora-border)",
                color: "var(--aurora-fg2)",
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                transition: "all 0.15s ease",
                whiteSpace: "nowrap",
                flexShrink: 0,
                userSelect: "none",
              }}
              title={allExpanded ? "收起所有模型的子配额明细" : "展开所有模型的子配额明细"}
            >
              <Icon name={allExpanded ? "chevron_up" : "chevron_down"} size={13} style={{ flexShrink: 0 }} />
              <span className="hidden min-[440px]:inline">{allExpanded ? "全部收起" : "展开全部"}</span>
            </button>

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
                fontWeight: 500,
                cursor: refreshing ? "not-allowed" : "pointer",
                transition: "all 0.15s ease",
                whiteSpace: "nowrap",
                flexShrink: 0,
                userSelect: "none",
                opacity: refreshing ? 0.8 : 1,
              }}
              title="重新探测并刷新各工具配额"
            >
              <Icon
                name="refresh"
                size={13}
                style={{
                  animation: refreshing ? "spin 1s linear infinite" : "none",
                  color: refreshing ? "var(--aurora-accent)" : "inherit",
                  flexShrink: 0,
                }}
              />
              <span className="hidden min-[380px]:inline">{refreshing ? "探测中..." : "刷新"}</span>
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
                flexShrink: 0,
              }}
              title="关闭"
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        </div>

        {/* Content list or Skeleton */}
        {loading && !data ? (
          <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--aurora-fg3)", fontSize: 12 }}>
              <Icon name="refresh" size={13} style={{ animation: "spin 1s linear infinite", color: "var(--aurora-accent)" }} />
              <span>正在实时探测各 AI 智能体订阅状态与本地配额...</span>
            </div>
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                style={{
                  padding: "16px",
                  borderRadius: 14,
                  border: "1px solid var(--aurora-border)",
                  background: "var(--aurora-card)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
                className="animate-pulse"
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 30, height: 30, borderRadius: 8, background: "var(--aurora-chip)" }} />
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ width: 110, height: 13, borderRadius: 4, background: "var(--aurora-chip)" }} />
                      <div style={{ width: 80, height: 10, borderRadius: 4, background: "var(--aurora-chip)" }} />
                    </div>
                  </div>
                  <div style={{ width: 60, height: 18, borderRadius: 999, background: "var(--aurora-chip)" }} />
                </div>
                <div style={{ width: "100%", height: 7, borderRadius: 999, background: "var(--aurora-chip)" }} />
              </div>
            ))}
          </div>
        ) : (
          <div style={{ padding: "16px 20px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
            {toolsOrder.map((key) => renderToolCard(key))}
          </div>
        )}

        {/* Footer info */}
        <div
          style={{
            padding: "10px 20px",
            background: "var(--aurora-chip)",
            borderTop: "1px solid var(--aurora-border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 11,
            color: "var(--aurora-fg3)",
          }}
        >
          <span>数据来源：设备驻留探测进程与语言服务实时接口</span>
          <span>{data?.updated_at ? `更新于 ${new Date(data.updated_at).toLocaleTimeString()}` : ""}</span>
        </div>
      </Glass>
    </div>
  );
}
