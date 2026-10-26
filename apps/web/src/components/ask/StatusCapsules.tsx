"use client";

import { Icon } from "@/components/aurora/Icon";
import { triggerHapticFeedback } from "@/lib/native-notify";

/** Floating pill while the network is down, and briefly once it's back. */
export function OfflineCapsule({ offline, recovered }: { offline: boolean; recovered: boolean }) {
  return (
    <>
      {offline && (
        <div
          style={{
            position: "fixed",
            top: 14,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 99999,
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            padding: "6px 14px",
            borderRadius: 20,
            background: "rgba(220, 38, 38, 0.92)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            color: "#fff",
            fontSize: 12,
            fontWeight: 500,
            boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
            animation: "pulse 2s infinite ease-in-out",
            pointerEvents: "none",
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff", display: "inline-block" }} />
          <span>网络已断开，正在等待恢复...</span>
        </div>
      )}
      {recovered && !offline && (
        <div
          style={{
            position: "fixed",
            top: 14,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 99999,
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            padding: "6px 14px",
            borderRadius: 20,
            background: "rgba(16, 185, 129, 0.92)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            color: "#fff",
            fontSize: 12,
            fontWeight: 500,
            boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
            pointerEvents: "none",
          }}
        >
          <Icon name="check" size={13} style={{ color: "#fff" }} />
          <span>网络已恢复连接</span>
        </div>
      )}
    </>
  );
}

export interface HandoffTask {
  id: string;
  title: string;
  device?: string;
}

/** A run that finished on another device: open its conversation here, or dismiss. */
export function HandoffCapsule({ task, onOpen, onDismiss }: { task: HandoffTask; onOpen: (id: string) => void; onDismiss: () => void }) {
  return (
      <div
        style={{
          position: "absolute",
          top: 52,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 45,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "7px 16px",
          borderRadius: 24,
          background: "var(--aurora-surface-solid)",
          border: "1px solid var(--aurora-accent)",
          boxShadow: "0 6px 22px rgba(109, 40, 217, 0.28)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          color: "var(--aurora-fg1)",
          fontSize: 12.5,
          animation: "fadeIn 0.2s ease-out",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--aurora-accent)", fontWeight: 600 }}>
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
          <span>跨端任务接力</span>
        </span>
        <span style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--aurora-fg2)" }}>
          {task.title}
        </span>
        <button
          type="button"
          onClick={() => {
              triggerHapticFeedback(15);
              onOpen(task.id);
            }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 10px",
            borderRadius: 14,
            background: "var(--aurora-accent)",
            border: "none",
            color: "#fff",
            fontSize: 11.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          <Icon name="sparkles" size={12} />
          <span>立即接力</span>
        </button>
        <button
          type="button"
          onClick={onDismiss}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--aurora-fg4)",
            cursor: "pointer",
            padding: "2px 4px",
            display: "inline-flex",
            alignItems: "center",
          }}
          title="忽略"
        >
          <Icon name="close" size={12} />
        </button>
      </div>
  );
}
