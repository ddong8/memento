"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { Glass, SectionLabel } from "@/components/aurora/primitives";

// CLAUDE.md template the user can paste into a fresh project. Same
// shape works as ~/AGENTS.md for Codex. Kept here as a constant so the
// copy button can grab it verbatim — keep in sync with the README and
// the docs that describe the bootstrap workflow.
const CLAUDE_MD_TEMPLATE = `# Project memory

This project has historical context in Memento. **Before doing
substantive work, load it via these MCP tools:**

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
      style={{ padding: "48px 20px", maxWidth: 1100, margin: "0 auto" }}
    >
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <SectionLabel style={{ margin: 0, marginBottom: 8 }}>
          {t.landing.bootstrap_kicker}
        </SectionLabel>
        <h2
          style={{
            margin: 0,
            fontSize: "clamp(22px, 3.2vw, 30px)",
            fontWeight: 600,
            color: "var(--aurora-fg1)",
            letterSpacing: "-0.025em",
          }}
        >
          {t.landing.bootstrap_title}
        </h2>
        <p
          style={{
            margin: "10px auto 0",
            maxWidth: 680,
            fontSize: 13,
            color: "var(--aurora-fg3)",
            lineHeight: 1.6,
          }}
        >
          {t.landing.bootstrap_subtitle}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: 16 }}>
        <Path
          step={1}
          title={t.landing.bootstrap_path_live_title}
          subtitle={t.landing.bootstrap_path_live_subtitle}
          accent="rgba(124,58,237,0.4)"
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
          step={2}
          title={t.landing.bootstrap_path_dump_title}
          subtitle={t.landing.bootstrap_path_dump_subtitle}
          accent="rgba(20,184,166,0.4)"
          bullets={[
            t.landing.bootstrap_path_dump_b1,
            t.landing.bootstrap_path_dump_b2,
            t.landing.bootstrap_path_dump_b3,
          ]}
          footer={
            <Glass padding={12} radius={12} style={{ background: "rgba(0,0,0,0.15)" }}>
              <p style={{ fontSize: 11, color: "var(--aurora-fg4)", margin: 0, lineHeight: 1.6 }}>
                {t.landing.bootstrap_path_dump_tip}
              </p>
            </Glass>
          }
        />
      </div>
    </section>
  );
}

function Path({
  step,
  title,
  subtitle,
  bullets,
  accent,
  footer,
}: {
  step: number;
  title: string;
  subtitle: string;
  bullets: string[];
  accent: string;
  footer: React.ReactNode;
}) {
  return (
    <Glass padding={22} radius={20} accent={accent}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--aurora-fg4)",
            letterSpacing: "0.08em",
          }}
        >
          PATH {step}
        </span>
        <h3
          style={{
            margin: 0,
            fontSize: 17,
            fontWeight: 600,
            color: "var(--aurora-fg1)",
            letterSpacing: "-0.02em",
          }}
        >
          {title}
        </h3>
      </div>
      <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--aurora-fg3)", lineHeight: 1.55 }}>
        {subtitle}
      </p>
      <ol
        style={{
          margin: "0 0 14px",
          paddingLeft: 18,
          fontSize: 12.5,
          color: "var(--aurora-fg2)",
          lineHeight: 1.7,
        }}
      >
        {bullets.map((b, i) => (
          <li key={i} style={{ marginBottom: 4 }}>{b}</li>
        ))}
      </ol>
      {footer}
    </Glass>
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
    } catch {
      // Some browsers gate clipboard on insecure origin; the user can
      // still select + copy manually.
    }
  };
  return (
    <Glass padding={0} radius={12} style={{ overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          fontSize: 10.5,
          fontWeight: 600,
          color: "var(--aurora-fg4)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          borderBottom: "1px solid var(--aurora-border)",
        }}
      >
        <span>{label}</span>
        <button
          onClick={onCopy}
          style={{
            padding: "3px 8px",
            fontSize: 10,
            fontWeight: 500,
            borderRadius: 6,
            border: "1px solid rgba(255,255,255,0.15)",
            background: copied ? "rgba(16,185,129,0.18)" : "rgba(255,255,255,0.06)",
            color: copied ? "#34D399" : "var(--aurora-fg2)",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontFamily: "inherit",
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={10} />
          {copied ? t.landing.install_copied : t.landing.install_copy}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: 12,
          background: "#0A0A12",
          color: "#E4E4F0",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 11.5,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          maxHeight: 220,
          overflow: "auto",
        }}
      >
        {body}
      </pre>
    </Glass>
  );
}
