"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { getApiBase, authFetch } from "@/lib/api-client";
import { Icon, ToolGlyph } from "@/components/aurora/Icon";
import { Btn, Glass } from "@/components/aurora/primitives";

const AGENTS = [
  { id: "claude", tool: "claude_code", label: "Claude Code" },
  { id: "codex", tool: "codex", label: "Codex" },
  { id: "agy", tool: "antigravity", label: "Antigravity" },
] as const;

/** One command that sets up a Linux server as an executor for code that stays on another device. */
export function executorCommand(base: string, token: string, agents: string[]): string {
  const agentArg = agents.length ? ` --agents ${agents.join(",")}` : "";
  return `curl -fsSL ${base}/install/executor.sh | bash -s -- --token ${token}${agentArg}`;
}

export function ExecutorGuide() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [agents, setAgents] = useState<string[]>(AGENTS.map((a) => a.id));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || token !== null) return;
    authFetch(`${getApiBase()}/api/auth/me`)
      .then((r) => r.json())
      .then((me: { collector_token?: string | null }) => setToken(me.collector_token || ""))
      .catch(() => setToken(""));
  }, [open, token]);

  const base = getApiBase();
  const shown = executorCommand(base, token ? `${token.slice(0, 6)}••••••` : "<token>", agents);

  const copy = () => {
    if (!token) return;
    void navigator.clipboard?.writeText(executorCommand(base, token, agents)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <Glass padding={open ? 22 : 16} radius={20} style={{ marginTop: 14 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, width: "100%" }}
      >
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            flexShrink: 0,
            background: "var(--aurora-brand-grad)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="server" size={17} style={{ color: "#fff" }} strokeWidth={2} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)" }}>{t.devices.executorTitle}</div>
          <div style={{ fontSize: 12, color: "var(--aurora-fg4)", marginTop: 2 }}>{t.devices.executorSubtitle}</div>
        </div>
        <Icon name={open ? "chevron_up" : "chevron_down"} size={16} style={{ color: "var(--aurora-fg4)" }} />
      </button>

      {open && (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7, color: "var(--aurora-fg2)" }}>
            <li>{t.devices.executorStep1}</li>
            <li>{t.devices.executorStep2}</li>
            <li>{t.devices.executorStep3}</li>
          </ol>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--aurora-fg4)" }}>{t.devices.executorAgents}</span>
            {AGENTS.map((a) => {
              const on = agents.includes(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setAgents((prev) => (on ? prev.filter((x) => x !== a.id) : AGENTS.map((x) => x.id).filter((x) => x === a.id || prev.includes(x))))}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 10px",
                    borderRadius: 999,
                    fontSize: 12,
                    cursor: "pointer",
                    border: `1px solid ${on ? "var(--aurora-accent, #7C3AED)" : "var(--aurora-border)"}`,
                    background: on ? "rgba(124,58,237,0.12)" : "transparent",
                    color: on ? "var(--aurora-fg1)" : "var(--aurora-fg4)",
                  }}
                >
                  <ToolGlyph id={a.tool} size={16} />
                  {a.label}
                </button>
              );
            })}
          </div>

          <div style={{ position: "relative" }}>
            <pre
              style={{
                margin: 0,
                background: "#111827",
                color: "#34D399",
                borderRadius: 12,
                padding: "14px 96px 14px 14px",
                fontSize: 12,
                lineHeight: 1.6,
                fontFamily: "var(--font-mono)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {shown}
            </pre>
            <div style={{ position: "absolute", top: 8, right: 8 }}>
              <Btn size="sm" variant="glass" icon={copied ? "check" : "copy"} disabled={!token} onClick={copy}>
                {copied ? t.devices.executorCopied : t.devices.executorCopy}
              </Btn>
            </div>
          </div>
          {token === "" && <div style={{ fontSize: 12, color: "#F59E0B" }}>{t.devices.executorNoToken}</div>}
          <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--aurora-fg4)" }}>{t.devices.executorNote}</div>
        </div>
      )}
    </Glass>
  );
}
