"use client";

import { useEffect, useState } from "react";
import { api, type AgentRunSettings } from "@/lib/api-client";
import { Glass, SectionLabel } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";

const WINDOWS: { value: number; label: string; hint: string }[] = [
  { value: 200_000, label: "20 万", hint: "最省额度" },
  { value: 300_000, label: "30 万", hint: "折中" },
  { value: 500_000, label: "50 万", hint: "保留更多细节" },
  { value: 0, label: "跟随 Claude Code", hint: "约 96.7 万才压缩" },
];

const wan = (n: number) => `${Math.round(n / 10_000)} 万`;

// Kept across tab switches so the card shows at once
let cached: AgentRunSettings | null = null;

/** Claude Code's auto-compact window for memento's runs, and when a resume starts from a snapshot. */
export function AgentRunSettingsCard() {
  const [settings, setSettings] = useState<AgentRunSettings | null>(() => cached);
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getAgentRunSettings()
      .then((s) => {
        cached = s;
        setSettings(s);
      })
      .catch(() => setError("没读到当前设置，稍后再试"));
  }, []);

  const choose = async (value: number) => {
    if (!settings || saving !== null || value === settings.claude_auto_compact_window) return;
    setSaving(value);
    setError(null);
    try {
      const next = await api.updateAgentRunSettings({ claude_auto_compact_window: value });
      cached = next;
      setSettings(next);
    } catch {
      setError("保存失败，请重试");
    } finally {
      setSaving(null);
    }
  };

  const current = settings?.claude_auto_compact_window;

  return (
    <Glass className="p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Icon name="sparkles" size={16} style={{ color: "#10B981" }} />
        <SectionLabel>Claude Code 上下文压缩</SectionLabel>
      </div>
      <p className="text-xs text-[var(--aurora-fg3)] leading-relaxed">
        Claude Code 每执行一步都要带上整段上下文，会话越长每步越贵。memento 用 claude -p 运行它，Claude Code
        自带的空闲压缩不生效，1M 上下文的模型要到约 96.7 万 token 才自动压缩。这里设定上下文涨到多少时自动压缩：
        用最近 7 个大会话回放，设为 20 万总消耗少约 22%。
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {WINDOWS.map((w) => {
          const active = current === w.value;
          return (
            <button
              key={w.value}
              type="button"
              disabled={!settings || saving !== null}
              onClick={() => choose(w.value)}
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                textAlign: "left",
                cursor: settings && saving === null ? "pointer" : "default",
                background: active ? "rgba(16,185,129,0.10)" : "var(--aurora-chip)",
                border: `1px solid ${active ? "rgba(16,185,129,0.55)" : "var(--aurora-border)"}`,
                transition: "background .15s, border-color .15s",
              }}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-semibold" style={{ color: active ? "#10B981" : "var(--aurora-fg1)" }}>
                  {w.label}
                </span>
                {active && <Icon name="check" size={13} style={{ color: "#10B981" }} />}
                {saving === w.value && <span className="text-[11px] text-[var(--aurora-fg4)]">保存中…</span>}
              </div>
              <div className="text-[11px] text-[var(--aurora-fg4)] mt-0.5">
                {w.hint}
                {settings && w.value === settings.default_auto_compact_window ? " · 默认" : ""}
              </div>
            </button>
          );
        })}
      </div>
      <div className="text-[11px] text-[var(--aurora-fg4)] leading-relaxed space-y-1">
        {settings && (
          <div>
            续接超过 {wan(settings.heavy_context_tokens)} token 的会话时，默认先生成核心记忆快照再开新会话接着做；对话页的续接横幅里可以改回原生接续。
          </div>
        )}
        <div>设备上的 Memento 要 1.0.85 及以上才会按这里的设置压缩。</div>
      </div>
      {error && <div className="text-xs text-red-500">{error}</div>}
    </Glass>
  );
}
