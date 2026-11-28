"use client";

import { useI18n } from "@/lib/i18n";
import { BrandMark } from "@/components/aurora/BrandMark";

const TOOLS = [
  { id: "claude_code", name: "Claude Code", content: "对话历史 · 记忆文件 · 计划与历史记录", format: "JSONL / Markdown" },
  { id: "openclaw",    name: "OpenClaw",    content: "会话记录 · 身份配置 · 技能与学习沉淀", format: "JSONL / Markdown" },
  { id: "codex",       name: "Codex",       content: "对话记录 · 执行计划 · 技能与状态", format: "JSONL / TOML / SQLite" },
  { id: "antigravity", name: "Antigravity", content: "完整对话流 · 实施计划 · 会话快照", format: "Markdown / Protobuf" },
  { id: "workbuddy",   name: "WorkBuddy",   content: "智能体任务 · 多模态文档与音视频产物", format: "Markdown / Office / Media" },
  { id: "cursor",      name: "Cursor",      content: "对话历史 · 技能规则 · MCP 配置", format: "JSONL / Markdown" },
  { id: "obsidian",    name: "Obsidian",    content: "个人知识库全部 Markdown 笔记", format: "Markdown" },
  { id: "hermes",      name: "Hermes",      content: "会话上下文 · 角色设定 · CLI 历史", format: "JSON / Markdown / SQLite" },
  { id: "windsurf",    name: "Windsurf",    content: "对话历史与项目规则文件", format: "JSONL / Markdown" },
  { id: "vscode",      name: "VS Code",     content: "工作区设置 · 扩展与编码规范", format: "JSON / Markdown" },
];

export function ToolMatrix() {
  const { t } = useI18n();
  return (
    <section
      id="tools"
      style={{ padding: "56px 20px", maxWidth: 1120, margin: "0 auto" }}
    >
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
          {t.landing.tools_title}
        </h2>
        <p style={{ margin: "10px 0 0", fontSize: 15, color: "var(--aurora-fg3)", lineHeight: 1.55 }}>
          {t.landing.tools_sub}
        </p>
      </div>

      <div
        style={{
          borderRadius: 14,
          background: "var(--aurora-surface-solid)",
          border: "1px solid var(--aurora-border-strong)",
          overflow: "hidden",
        }}
      >
        <div
          className="hidden sm:grid"
          style={{
            gridTemplateColumns: "180px 1fr 220px",
            padding: "11px 18px",
            borderBottom: "1px solid var(--aurora-border)",
            background: "var(--aurora-surface-mute)",
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--aurora-fg3)",
          }}
        >
          <span>{t.landing.tools_col_name}</span>
          <span>{t.landing.tools_col_content}</span>
          <span>{t.landing.tools_col_format}</span>
        </div>
        {TOOLS.map((tool, i) => (
          <div
            key={tool.id}
            className="grid grid-cols-1 sm:grid-cols-[180px_1fr_220px] hover:bg-[var(--aurora-chip)] transition-colors duration-150"
            style={{
              padding: "13px 18px",
              gap: 8,
              borderBottom: i === TOOLS.length - 1 ? "none" : "1px solid var(--aurora-border)",
              alignItems: "center",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  background: "var(--aurora-bg)",
                  border: "1px solid var(--aurora-border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <BrandMark id={tool.id} size={16} colored />
              </div>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.01em" }}>
                {tool.name}
              </span>
            </div>
            <span style={{ fontSize: 13.5, color: "var(--aurora-fg2)" }}>{tool.content}</span>
            <span
              style={{
                fontSize: 12.5,
                color: "var(--aurora-fg4)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {tool.format}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
