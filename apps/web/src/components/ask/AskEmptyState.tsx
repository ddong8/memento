"use client";

import { Icon } from "@/components/aurora/Icon";
import { Glass } from "@/components/aurora/primitives";
import { useI18n } from "@/lib/i18n";

/** A conversation with nothing in it yet: what this page does and a few questions to start with. */
export function AskEmptyState({ onPick }: { onPick: (question: string) => void }) {
  const { t } = useI18n();
  return (
    <Glass padding="clamp(16px, 4vw, 32px)" radius={20} style={{ textAlign: "center", marginBottom: 20, maxWidth: "100%", minWidth: 0 }}>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 48,
          height: 48,
          borderRadius: 14,
          background: "rgba(56, 189, 248, 0.12)",
          color: "var(--aurora-accent)",
          marginBottom: 12,
        }}
      >
        <Icon name="terminal" size={26} />
      </div>
      <h3 style={{ fontSize: 16, fontWeight: 600, color: "var(--aurora-fg1)", margin: "0 0 6px" }}>
        {t.ask.title}
      </h3>
      <p style={{ color: "var(--aurora-fg3)", fontSize: 13.5, margin: "0 0 18px" }}>
        {t.ask.empty}
      </p>

      {/* Quick command pills */}
      <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
        {[
          { label: t.ask.sugGitStatus, icon: "code" as const },
          { label: t.ask.sugPorts, icon: "activity" as const },
          { label: t.ask.sugDevices, icon: "devices" as const },
          { label: t.ask.sugRecentSummary, icon: "sparkles" as const },
        ].map((s, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => onPick(s.label)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 14px",
              borderRadius: 9999,
              background: "var(--aurora-chip)",
              border: "1px solid var(--aurora-border)",
              color: "var(--aurora-fg2)",
              fontSize: 12.5,
              cursor: "pointer",
              transition: "all 0.15s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--aurora-accent)";
              e.currentTarget.style.color = "var(--aurora-fg1)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--aurora-border)";
              e.currentTarget.style.color = "var(--aurora-fg2)";
            }}
          >
            <Icon name={s.icon} size={13} style={{ color: "var(--aurora-accent)" }} />
            <span>{s.label}</span>
          </button>
        ))}
      </div>
    </Glass>
  );
}
