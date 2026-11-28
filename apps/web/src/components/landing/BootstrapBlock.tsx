"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";

const CLAUDE_MD_TEMPLATE = `# Project memory

This project has historical context in Memento. Before doing
substantive work, load it via these MCP tools:

1. memory_context("<project name>") — pulls the project shell:
   recent conversations, memory/plan/identity files, related entities.
2. memory_recall(category="memory", project="<project name>", days=180)
   — long-lived memory files specifically.
3. memory_recall(category="plan", project="<project name>", days=90)
   — prior plans / TODO state.
4. memory_graph("<project name>") — entities + relations + observations.
5. memory_open(doc_id) on any interesting hit to read the full text,
   or memory_conversation(doc_id) for full message history.

For ad-hoc lookups across all tools use memory_search(q) with optional
tool_filter and days.`;

export function BootstrapBlock() {
  const { t } = useI18n();
  return (
    <section
      id="bootstrap"
      style={{ padding: "56px 20px", maxWidth: 1120, margin: "0 auto" }}
    >
      <div style={{ maxWidth: 720, marginBottom: 28 }}>
        <h2
          style={{
            margin: 0,
            fontSize: "clamp(24px, 3.2vw, 32px)",
            fontWeight: 700,
            color: "var(--aurora-fg1)",
            letterSpacing: "-0.03em",
            lineHeight: 1.18,
          }}
        >
          {t.landing.bootstrap_title}
        </h2>
        <p
          style={{
            margin: "10px 0 0",
            fontSize: 15,
            color: "var(--aurora-fg3)",
            lineHeight: 1.6,
          }}
        >
          {t.landing.bootstrap_subtitle}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: 18 }}>
        <Path
          title={t.landing.bootstrap_path_live_title}
          subtitle={t.landing.bootstrap_path_live_subtitle}
          recommended
          bullets={[
            t.landing.bootstrap_path_live_b1,
            t.landing.bootstrap_path_live_b2,
            t.landing.bootstrap_path_live_b3,
          ]}
          footer={
            <CopyBox label="CLAUDE.md / AGENTS.md" body={CLAUDE_MD_TEMPLATE} />
          }
        />
        <Path
          title={t.landing.bootstrap_path_dump_title}
          subtitle={t.landing.bootstrap_path_dump_subtitle}
          bullets={[
            t.landing.bootstrap_path_dump_b1,
            t.landing.bootstrap_path_dump_b2,
            t.landing.bootstrap_path_dump_b3,
          ]}
          footer={
            <div
              style={{
                padding: "12px 14px",
                borderRadius: 10,
                background: "var(--aurora-bg)",
                border: "1px solid var(--aurora-border)",
              }}
            >
              <p style={{ fontSize: 12.5, color: "var(--aurora-fg3)", margin: 0, lineHeight: 1.6 }}>
                {t.landing.bootstrap_path_dump_tip}
              </p>
            </div>
          }
        />
      </div>
    </section>
  );
}

function Path({
  title,
  subtitle,
  recommended = false,
  bullets,
  footer,
}: {
  title: string;
  subtitle: string;
  recommended?: boolean;
  bullets: string[];
  footer: React.ReactNode;
}) {
  return (
    <div
      className="aurora-glass-panel"
      style={{
        padding: 24,
        borderRadius: 18,
        borderColor: recommended
          ? "var(--aurora-accent-border, var(--aurora-border-strong))"
          : undefined,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <h3
        style={{
          margin: "0 0 8px",
          fontSize: 17,
          fontWeight: 600,
          color: "var(--aurora-fg1)",
          letterSpacing: "-0.02em",
        }}
      >
        {title}
      </h3>
      <p style={{ margin: "0 0 14px", fontSize: 13.5, color: "var(--aurora-fg3)", lineHeight: 1.6 }}>
        {subtitle}
      </p>
      <ol
        style={{
          margin: "0 0 16px",
          paddingLeft: 18,
          fontSize: 13.5,
          color: "var(--aurora-fg2)",
          lineHeight: 1.7,
        }}
      >
        {bullets.map((b, i) => (
          <li key={i} style={{ marginBottom: 4 }}>{b}</li>
        ))}
      </ol>
      <div style={{ marginTop: "auto" }}>{footer}</div>
    </div>
  );
}

function CopyBox({ label, body }: { label: string; body: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <div style={{ borderRadius: 10, border: "1px solid var(--aurora-border)", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--aurora-fg3)",
          background: "var(--aurora-surface-mute)",
          borderBottom: "1px solid var(--aurora-border)",
          fontFamily: "var(--font-mono)",
        }}
      >
        <span>{label}</span>
        <button
          type="button"
          onClick={onCopy}
          style={{
            padding: "4px 9px",
            fontSize: 12,
            fontWeight: 500,
            borderRadius: 6,
            border: "1px solid var(--aurora-border-strong)",
            background: copied ? "var(--aurora-success-soft)" : "var(--aurora-surface-solid)",
            color: copied ? "var(--aurora-success)" : "var(--aurora-fg2)",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontFamily: "var(--font-sans)",
            transition: "background-color 150ms ease, color 150ms ease",
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={12} />
          {copied ? t.landing.install_copied : t.landing.install_copy}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: 14,
          background: "var(--aurora-code-bg, #13141B)",
          color: "var(--aurora-code-fg, #E8EAF2)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          maxHeight: 210,
          overflow: "auto",
        }}
      >
        {body}
      </pre>
    </div>
  );
}
