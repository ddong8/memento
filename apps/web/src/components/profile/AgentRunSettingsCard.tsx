"use client";

import { useEffect, useState } from "react";
import { api, type AgentRunSettings } from "@/lib/api-client";
import { Glass, SectionLabel } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";
import { SmoothToggle } from "@/components/aurora/SmoothToggle";

// Kept across tab switches so the card shows at once
let cached: AgentRunSettings | null = null;

/** The client name Claude Code runs under in memento's runs. */
export function AgentRunSettingsCard() {
  const [settings, setSettings] = useState<AgentRunSettings | null>(() => cached);
  const [savingClient, setSavingClient] = useState(false);
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

  const setMementoClient = async (on: boolean) => {
    if (!settings || savingClient || on === settings.claude_memento_client) return;
    setSavingClient(true);
    setError(null);
    try {
      const next = await api.updateAgentRunSettings({ claude_memento_client: on });
      cached = next;
      setSettings(next);
    } catch {
      setError("保存失败，请重试");
    } finally {
      setSavingClient(false);
    }
  };

  return (
    <Glass className="p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Icon name="sparkles" size={16} style={{ color: "#10B981" }} />
        <SectionLabel>Claude Code 运行方式</SectionLabel>
      </div>
      <p className="text-xs text-[var(--aurora-fg3)] leading-relaxed">
        续接和在 Claude Code 里一样：一直在原会话里接着做，上下文由 Claude Code 按模型自己的大小压缩，会话号和标题都不变；
        只有你自己新建会话才会开新会话。唯一的例外是会话第一次换到另一台设备上续接（那台设备上没有原会话），
        这时用它的核心记忆快照在那台设备上开一个会话，之后都在这个会话里原样继续。
      </p>
      <div
        className="flex items-center justify-between gap-4 p-3.5 rounded-xl"
        style={{ background: "var(--aurora-surface, rgba(255, 255, 255, 0.55))", border: "1px solid var(--aurora-border)" }}
      >
        <div className="min-w-0">
          <div className="text-xs font-semibold text-[var(--aurora-fg1)]">
            以 Memento 身份运行
            {savingClient && <span className="ml-1.5 text-[11px] font-normal text-[var(--aurora-fg4)]">保存中…</span>}
          </div>
          <div className="text-[11px] text-[var(--aurora-fg3)] mt-0.5 leading-relaxed">
            claude -p 默认自称 sdk-cli：这样开的会话在终端 claude --resume 的列表里看不到，社区实测 5
            小时额度也掉得更快。打开后自称 memento，在 Memento 里新开的会话能直接在终端接着用。这个名字 Anthropic
            没写进文档，关掉即恢复 sdk-cli。设备上的 Memento 要 1.0.94 及以上。
          </div>
        </div>
        <SmoothToggle
          checked={settings?.claude_memento_client ?? true}
          onChange={setMementoClient}
          disabled={!settings || savingClient}
          size="sm"
        />
      </div>
      {error && <div className="text-xs text-red-500">{error}</div>}
    </Glass>
  );
}
