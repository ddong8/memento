"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { Glass, SectionLabel } from "@/components/aurora/primitives";

const CMD_UNIX = "curl -fsSL https://mem.ihasy.com/install.sh | sh";
const CMD_WIN = "iwr https://mem.ihasy.com/install.ps1 -useb | iex";

export function InstallBlock() {
  const { t } = useI18n();
  return (
    <section id="install" style={{ padding: "48px 20px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <SectionLabel style={{ margin: 0, marginBottom: 8 }}>{t.landing.install_title}</SectionLabel>
        <h2
          style={{
            margin: 0,
            fontSize: "clamp(22px, 3.2vw, 30px)",
            fontWeight: 600,
            color: "var(--aurora-fg1)",
            letterSpacing: "-0.025em",
          }}
        >
          {t.landing.install_sub}
        </h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: 16 }}>
        <CommandCard label={t.landing.install_macos} cmd={CMD_UNIX} />
        <CommandCard label={t.landing.install_windows} cmd={CMD_WIN} />
      </div>
      <p
        style={{
          marginTop: 18,
          fontSize: 12,
          color: "var(--aurora-fg4)",
          textAlign: "center",
          maxWidth: 680,
          marginInline: "auto",
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
    } catch {
      // Fallback: select the text node manually (best effort)
    }
  };

  return (
    <Glass padding={0} radius={16} style={{ overflow: "hidden" }}>
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--aurora-border)",
          fontSize: 11,
          fontWeight: 600,
          color: "var(--aurora-fg4)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          position: "relative",
          background: "#0A0A12",
          color: "#E4E4F0",
          padding: "18px 52px 18px 18px",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 13,
          whiteSpace: "pre",
          overflowX: "auto",
        }}
      >
        {cmd}
        <button
          onClick={onCopy}
          aria-label={t.landing.install_copy}
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            padding: "5px 10px",
            fontSize: 11,
            fontWeight: 500,
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: copied ? "rgba(16,185,129,0.2)" : "rgba(255,255,255,0.08)",
            color: copied ? "#34D399" : "#E4E4F0",
            cursor: "pointer",
            fontFamily: "inherit",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <Icon name={copied ? "check" : "file_text"} size={11} />
          {copied ? t.landing.install_copied : t.landing.install_copy}
        </button>
      </div>
    </Glass>
  );
}
