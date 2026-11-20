"use client";

import { memo, type RefObject } from "react";
import { Icon } from "@/components/aurora/Icon";

export interface AttachedImageItem {
  id: string;
  name: string;
  dataUrl: string;
  size: number;
}

export interface BackgroundTaskItem {
  id: string;
  description?: string;
}

export interface SuggestedDeviceItem {
  reason: string;
  device: {
    device_id: string;
    name: string;
  };
}

export const SpeechHintPill = memo(function SpeechHintPill({
  speechHint,
  onDismiss,
}: {
  speechHint: string | null;
  onDismiss: () => void;
}) {
  if (!speechHint) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "5px 12px",
        marginBottom: 6,
        borderRadius: 10,
        background: "rgba(124, 58, 237, 0.12)",
        border: "1px solid rgba(124, 58, 237, 0.3)",
        fontSize: 12,
        color: "#A78BFA",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Icon name="microphone" size={13} />
        <span>{speechHint}</span>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        style={{
          background: "none",
          border: "none",
          color: "inherit",
          cursor: "pointer",
          fontSize: 13,
          opacity: 0.7,
          padding: "0 4px",
        }}
      >
        ✕
      </button>
    </div>
  );
});

export const BackgroundTasksBanner = memo(function BackgroundTasksBanner({
  streaming,
  backgroundTasks,
  isZh,
}: {
  streaming: boolean;
  backgroundTasks: readonly BackgroundTaskItem[];
  isZh: boolean;
}) {
  if (!streaming || backgroundTasks.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        margin: "0 2px 8px 2px",
        padding: "6px 10px",
        borderRadius: 10,
        border: "1px solid var(--aurora-border)",
        background: "var(--aurora-chip)",
        fontSize: 12.5,
        color: "var(--aurora-fg2)",
      }}
      title={backgroundTasks.map((b) => b.description || b.id).join("\n")}
    >
      <Icon name="refresh" size={12} className="animate-spin" />
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {isZh
          ? `还在等 ${backgroundTasks.length} 个后台任务：${backgroundTasks.map((b) => b.description || b.id).join("、")}`
          : `Waiting on ${backgroundTasks.length} background task(s): ${backgroundTasks.map((b) => b.description || b.id).join(", ")}`}
      </span>
      <span className="hidden sm:inline" style={{ flexShrink: 0, fontSize: 11, color: "var(--aurora-fg3)" }}>
        {isZh ? "结束后本轮才完成，点停止会一起结束" : "The reply ends with them; Stop ends them too"}
      </span>
    </div>
  );
});

export const AttachedImagesPreview = memo(function AttachedImagesPreview({
  attachedImages,
  isZh,
  onRemove,
}: {
  attachedImages: readonly AttachedImageItem[];
  isZh: boolean;
  onRemove: (id: string) => void;
}) {
  if (attachedImages.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        padding: "4px 2px 10px 2px",
        alignItems: "center",
      }}
    >
      {attachedImages.map((img) => (
        <div
          key={img.id}
          style={{
            position: "relative",
            borderRadius: 10,
            overflow: "hidden",
            border: "1px solid var(--aurora-border)",
            background: "rgba(0,0,0,0.25)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
          }}
        >
          <img
            src={img.dataUrl}
            alt={img.name}
            style={{
              width: 48,
              height: 48,
              objectFit: "cover",
              display: "block",
            }}
          />
          <button
            type="button"
            onClick={() => onRemove(img.id)}
            title={isZh ? "移除图片" : "Remove image"}
            style={{
              position: "absolute",
              top: 2,
              right: 2,
              width: 16,
              height: 16,
              borderRadius: 999,
              background: "rgba(0,0,0,0.75)",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 10,
              border: "none",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <span style={{ fontSize: 11, color: "var(--aurora-fg3)" }}>
        {isZh ? `已附加 ${attachedImages.length} 张图片` : `${attachedImages.length} image(s) attached`}
      </span>
    </div>
  );
});

export const WaitingQuestionBanner = memo(function WaitingQuestionBanner({
  activeWaitingQuestion,
  isZh,
  bottomRef,
}: {
  activeWaitingQuestion: { taskId?: string; question?: unknown } | null;
  isZh: boolean;
  bottomRef: RefObject<HTMLDivElement | null>;
}) {
  if (!activeWaitingQuestion) return null;
  const q = activeWaitingQuestion.question as { id?: string; question?: string } | undefined;
  return (
    <div
      onClick={() => {
        const targetId = `question-prompt-${q?.id || activeWaitingQuestion.taskId || "active"}`;
        const el = document.getElementById(targetId);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        } else {
          bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
        }
      }}
      style={{
        margin: "0 0 8px 0",
        padding: "7px 12px",
        borderRadius: 10,
        background: "var(--aurora-warn-soft, rgba(217, 119, 6, 0.12))",
        border: "1px solid rgba(245,158,11,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        cursor: "pointer",
        boxShadow: "0 2px 10px rgba(245,158,11,0.12)",
      }}
      className="animate-pulse"
      title={isZh ? "点击定位到提问并进行回复" : "Click to view and answer the question"}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, flex: 1 }}>
        <span style={{ color: "#D97706", display: "flex", flexShrink: 0 }}>
          <Icon name="message" size={14} />
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "#B45309", whiteSpace: "nowrap", flexShrink: 0 }}>
          {isZh ? "Agent 等待确认" : "Agent waiting"}
        </span>
        <span style={{ fontSize: 12, color: "var(--aurora-fg2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {q?.question || (isZh ? "请回复..." : "Please respond...")}
        </span>
      </div>
      <span
        style={{
          fontSize: 11.5,
          fontWeight: 600,
          color: "var(--aurora-accent)",
          background: "var(--aurora-surface-solid)",
          padding: "2px 8px",
          borderRadius: 6,
          border: "1px solid var(--aurora-border-strong)",
          flexShrink: 0,
        }}
      >
        {isZh ? "立即回复 ↓" : "Respond ↓"}
      </span>
    </div>
  );
});

export const SuggestedDevicePill = memo(function SuggestedDevicePill({
  suggestedDevice,
  configLocked,
  isZh,
  onSwitch,
}: {
  suggestedDevice: SuggestedDeviceItem | null;
  configLocked: boolean;
  isZh: boolean;
  onSwitch: (deviceId: string) => void;
}) {
  if (!suggestedDevice || configLocked) return null;
  return (
    <div
      style={{
        margin: "0 0 8px 0",
        padding: "6px 12px",
        borderRadius: 9,
        background: "rgba(49, 134, 255, 0.1)",
        border: "1px solid rgba(49, 134, 255, 0.3)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <Icon name="sparkles" size={13} style={{ color: "var(--aurora-accent)" }} />
        <span style={{ color: "var(--aurora-fg2)" }}>
          {suggestedDevice.reason}，{isZh ? "建议切换目标设备至：" : "recommended target device:"}
        </span>
        <strong style={{ color: "var(--aurora-fg1)" }}>{suggestedDevice.device.name}</strong>
      </div>
      <button
        type="button"
        onClick={() => onSwitch(suggestedDevice.device.device_id)}
        style={{
          padding: "2px 9px",
          borderRadius: 6,
          fontSize: 11.5,
          fontWeight: 600,
          border: "1px solid var(--aurora-accent)",
          background: "var(--aurora-accent)",
          color: "#fff",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        {isZh ? "一键切换" : "Switch"}
      </button>
    </div>
  );
});
