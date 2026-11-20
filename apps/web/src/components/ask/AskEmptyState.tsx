"use client";

import { Icon } from "@/components/aurora/Icon";
import { Glass } from "@/components/aurora/primitives";
import { useI18n } from "@/lib/i18n";

/** A conversation with nothing in it yet: what this page does and a few questions to start with. */
export function AskEmptyState({ onPick }: { onPick: (question: string) => void }) {
  const { t } = useI18n();
  return (
    <Glass padding="clamp(20px, 4vw, 32px)" radius={16} style={{ textAlign: "center", marginBottom: 20, maxWidth: "100%", minWidth: 0 }}>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 44,
          height: 44,
          borderRadius: 12,
          background: "var(--aurora-brand-grad)",
          boxShadow: "0 6px 18px -6px rgba(15, 23, 42, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.2)",
          color: "#fff",
          marginBottom: 12,
        }}
      >
        <Icon name="sparkles" size={22} />
      </div>
      <h3 style={{ fontSize: 15.5, fontWeight: 600, color: "var(--aurora-fg1)", margin: "0 0 6px", letterSpacing: "-0.015em" }}>
        {t.ask.title}
      </h3>
      <p style={{ color: "var(--aurora-fg3)", fontSize: 13, margin: "0 0 18px", lineHeight: 1.55 }}>
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
              padding: "6px 12px",
              borderRadius: 9,
              background: "var(--aurora-chip)",
              border: "1px solid var(--aurora-border)",
              color: "var(--aurora-fg2)",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              transition: "all 0.15s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--aurora-accent)";
              e.currentTarget.style.color = "var(--aurora-fg1)";
              e.currentTarget.style.background = "var(--aurora-accent-soft)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--aurora-border)";
              e.currentTarget.style.color = "var(--aurora-fg2)";
              e.currentTarget.style.background = "var(--aurora-chip)";
            }}
          >
            <Icon name={s.icon} size={12.5} style={{ color: "var(--aurora-accent)" }} />
            <span>{s.label}</span>
          </button>
        ))}
      </div>
    </Glass>
  );
}
