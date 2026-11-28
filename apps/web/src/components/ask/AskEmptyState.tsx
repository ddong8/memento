"use client";

import { Icon } from "@/components/aurora/Icon";
import { MementoMark } from "@/components/aurora/MementoMark";
import { Glass } from "@/components/aurora/primitives";
import { useI18n } from "@/lib/i18n";

/** A conversation with nothing in it yet: what this page does and a few questions to start with. */
export function AskEmptyState({ onPick }: { onPick: (question: string) => void }) {
  const { t } = useI18n();
  return (
    <Glass padding="clamp(22px, 4vw, 34px)" radius={16} style={{ textAlign: "center", marginBottom: 20, maxWidth: "100%", minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
        <MementoMark size={44} radius={12} />
      </div>
      <h3 style={{ fontSize: 16, fontWeight: 600, color: "var(--aurora-fg1)", margin: "0 0 6px", letterSpacing: "-0.02em" }}>
        {t.ask.title}
      </h3>
      <p style={{ color: "var(--aurora-fg3)", fontSize: 13.5, margin: "0 auto 20px", lineHeight: 1.6, maxWidth: 460 }}>
        {t.ask.empty}
      </p>

      {/* Quick command actions */}
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
              padding: "7px 13px",
              borderRadius: 9,
              background: "var(--aurora-chip)",
              border: "1px solid var(--aurora-border)",
              color: "var(--aurora-fg2)",
              fontSize: 12.5,
              fontWeight: 500,
              cursor: "pointer",
              transition: "background-color 150ms ease, border-color 150ms ease, color 150ms ease",
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
            <Icon name={s.icon} size={13} style={{ color: "var(--aurora-accent)" }} />
            <span>{s.label}</span>
          </button>
        ))}
      </div>
    </Glass>
  );
}
