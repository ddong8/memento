"use client";

import { useState } from "react";
import { authFetch, getApiBase } from "@/lib/api-client";
import { Icon } from "@/components/aurora/Icon";
import { Btn, Glass, SectionLabel } from "@/components/aurora/primitives";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";

export interface BusinessCheck {
  rules: number;
  ok: number;
  warn: number;
  fail: number;
  flows: number;
  terms: number;
  states: number;
  problems: string[];
}

const AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "agy", label: "Antigravity" },
];

/** The generated regions are for agents and the check: the page shows their numbers above instead. */
export function withoutGeneratedRegions(md: string): string {
  return md
    .replace(/<!-- memento:business-index:start[\s\S]*?<!-- memento:business-index:end -->\n?/, "")
    .replace(/\n?<!-- memento:business-check:start[\s\S]*?<!-- memento:business-check:end -->\n?/, "\n")
    .trim();
}

/**
 * BUSINESS_BLUEPRINT.md on the project page: what the user's rules for the project are tied to in the code,
 * how the last check went, the rules no entry carries yet, and an agent sent to write or update the file.
 */
export function BusinessBlueprintCard({
  projectId,
  blueprint,
  check,
  uncovered,
  rulesTotal,
  isZh,
}: {
  projectId: string;
  blueprint?: string | null;
  check?: BusinessCheck | null;
  uncovered: string[];
  rulesTotal: number;
  isZh: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [agent, setAgent] = useState("claude");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setSending(true);
    setError(null);
    try {
      const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/business-blueprint/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ binary: agent }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data?.detail === "string" ? data.detail : `HTTP ${res.status}`);
      const status = data?.task?.status === "failed" ? (isZh ? "派发失败（设备离线？）" : "failed (device offline?)") : isZh ? "已开始" : "started";
      setSent(
        isZh
          ? `${status}：${data.device} 上的 ${AGENTS.find((a) => a.id === agent)?.label} 在 ${data.cwd} 里写业务蓝图（带上了你的 ${data.rules} 条项目规则），写完随设备下次上传出现在这里。`
          : `${status}: ${AGENTS.find((a) => a.id === agent)?.label} on ${data.device} writes it in ${data.cwd}; it shows here after the device's next upload.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const chip = (label: string, color: string) => (
    <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 999, border: `1px solid ${color}`, color, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{label}</span>
  );

  return (
    <div style={{ marginBottom: 24 }} data-testid="business-blueprint">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, margin: "8px 4px 12px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Icon name="target" size={16} style={{ color: "var(--aurora-accent)" }} />
          <SectionLabel style={{ margin: 0 }}>{isZh ? "业务蓝图 (BUSINESS_BLUEPRINT.md)" : "Business Blueprint (BUSINESS_BLUEPRINT.md)"}</SectionLabel>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            aria-label={isZh ? "用哪个智能体写" : "Agent"}
            style={{ fontSize: 12, padding: "4px 6px", borderRadius: 8, border: "1px solid var(--aurora-border)", background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}
          >
            {AGENTS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          <Btn size="sm" icon="sparkles" onClick={generate} disabled={sending} title={isZh ? "派智能体到这个仓库所在的设备，按你的项目规则写或更新业务蓝图，并核对到没有 ❌" : "Send an agent to write or update it"}>
            {sending ? (isZh ? "派发中…" : "Sending…") : blueprint ? (isZh ? "派智能体更新" : "Update with an agent") : isZh ? "派智能体生成" : "Generate with an agent"}
          </Btn>
          {blueprint && (
            <Btn variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
              {expanded ? (isZh ? "收起" : "Collapse") : isZh ? "展开全文" : "Expand"}
            </Btn>
          )}
        </div>
      </div>
      <Glass padding={18} radius={18}>
        {check ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
            {chip(`${isZh ? "规则" : "Rules"} ${check.rules}`, "var(--aurora-fg2)")}
            {chip(`✅ ${check.ok}`, "#10b981")}
            {chip(`⚠️ ${check.warn}`, "#d97706")}
            {chip(`❌ ${check.fail}`, check.fail ? "#dc2626" : "var(--aurora-fg3)")}
            {chip(`${isZh ? "流程" : "Flows"} ${check.flows}`, "var(--aurora-fg3)")}
            {chip(`${isZh ? "术语" : "Terms"} ${check.terms}`, "var(--aurora-fg3)")}
            {chip(`${isZh ? "状态" : "States"} ${check.states}`, "var(--aurora-fg3)")}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: "var(--aurora-fg3)", margin: "0 0 12px" }}>
            {blueprint
              ? isZh
                ? "这份业务蓝图还没被生成器核对过（设备上的生成器更新后会自动核对）。"
                : "Not checked yet."
              : isZh
                ? "这个项目还没有业务蓝图。它把你给项目定的规则、术语、流程和状态归属挂到代码和测试上，每次提交自动核对，用来发现「规则和代码对不上」的问题。"
                : "No business blueprint yet: it ties your rules for the project to the code and tests, checked on every commit."}
          </p>
        )}
        {check && check.problems.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--aurora-fg2)", marginBottom: 4 }}>{isZh ? "需要处理" : "To fix"}</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--aurora-fg2)", lineHeight: 1.7 }}>
              {check.problems.slice(0, 12).map((p, i) => (
                <li key={i} style={{ wordBreak: "break-word" }}>
                  {p}
                </li>
              ))}
            </ul>
          </div>
        )}
        {uncovered.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#d97706", marginBottom: 4 }}>
              {isZh ? `你给这个项目定的 ${rulesTotal} 条规则里，有 ${uncovered.length} 条业务蓝图还没写` : `${uncovered.length} of your ${rulesTotal} rules for this project aren't in it yet`}
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--aurora-fg2)", lineHeight: 1.7 }}>
              {uncovered.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        {sent && <p style={{ fontSize: 12.5, color: "var(--aurora-accent)", margin: "0 0 12px" }}>{sent}</p>}
        {error && <p style={{ fontSize: 12.5, color: "#dc2626", margin: "0 0 12px" }}>{error}</p>}
        {blueprint && (
          <div style={{ maxHeight: expanded ? "none" : 260, overflow: expanded ? "visible" : "hidden", position: "relative" }}>
            <MarkdownViewer content={withoutGeneratedRegions(blueprint)} />
            {!expanded && (
              <div
                onClick={() => setExpanded(true)}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 64,
                  background: "linear-gradient(to bottom, transparent, var(--aurora-surface-solid))",
                  display: "flex",
                  alignItems: "flex-end",
                  justifyContent: "center",
                  paddingBottom: 6,
                  cursor: "pointer",
                  fontSize: 12,
                  color: "var(--aurora-accent)",
                }}
              >
                {isZh ? "点击展开完整业务蓝图 ▾" : "Expand ▾"}
              </div>
            )}
          </div>
        )}
      </Glass>
    </div>
  );
}
