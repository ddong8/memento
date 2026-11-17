"use client";

import { useState } from "react";
import { Icon } from "@/components/aurora/Icon";
import { fetchWholeSession, hiddenLabel } from "@/lib/session-preview";

/**
 * Stands where a session preview's missing messages are (above them newest-first, below them
 * oldest-first) and swaps in the whole session when pressed.
 */
export function MoreMessages<M>({
  projectId, conversationId, hidden, order, locale, onLoaded,
}: {
  projectId: string;
  conversationId: string;
  hidden: number;
  order: "asc" | "desc";
  locale: string;
  onLoaded: (messages: M[]) => void;
}) {
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const zh = locale === "zh-CN";
  const load = async () => {
    setState("loading");
    try {
      onLoaded(await fetchWholeSession<M>(projectId, conversationId));
    } catch {
      setState("failed");
    }
  };
  return (
    <div style={{ display: "flex", justifyContent: "center", margin: "12px 0" }}>
      <button
        type="button"
        onClick={load}
        disabled={state === "loading"}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          fontSize: 12, fontWeight: 500,
          color: state === "failed" ? "var(--aurora-danger)" : "var(--aurora-accent)",
          background: state === "failed" ? "var(--aurora-danger-soft)" : "var(--aurora-accent-soft)",
          border: 0, borderRadius: 9999, padding: "6px 14px",
          cursor: state === "loading" ? "default" : "pointer",
          opacity: state === "loading" ? 0.7 : 1,
        }}
      >
        <Icon name={order === "desc" ? "chevron_up" : "chevron_down"} size={12} />
        {state === "loading"
          ? zh ? "正在加载…" : "Loading…"
          : state === "failed"
            ? zh ? "加载失败，点此重试" : "Failed — retry"
            : hiddenLabel(hidden, order, locale)}
      </button>
    </div>
  );
}
