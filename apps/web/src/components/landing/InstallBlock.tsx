"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";

const CMD_UNIX = "curl -fsSL https://mem.ihasy.com/install.sh | sh";
const CMD_WIN = "iwr https://mem.ihasy.com/install.ps1 -useb | iex";

export function InstallBlock() {
  const { t } = useI18n();
  return (
    <section id="install" style={{ padding: "56px 20px", maxWidth: 1120, margin: "0 auto" }}>
      <div style={{ maxWidth: 680, marginBottom: 28 }}>
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
          {t.landing.install_title}
        </h2>
        <p style={{ margin: "10px 0 0", fontSize: 15, color: "var(--aurora-fg3)", lineHeight: 1.55 }}>
          {t.landing.install_sub}
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: 16 }}>
        <CommandCard label={t.landing.install_macos} cmd={CMD_UNIX} />
        <CommandCard label={t.landing.install_windows} cmd={CMD_WIN} />
      </div>
      <p
        style={{
          marginTop: 16,
          fontSize: 13,
          color: "var(--aurora-fg4)",
          maxWidth: 720,
          lineHeight: 1.6,
        }}
      >
        {t.landing.install_note}
      </p>
    </section>
  );
}

function CommandCard({ label, cmd }: { label: string; cmd: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div
      style={{
        borderRadius: 14,
        background: "var(--aurora-surface-solid)",
        border: "1px solid var(--aurora-border-strong)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 16px",
          borderBottom: "1px solid var(--aurora-border)",
          background: "var(--aurora-surface-mute)",
          fontSize: 12.5,
          fontWeight: 600,
          color: "var(--aurora-fg2)",
        }}
      >
        <span>{label}</span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={t.landing.install_copy}
          style={{
            padding: "4px 10px",
            fontSize: 12,
            fontWeight: 500,
            borderRadius: 7,
            border: "1px solid var(--aurora-border-strong)",
            background: copied ? "var(--aurora-success-soft)" : "var(--aurora-surface-solid)",
            color: copied ? "var(--aurora-success)" : "var(--aurora-fg2)",
            cursor: "pointer",
            fontFamily: "inherit",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
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
          background: "var(--aurora-code-bg, #13141B)",
          color: "var(--aurora-code-fg, #E8EAF2)",
          padding: "16px 18px",
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          lineHeight: 1.5,
          whiteSpace: "pre",
          overflowX: "auto",
        }}
      >
        {cmd}
      </pre>
    </div>
  );
}
