"use client";

import { Icon } from "@/components/aurora/Icon";

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
