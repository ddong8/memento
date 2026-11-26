"use client";

import { useState } from "react";
import { Icon } from "@/components/aurora/Icon";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";
import type { AiContextStats } from "@/lib/ask/turns";

interface AiContextBarProps {
  stats: AiContextStats | null;
  turnCount: number;
  canCompactNow: boolean;
  isCompacting: boolean;
  streaming: boolean;
  lastSavedText?: string | null;
  isZh: boolean;
  onCompactNow: () => void;
  onResetCheckpoint?: () => void;
}

function formatTokensCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export default function AiContextBar({
  stats,
  turnCount,
  canCompactNow,
  isCompacting,
  streaming,
  lastSavedText,
  isZh,
  onCompactNow,
  onResetCheckpoint,
}: AiContextBarProps) {
  const [showCheckpoint, setShowCheckpoint] = useState(false);

  if (turnCount === 0 && !stats?.has_checkpoint) {
    return null;
  }

  const est = stats?.estimated_tokens ?? 0;
  const budget = stats?.budget_tokens || 64000;
  const ratio = Math.min(1, Math.max(0, est / Math.max(1, budget)));
  const pct = Math.round(ratio * 100);
  const meterColor = ratio >= 0.8 ? "#EF4444" : ratio >= 0.55 ? "#D97706" : "#10B981";
  const compactedTurns = stats?.compacted_turns ?? 0;
  const hasCheckpoint = Boolean(stats?.has_checkpoint && stats?.checkpoint_summary);

  return (
    <div
      style={{
        marginBottom: 6,
        borderRadius: 10,
        border: "1px solid var(--aurora-border)",
        background: "var(--aurora-chip)",
        overflow: "hidden",
        maxWidth: "100%",
        minWidth: 0,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "5px 10px",
          flexWrap: "wrap",
          minWidth: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "wrap", flex: "1 1 auto" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11.5,
              color: "var(--aurora-fg2)",
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: meterColor,
                flexShrink: 0,
              }}
            />
            <span>
              {isZh
                ? `上下文 ${formatTokensCompact(est)} / ${formatTokensCompact(budget)}`
                : `Context ${formatTokensCompact(est)} / ${formatTokensCompact(budget)}`}
            </span>
          </span>

          <div
            style={{
              width: 44,
              height: 4,
              borderRadius: 999,
              background: "var(--aurora-border)",
              overflow: "hidden",
              flexShrink: 0,
            }}
            aria-label={`${pct}%`}
          >
            <div
              style={{
                width: `${Math.max(4, pct)}%`,
                height: "100%",
                borderRadius: 999,
                background: meterColor,
                transition: "width 0.25s ease",
              }}
            />
          </div>

          {hasCheckpoint && (
            <button
              type="button"
              onClick={() => setShowCheckpoint((prev) => !prev)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "1.5px 7px",
                borderRadius: 6,
                border: "1px solid var(--aurora-border-strong)",
                background: "var(--aurora-surface-solid)",
                color: "var(--aurora-accent)",
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <Icon name="layers" size={11} />
              <span>
                {isZh ? `已压缩前 ${compactedTurns} 条` : `${compactedTurns} compacted`}
              </span>
              <Icon name={showCheckpoint ? "chevron_up" : "chevron_down"} size={10.5} />
            </button>
          )}

          {lastSavedText && (
            <span style={{ fontSize: 11, color: "#10B981", fontWeight: 500, whiteSpace: "nowrap" }}>
              {lastSavedText}
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {canCompactNow && (
            <button
              type="button"
              onClick={onCompactNow}
              disabled={isCompacting || streaming}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4.5,
                padding: "2.5px 9px",
                borderRadius: 7,
                border: `1px solid ${stats?.compact_recommended ? "var(--aurora-accent)" : "var(--aurora-border-strong)"}`,
                background: stats?.compact_recommended ? "var(--aurora-accent-soft)" : "var(--aurora-surface-solid)",
                color: stats?.compact_recommended ? "var(--aurora-accent)" : "var(--aurora-fg2)",
                fontSize: 11,
                fontWeight: 600,
                cursor: isCompacting || streaming ? "default" : "pointer",
                opacity: isCompacting || streaming ? 0.6 : 1,
                whiteSpace: "nowrap",
                transition: "all 0.15s ease",
              }}
            >
              <Icon name={isCompacting ? "refresh" : "zap"} size={11} className={isCompacting ? "animate-spin" : undefined} />
              <span>
                {isCompacting
                  ? (isZh ? "压缩中..." : "Compacting...")
                  : (isZh ? "压缩上下文" : "Compact")}
              </span>
            </button>
          )}
        </div>
      </div>

      {showCheckpoint && hasCheckpoint && (
        <div
          style={{
            borderTop: "1px solid var(--aurora-border)",
            background: "var(--aurora-thinking-bg)",
            padding: "8px 10px",
            maxHeight: 200,
            overflowY: "auto",
            fontSize: 12,
            color: "var(--aurora-fg2)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--aurora-fg1)" }}>
              {isZh ? "当前上下文压缩快照（自动注入后续轮次）" : "Active context checkpoint"}
            </span>
            {onResetCheckpoint && (
              <button
                type="button"
                onClick={onResetCheckpoint}
                disabled={streaming || isCompacting}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--aurora-fg3)",
                  fontSize: 11,
                  cursor: streaming || isCompacting ? "default" : "pointer",
                  padding: "1px 4px",
                }}
              >
                {isZh ? "清除快照" : "Reset"}
              </button>
            )}
          </div>
          <div className="prose prose-sm max-w-none w-full" style={{ fontSize: 12 }}>
            <MarkdownViewer content={stats?.checkpoint_summary || ""} compactText={true} />
          </div>
        </div>
      )}
    </div>
  );
}
