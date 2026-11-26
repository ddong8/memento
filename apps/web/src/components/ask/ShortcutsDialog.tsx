"use client";

// ⌘/ (Ctrl+/ elsewhere): the AI 执事 page's keyboard shortcuts.
import { useEffect } from "react";
import { Icon } from "@/components/aurora/Icon";

export const ASK_SHORTCUTS: readonly { keys: string[]; zh: string; en: string }[] = [
  { keys: ["Mod", "K"], zh: "聚焦输入框（历史打开时搜索历史）", en: "Focus the input (search history when open)" },
  { keys: ["Mod", "Shift", "O"], zh: "新建对话", en: "New conversation" },
  { keys: ["Mod", "Shift", "H"], zh: "历史对话", en: "Conversation history" },
  { keys: ["Mod", "J"], zh: "打开终端", en: "Open the terminal" },
  { keys: ["Mod", "Shift", "G"], zh: "代码改动、提交与 PR", en: "Changes, commit and PRs" },
  { keys: ["Mod", "Shift", "A"], zh: "切换权限模式（Claude Code）", en: "Cycle permission mode (Claude Code)" },
  { keys: ["Mod", "."], zh: "停止运行（也可以按 Esc）", en: "Stop the run (or Esc)" },
  { keys: ["Mod", "Shift", "E"], zh: "导出为 Markdown", en: "Export as Markdown" },
  { keys: ["Mod", "/"], zh: "快捷键一览", en: "Keyboard shortcuts" },
];

export function keyLabel(k: string, isMac: boolean): string {
  if (k === "Mod") return isMac ? "⌘" : "Ctrl";
  if (k === "Shift") return isMac ? "⇧" : "Shift";
  return k;
}

export function ShortcutsDialog({ open, onClose, isZh }: { open: boolean; onClose: () => void; isZh: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal="true" data-testid="shortcuts-dialog">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] shadow-2xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Icon name="command" size={15} style={{ color: "var(--aurora-accent)" }} />
          <div className="text-[14px] font-semibold text-[var(--aurora-fg1)] flex-1">{isZh ? "快捷键" : "Keyboard shortcuts"}</div>
          <button type="button" onClick={onClose} className="p-1 text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] cursor-pointer" aria-label={isZh ? "关闭" : "Close"}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="flex flex-col divide-y divide-[var(--aurora-border)]">
          {ASK_SHORTCUTS.map((s) => (
            <div key={s.keys.join("+")} className="flex items-center gap-3 py-2">
              <span className="flex-1 text-[12.5px] text-[var(--aurora-fg2)]">{isZh ? s.zh : s.en}</span>
              <span className="flex items-center gap-1 shrink-0">
                {s.keys.map((k) => (
                  <kbd key={k} className="min-w-[22px] text-center px-1.5 py-0.5 rounded-md border border-[var(--aurora-border)] bg-[var(--aurora-chip)] text-[11px] font-mono text-[var(--aurora-fg1)]">
                    {keyLabel(k, isMac)}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
