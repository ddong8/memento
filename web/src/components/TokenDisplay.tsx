"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";

interface TokenDisplayProps {
  token: string | null | undefined;
  /** When false, token is shown in full by default. When true, starts masked. */
  maskByDefault?: boolean;
  /** Compact: one-line with small buttons (for admin table rows). */
  compact?: boolean;
  /** Optional placeholder when token is missing. */
  emptyLabel?: string;
}

function maskToken(t: string): string {
  if (t.length <= 12) return t;
  return `${t.slice(0, 6)}${"•".repeat(24)}${t.slice(-4)}`;
}

export function TokenDisplay({
  token,
  maskByDefault = true,
  compact = false,
  emptyLabel,
}: TokenDisplayProps) {
  const [revealed, setRevealed] = useState(!maskByDefault);
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();

  if (!token) {
    return (
      <span style={{ color: "var(--aurora-fg4)", fontSize: 12 }}>
        {emptyLabel || "—"}
      </span>
    );
  }

  const displayed = revealed ? token : maskToken(token);

  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // older browser / insecure origin: fallback
      const ta = document.createElement("textarea");
      ta.value = token;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); setCopied(true); setTimeout(() => setCopied(false), 1600); } finally {
        document.body.removeChild(ta);
      }
    }
  };

  const btnStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: compact ? "2px 8px" : "4px 10px",
    borderRadius: 8,
    border: "1px solid var(--aurora-border)",
    background: "var(--aurora-chip)",
    color: "var(--aurora-fg2)",
    fontSize: compact ? 11 : 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
    transition: "background .15s",
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        minWidth: 0,
      }}
    >
      <code
        style={{
          flex: "1 1 auto",
          minWidth: 0,
          padding: compact ? "4px 8px" : "8px 12px",
          borderRadius: 8,
          background: "var(--aurora-surface-mute)",
          border: "1px solid var(--aurora-border)",
          color: "var(--aurora-fg1)",
          fontSize: compact ? 11 : 13,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          letterSpacing: "0.02em",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          wordBreak: "break-all",
        }}
        title={token}
      >
        {displayed}
      </code>
      <button type="button" onClick={() => setRevealed((v) => !v)} style={btnStyle}>
        {revealed ? t.common.hide : t.common.reveal}
      </button>
      <button type="button" onClick={doCopy} style={btnStyle}>
        <Icon name={copied ? "check" : "file_text"} size={compact ? 11 : 13} />
        {copied ? t.common.copied : t.common.copy}
      </button>
    </div>
  );
}
