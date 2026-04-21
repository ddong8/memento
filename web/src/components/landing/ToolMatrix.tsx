"use client";

import { useI18n } from "@/lib/i18n";
import { BrandMark } from "@/components/aurora/BrandMark";
import { Glass, SectionLabel } from "@/components/aurora/primitives";

const TOOLS = [
  { id: "claude_code", name: "Claude Code", content: "conversations · memory · plans · history", format: "JSONL / Markdown" },
  { id: "openclaw",    name: "OpenClaw",    content: "sessions · identity · skills · learning", format: "JSONL / Markdown" },
  { id: "codex",       name: "Codex",       content: "conversations · plans · skills · state",   format: "JSONL / TOML / SQLite" },
  { id: "antigravity", name: "Antigravity", content: "full conversations via aghistory, plans, snapshots", format: "Markdown / Protobuf" },
  { id: "cursor",      name: "Cursor",      content: "conversations · skills · MCP config",      format: "JSONL / Markdown" },
  { id: "obsidian",    name: "Obsidian",    content: "all notes in the vault",                   format: "Markdown" },
  { id: "windsurf",    name: "Windsurf",    content: "conversations · rules",                    format: "JSONL / Markdown" },
  { id: "vscode",      name: "VS Code",     content: "settings · extensions · rules",            format: "JSON / Markdown" },
];

export function ToolMatrix() {
  const { t } = useI18n();
  return (
    <section
      id="tools"
      style={{ padding: "48px 20px", maxWidth: 1100, margin: "0 auto" }}
    >
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <SectionLabel style={{ margin: 0, marginBottom: 8 }}>{t.landing.tools_title}</SectionLabel>
        <h2
          style={{
            margin: 0,
            fontSize: "clamp(22px, 3.2vw, 30px)",
            fontWeight: 600,
            color: "var(--aurora-fg1)",
            letterSpacing: "-0.025em",
          }}
        >
          {t.landing.tools_sub}
        </h2>
      </div>
      <Glass padding={0} radius={20} style={{ overflow: "hidden" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "160px 1fr 220px",
            padding: "10px 16px",
            borderBottom: "1px solid var(--aurora-border)",
            background: "var(--aurora-chip)",
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--aurora-fg4)",
          }}
          className="hidden sm:grid"
        >
          <span>{t.landing.tools_col_name}</span>
          <span>{t.landing.tools_col_content}</span>
          <span>{t.landing.tools_col_format}</span>
        </div>
        {TOOLS.map((tool, i) => (
          <div
            key={tool.id}
            className="grid grid-cols-1 sm:grid-cols-[160px_1fr_220px]"
            style={{
              padding: "14px 16px",
              gap: 8,
              borderBottom: i === TOOLS.length - 1 ? "none" : "1px solid var(--aurora-border)",
              alignItems: "center",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 28, height: 28, borderRadius: 8,
                  background: "var(--aurora-surface-solid)",
                  border: "1px solid var(--aurora-border)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <BrandMark id={tool.id} size={18} colored />
              </div>
              <span style={{ fontSize: 14, fontWeight: 500, color: "var(--aurora-fg1)", letterSpacing: "-0.01em" }}>
                {tool.name}
              </span>
            </div>
            <span style={{ fontSize: 13, color: "var(--aurora-fg3)" }}>{tool.content}</span>
            <span
              style={{
                fontSize: 11,
                color: "var(--aurora-fg4)",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              {tool.format}
            </span>
          </div>
        ))}
      </Glass>
    </section>
  );
}
