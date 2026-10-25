"use client";

import { memo,useEffect,useMemo,useRef,useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { Glass } from "@/components/aurora/primitives";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";
import { ExecutionTabs } from "@/components/ExecutionCard";
import { Source,Turn,formatTurnDuration,formatTurnTimestamp,parseTurnContent } from "@/lib/ask/turns";
import { ImageViewerModal } from "@/components/viewers/ImageViewerModal";
import { FiZoomIn } from "react-icons/fi";
import { showInAppToast, triggerHapticFeedback } from "@/lib/native-notify";
import { api } from "@/lib/api-client";
import { useMediaInspector, extractMediaFromMarkdown } from "@/components/viewers/MediaInspectorContext";

function ThinkingBlock({ thinking, isLive }: { thinking: string; isLive?: boolean }) {
  const { t } = useI18n();
  const [userToggled, setUserToggled] = useState<boolean>(false);
  const [manualExpanded, setManualExpanded] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const startTimeRef = useRef<number | null>(null);
  const finalDurationRef = useRef<number | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isLive) {
      if (!startTimeRef.current) startTimeRef.current = Date.now();
      const interval = setInterval(() => {
        if (startTimeRef.current) {
          setElapsedSec((Date.now() - startTimeRef.current) / 1000);
        }
      }, 100);
      return () => clearInterval(interval);
    } else {
      if (startTimeRef.current && finalDurationRef.current === null) {
        finalDurationRef.current = Math.max(0.1, (Date.now() - startTimeRef.current) / 1000);
      }
    }
  }, [isLive]);

  // 始终保持铺满全屏展开，除非用户手动点击折叠
  const expanded = userToggled ? manualExpanded : true;

  if (!thinking && !isLive) return null;

  const charCount = thinking.trim().length;
  const countLabel = charCount > 0 ? `${charCount.toLocaleString()} 字` : "";
  const duration = isLive ? elapsedSec : (finalDurationRef.current ?? elapsedSec);
  const durLabel = duration > 0 ? `${duration.toFixed(1)}s` : "";
  const speedLabel = (!isLive && duration > 0.5 && charCount > 10) ? `约 ${Math.round(charCount / duration)} 字/秒` : "";

  return (
    <>
      <div
        style={{
          width: "100%",
          marginBottom: 8,
          borderRadius: 10,
          border: "1px solid var(--aurora-border)",
          background: "rgba(255, 255, 255, 0.02)",
          overflow: "hidden",
          maxWidth: "100%",
          minWidth: 0,
        }}
      >
        <button
          type="button"
          onClick={() => {
            setUserToggled(true);
            setManualExpanded(!expanded);
          }}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "5px 8px",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: 12,
            color: "var(--aurora-fg3)",
            textAlign: "left",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
            <Icon
              name="zap"
              size={14}
              style={{
                color: isLive ? "var(--aurora-accent)" : "#F59E0B",
                animation: isLive ? "pulse 1.5s infinite" : "none",
                flexShrink: 0,
              }}
            />
            <span style={{ fontWeight: 500, color: isLive ? "var(--aurora-accent)" : "var(--aurora-fg2)", whiteSpace: "nowrap" }}>
              {isLive ? t.ask.thinking : t.ask.thinkingDone}
            </span>
            {isLive ? (
              <span style={{ fontSize: 11, color: "var(--aurora-fg4)", opacity: 0.85, fontVariantNumeric: "tabular-nums" }}>
                ({durLabel ? `推演中 ${durLabel}` : "推演中"}{countLabel ? ` · ${countLabel}` : ""})
              </span>
            ) : (
              <span style={{ fontSize: 11, color: "var(--aurora-fg4)", opacity: 0.85, fontVariantNumeric: "tabular-nums" }}>
                ({durLabel ? `耗时 ${durLabel}` : ""}{countLabel ? ` · 共 ${countLabel}` : ""}{speedLabel ? ` · ${speedLabel}` : ""})
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, color: "var(--aurora-fg4)", flexShrink: 0 }}>
            <span
              onClick={(e) => {
                e.stopPropagation();
                setIsFullscreen(true);
              }}
              className="hover:text-[var(--aurora-accent)] transition-colors p-1 rounded hover:bg-white/5 cursor-pointer flex items-center gap-1"
              title="沉浸式全屏查看完整思考推演"
            >
              <Icon name="maximize" size={12} />
              <span className="hidden sm:inline">全屏查看</span>
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span>{expanded ? t.ask.hideThinking : t.ask.showThinking}</span>
              <Icon name={expanded ? "chevron_up" : "chevron_down"} size={13} />
            </div>
          </div>
        </button>
        {expanded && (
          <div
            ref={scrollContainerRef}
            className="thinking-scroll-content"
            style={{
              width: "100%",
              borderTop: "1px solid var(--aurora-border)",
              padding: "8px 10px",
              background: "rgba(0, 0, 0, 0.12)",
              fontSize: 13,
              lineHeight: 1.6,
              color: "var(--aurora-fg2)",
              overflowWrap: "anywhere",
              wordBreak: "break-word",
              maxWidth: "100%",
              maxHeight: 480,
              overflowY: "auto",
            }}
          >
            <div className="prose prose-sm max-w-none w-full text-xs" style={{ opacity: 0.9, width: "100%", maxWidth: "100%" }}>
              <MarkdownViewer content={thinking || "..."} isStreaming={Boolean(isLive)} />
            </div>
          </div>
        )}
      </div>

      {/* 沉浸式全屏思考推演弹层 */}
      {isFullscreen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 99999,
            background: "rgba(10, 15, 29, 0.96)",
            backdropFilter: "blur(18px)",
            WebkitBackdropFilter: "blur(18px)",
            display: "flex",
            flexDirection: "column",
            padding: "clamp(12px, 3vw, 24px)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              paddingBottom: 12,
              borderBottom: "1px solid var(--aurora-border)",
              marginBottom: 14,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Icon
                name="zap"
                size={18}
                style={{
                  color: isLive ? "var(--aurora-accent)" : "#F59E0B",
                  animation: isLive ? "pulse 1.5s infinite" : "none",
                }}
              />
              <span style={{ fontSize: 16, fontWeight: 600, color: "var(--aurora-fg1)" }}>
                {isLive ? "深度心智思考推演中..." : "深度心智思考推演记录"}
              </span>
              <span style={{ fontSize: 12, color: "var(--aurora-fg3)" }}>
                {durLabel ? `(耗时 ${durLabel})` : ""} {countLabel ? `· ${countLabel}` : ""} {speedLabel ? `· ${speedLabel}` : ""}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setIsFullscreen(false)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 12px",
                borderRadius: 8,
                background: "var(--aurora-chip)",
                border: "1px solid var(--aurora-border)",
                color: "var(--aurora-fg1)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              <Icon name="close" size={14} />
              <span>退出全屏</span>
            </button>
          </div>
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "16px 20px",
              background: "rgba(0, 0, 0, 0.2)",
              borderRadius: 14,
              border: "1px solid var(--aurora-border)",
            }}
          >
            <div className="prose prose-base max-w-4xl mx-auto w-full text-sm leading-relaxed" style={{ color: "var(--aurora-fg2)" }}>
              <MarkdownViewer content={thinking || "..."} isStreaming={Boolean(isLive)} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
export interface UserBubbleProps {
  index: number;
  content: string;
  images?: string[];
  createdAt?: string;
  onShareTurn?: (index: number) => void;
}

function areUserPropsEqual(prev: UserBubbleProps, next: UserBubbleProps) {
  if (prev.content !== next.content) return false;
  if (prev.createdAt !== next.createdAt) return false;
  if (prev.index !== next.index) return false;
  const prevImgs = prev.images || [];
  const nextImgs = next.images || [];
  if (prevImgs.length !== nextImgs.length) return false;
  for (let i = 0; i < prevImgs.length; i++) {
    if (prevImgs[i] !== nextImgs[i]) return false;
  }
  return true;
}

export const UserBubble = memo(function UserBubble({
  index,
  content,
  images,
  createdAt,
  onShareTurn,
}: UserBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const timeInfo = formatTurnTimestamp(createdAt) || (content ? { short: "刚刚", full: "提问时间已记录" } : null);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!content) return;
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      triggerHapticFeedback(12);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  return (
    <div className="group/user relative flex justify-end">
      <div
        className="select-text"
        style={{
          background: "var(--aurora-accent-soft)",
          color: "var(--aurora-fg1)",
          padding: "7px 10px 5px 10px",
          borderRadius: 12,
          maxWidth: "min(96%, 720px)",
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          boxShadow: "0 2px 10px rgba(0,0,0,0.1)",
          display: "flex",
          flexDirection: "column",
          gap: 5,
          userSelect: "text",
          WebkitUserSelect: "text",
        }}
      >
        {images && images.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: content ? 4 : 0,
            }}
          >
            {images.map((imgUrl, idx) => (
              <div
                key={idx}
                className="group/img relative overflow-hidden rounded-xl border border-white/20 shadow-md cursor-zoom-in transition-all hover:border-[var(--aurora-accent)] hover:shadow-lg hover:scale-[1.01]"
                style={{
                  maxWidth: images.length === 1 ? "100%" : 240,
                  maxHeight: 280,
                  background: "rgba(0,0,0,0.25)",
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setLightboxIndex(idx);
                }}
                title="点击就地放大查看高清图片"
              >
                <img
                  src={imgUrl}
                  alt={`Attachment ${idx + 1}`}
                  loading="lazy"
                  decoding="async"
                  style={{
                    display: "block",
                    maxWidth: "100%",
                    maxHeight: 280,
                    objectFit: "contain",
                    borderRadius: 12,
                  }}
                />
                <div className="absolute inset-0 bg-black/25 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center text-white pointer-events-none">
                  <span className="p-2 rounded-full bg-black/60 backdrop-blur-md shadow-md transform scale-90 group-hover/img:scale-100 transition-transform">
                    <FiZoomIn className="w-4 h-4 text-white" />
                  </span>
                </div>
              </div>
            ))}

            {lightboxIndex !== null && (
              <ImageViewerModal
                images={images}
                initialIndex={lightboxIndex}
                isOpen={lightboxIndex !== null}
                onClose={() => setLightboxIndex(null)}
              />
            )}
          </div>
        )}
        {content && (
          <div
            className="prose prose-sm max-w-none flex-1 select-text"
            style={{
              fontSize: 14,
              lineHeight: 1.55,
              whiteSpace: "normal",
              color: "var(--aurora-fg1)",
              userSelect: "text",
              WebkitUserSelect: "text",
            }}
          >
            <MarkdownViewer content={content} compactText={true} />
          </div>
        )}
        {(timeInfo || content) && (
          <div className="flex items-center justify-end gap-2 pt-0.5 select-none">
            {timeInfo && (
              <span
                className="inline-flex items-center gap-1 text-[11px] text-[var(--aurora-fg3)] opacity-80"
                style={{ fontVariantNumeric: "tabular-nums" }}
                title={`发出提问时间: ${timeInfo.full}`}
              >
                <Icon name="clock" size={10.5} />
                <span>{timeInfo.short}</span>
              </span>
            )}
            {onShareTurn && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onShareTurn(index);
                }}
                className="opacity-60 group-hover/user:opacity-100 transition-opacity p-0.5 text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] rounded hover:bg-white/10 select-none shrink-0 cursor-pointer"
                title="分享此问答"
              >
                <Icon name="share" size={12} />
              </button>
            )}
            {content && (
              <button
                type="button"
                onClick={handleCopy}
                className="opacity-60 group-hover/user:opacity-100 transition-opacity p-0.5 text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] rounded hover:bg-white/10 select-none shrink-0 cursor-pointer"
                title="复制提问"
              >
                <Icon name={copied ? "check" : "copy"} size={12} style={{ color: copied ? "#10b981" : undefined }} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}, areUserPropsEqual);

export interface AssistantBubbleProps {
  index: number;
  turn: Turn;
  isLast: boolean;
  streaming: boolean;
  isReconnecting?: boolean;
  prevUserCreatedAt?: string;
  onSourcesClick: (sources: Source[]) => void;
  onSmartCompactAndRetry: (sid?: string) => void;
  onRetry?: () => void;
  onShareTurn?: (index: number) => void;
  t: any;
}

function areAssistantPropsEqual(prev: AssistantBubbleProps, next: AssistantBubbleProps) {
  if (prev.isLast !== next.isLast) return false;
  if (prev.streaming !== next.streaming) return false;
  if (prev.isReconnecting !== next.isReconnecting) return false;
  if (prev.index !== next.index) return false;
  if (prev.prevUserCreatedAt !== next.prevUserCreatedAt) return false;
  if (prev.t !== next.t) return false;
  if (prev.turn !== next.turn) {
    if (prev.turn.content !== next.turn.content) return false;
    if (prev.turn.thinking !== next.turn.thinking) return false;
    if (prev.turn.duration_ms !== next.turn.duration_ms) return false;
    if (prev.turn.toolCalls !== next.turn.toolCalls) return false;
    if (prev.turn.created_at !== next.turn.created_at) return false;
    if (prev.turn.cached !== next.turn.cached) return false;
  }
  return true;
}

export const AssistantBubble = memo(function AssistantBubble({
  index,
  turn,
  isLast,
  streaming,
  isReconnecting,
  prevUserCreatedAt,
  onSourcesClick,
  onSmartCompactAndRetry,
  onRetry,
  onShareTurn,
  t,
}: AssistantBubbleProps) {
  const liveAgentStdout = useMemo(() => {
    if (turn.content && turn.content.trim().length > 0) return "";
    if (!turn.toolCalls || turn.toolCalls.length === 0) return "";
    const parts: string[] = [];
    for (const c of turn.toolCalls) {
      const act = c.result?.action || (c.args?.action as string) || (c.name === "run_on_device" ? "shell" : c.name);
      const bin = ((c.args?.binary as string) || (c as any).binary || (c.result as any)?.binary || "").toLowerCase();
      const isAgentCall = act === "agent" || bin.length > 0;
      if (isAgentCall && c.result?.stdout?.trim()) {
        parts.push(c.result.stdout);
      }
    }
    return parts.join("\n\n");
  }, [turn.content, turn.toolCalls]);

  const effectiveTurn = useMemo(
    () => (turn.content ? turn : liveAgentStdout ? { ...turn, content: liveAgentStdout } : turn),
    [turn, liveAgentStdout]
  );
  const { thinking, content } = parseTurnContent(effectiveTurn);
  const isCurrentlyStreaming = Boolean(streaming && isLast);
  const isThinkingActive = Boolean(isCurrentlyStreaming && !content);
  const hasTools = Boolean(turn.toolCalls && turn.toolCalls.length > 0);
  const [copied, setCopied] = useState(false);
  const inspector = useMediaInspector();

  const { locale } = useI18n();
  const isZh = locale ? locale.startsWith("zh") : true;
  const replyTime = formatTurnTimestamp(turn.created_at) || (turn.finished_at ? formatTurnTimestamp(turn.finished_at) : null);
  const startTime = formatTurnTimestamp(turn.started_at || prevUserCreatedAt);
  const durationText = formatTurnDuration(turn.duration_ms, turn.started_at || prevUserCreatedAt, turn.created_at || turn.finished_at, isZh);

  const contentCharCount = content ? content.trim().length : 0;
  const durSec = turn.duration_ms
    ? turn.duration_ms / 1000
    : (turn.started_at || prevUserCreatedAt) && turn.created_at
    ? (new Date(turn.created_at).getTime() - new Date(turn.started_at || prevUserCreatedAt!).getTime()) / 1000
    : 0;
  const speedLabel = (!isCurrentlyStreaming && durSec > 0.5 && contentCharCount > 20)
    ? isZh
      ? `约\u00A0${Math.round(contentCharCount / durSec)}\u00A0字/秒`
      : `~${Math.round(contentCharCount / durSec)}\u00A0char/s`
    : "";

  const handleCopyContent = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!content) return;
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      triggerHapticFeedback(12);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const [savedTodo, setSavedTodo] = useState(false);
  const handleSaveToTodo = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!content || savedTodo) return;
    try {
      triggerHapticFeedback(15);
      const firstLine = content.trim().split("\n")[0].replace(/^[#*\-\s]+/, "").slice(0, 60);
      const title = firstLine || "来自 AI 执事的重要纪要";
      await api.addTodo(title, { project: turn.model || "AI 执事" });
      setSavedTodo(true);
      showInAppToast("已存入工作待办", title);
      setTimeout(() => setSavedTodo(false), 3000);
    } catch {
      showInAppToast("保存失败", "请稍后重试");
    }
  };

  return (
    <div style={{ width: "100%" }}>
      <Glass padding="clamp(4px, 1.2vw, 16px)" radius={12} className="select-text ask-assistant-bubble-card" style={{ width: "100%", maxWidth: "100%", minWidth: 0, overflow: "hidden", userSelect: "text", WebkitUserSelect: "text" }}>
        {turn.sources && turn.sources.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", marginBottom: 10 }}>
            <button
              type="button"
              onClick={() => onSourcesClick(turn.sources || [])}
              title={t.ask.sources}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 10px",
                borderRadius: 999,
                background: "var(--aurora-chip)",
                border: "1px solid var(--aurora-border)",
                color: "var(--aurora-fg2)",
                fontSize: 12,
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              <Icon name="book" size={13} style={{ color: "var(--aurora-accent)" }} />
              <span>{t.ask.sources}</span>
              <span
                style={{
                fontSize: 10.5,
                padding: "1px 6px",
                borderRadius: 999,
                background: "rgba(56, 189, 248, 0.15)",
                color: "var(--aurora-accent)",
                fontWeight: 600,
              }}
            >
              {turn.sources.length}
            </span>
          </button>
        </div>
      )}
      {(thinking || isThinkingActive) && (
        <ThinkingBlock thinking={thinking} isLive={isThinkingActive} />
      )}
      {hasTools && (
        <div style={{ marginBottom: 12 }}>
          <ExecutionTabs
            calls={turn.toolCalls!}
            parentContent={content}
            onSmartCompactAndRetry={onSmartCompactAndRetry}
          />
        </div>
      )}
      {content ? (
        <div className="prose prose-sm max-w-none w-full select-text prose-ask-mobile" style={{ fontSize: 14, lineHeight: 1.58, userSelect: "text", WebkitUserSelect: "text" }}>
          <MarkdownViewer content={content} isStreaming={isCurrentlyStreaming} />
        </div>
      ) : (
        !hasTools && !thinking && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--aurora-fg4)", fontSize: 13 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--aurora-accent)",
                animation: "pulse 1s infinite",
              }}
            />
            {t.ask.thinking}
          </div>
        )
      )}
      {turn.error && (
        <div
          className="not-prose"
          style={{
            marginTop: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 12px",
            borderRadius: 10,
            background: "rgba(239, 68, 68, 0.08)",
            border: "1px solid rgba(239, 68, 68, 0.25)",
            fontSize: 12.5,
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#EF4444", fontWeight: 500 }}>
            <Icon name="close" size={13} />
            <span>{content || "回答生成中断或遇到异常"}</span>
          </div>
          {onRetry && !streaming && (
            <button
              type="button"
              onClick={onRetry}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "3px 10px",
                borderRadius: 6,
                background: "var(--aurora-surface-solid)",
                border: "1px solid var(--aurora-border-strong)",
                color: "var(--aurora-fg1)",
                fontSize: 12,
                cursor: "pointer",
                fontWeight: 500,
                transition: "all 0.15s ease",
              }}
            >
              <Icon name="refresh" size={12} />
              <span>重试本轮</span>
            </button>
          )}
        </div>
      )}
      {isCurrentlyStreaming && (
        <div className="flex items-center justify-between gap-2 mt-3 pt-2 border-t border-[var(--aurora-border)]/30 not-prose select-none text-[11px] text-[var(--aurora-fg3)]">
          {startTime && (
            <span
              className="inline-flex items-center gap-1.5 opacity-80"
              style={{ fontVariantNumeric: "tabular-nums" }}
              title={`开始处理时间: ${startTime.full}`}
            >
              <Icon name="clock" size={11} style={{ color: "var(--aurora-accent)" }} />
              <span>开始于 {startTime.short}</span>
            </span>
          )}
          {isReconnecting && (
            <span
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/35 text-amber-500 text-[11px] font-medium animate-pulse ml-auto"
            >
              <Icon name="refresh" size={11} className="animate-spin" />
              <span>网络切换中，正在恢复流式同步...</span>
            </span>
          )}
        </div>
      )}
      {!isCurrentlyStreaming && (content || hasTools || replyTime || durationText) && (
        <div className="flex items-center justify-between gap-1 sm:gap-2 mt-2 pt-1.5 border-t border-[var(--aurora-border)]/40 not-prose select-none text-[10.5px] sm:text-[11px] min-w-0">
          <div className="flex items-center gap-1 sm:gap-2 min-w-0 overflow-x-auto no-scrollbar py-0.5 text-[10.5px] sm:text-[11px] text-[var(--aurora-fg3)]" style={{ fontVariantNumeric: "tabular-nums" }}>
            {startTime && (
              <span
                className="inline-flex items-center gap-1 opacity-75 whitespace-nowrap shrink-0 hidden md:inline-flex"
                title={`发出提问时间: ${startTime.full}`}
              >
                <Icon name="clock" size={10.5} />
                <span>提问于 {startTime.short}</span>
              </span>
            )}
            {replyTime && (
              <span
                className="inline-flex items-center gap-1 opacity-85 whitespace-nowrap shrink-0"
                title={`收到回复时间: ${replyTime.full}${startTime ? ` (提问于 ${startTime.full})` : ""}`}
              >
                <Icon name="clock" size={10.5} />
                <span className="hidden sm:inline">回复于 </span>
                <span>{replyTime.short}</span>
              </span>
            )}
            {durationText && (
              <span
                className="inline-flex items-center gap-0.5 sm:gap-1 px-1.5 py-0.5 rounded-md bg-[var(--aurora-chip)] border border-[var(--aurora-border)]/60 text-[10px] sm:text-[10.5px] text-[var(--aurora-fg2)] whitespace-nowrap shrink-0 font-medium"
                title="本轮响应耗时"
              >
                <Icon name="zap" size={9.5} style={{ color: "var(--aurora-accent)" }} />
                <span>{durationText}</span>
              </span>
            )}
            {turn.cached && (
              <span
                className="inline-flex items-center gap-0.5 sm:gap-1 px-1.5 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-[10px] sm:text-[10.5px] text-emerald-400 whitespace-nowrap shrink-0 font-medium"
                title="命中语义缓存网关，毫秒级瞬时响应"
              >
                <Icon name="zap" size={9.5} style={{ color: "#34d399" }} />
                <span>{isZh ? "极速缓存" : "Cached"}</span>
              </span>
            )}
            {speedLabel && (
              <span
                className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[var(--aurora-chip)] border border-[var(--aurora-border)]/60 text-[10.5px] text-[var(--aurora-fg2)] whitespace-nowrap shrink-0 font-medium"
                title="文字生成速率"
              >
                <Icon name="activity" size={10} style={{ color: "var(--aurora-accent)" }} />
                <span>{speedLabel}</span>
              </span>
            )}
            {(turn.model || (turn.execution_mode && turn.execution_mode !== "ai")) && (() => {
              const rawName = turn.model || turn.execution_mode || "";
              const formattedName =
                rawName.toLowerCase() === "antigravity" ? "Antigravity"
                : rawName.toLowerCase() === "claude" || rawName.toLowerCase() === "claude_code" ? "Claude Code"
                : rawName.toLowerCase() === "codex" ? "Codex"
                : rawName.toLowerCase() === "workbuddy" ? "WorkBuddy"
                : rawName;
              return (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[var(--aurora-accent-soft)] border border-[var(--aurora-accent)]/30 text-[10px] sm:text-[10.5px] text-[var(--aurora-accent)] font-medium whitespace-nowrap shrink-0"
                  title={`执行引擎/模型: ${rawName}`}
                >
                  <Icon name="sparkles" size={9.5} style={{ color: "var(--aurora-accent)" }} />
                  <span>{formattedName}</span>
                </span>
              );
            })()}
          </div>
          <div className="flex items-center gap-0.5 sm:gap-1.5 ml-auto shrink-0">
            {onShareTurn && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onShareTurn(index);
                }}
                className="inline-flex items-center gap-1 p-1 sm:px-2 sm:py-0.5 rounded-lg text-[11px] sm:text-xs font-medium text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] active:bg-[var(--aurora-chip)] hover:bg-[var(--aurora-chip)] transition-colors cursor-pointer whitespace-nowrap shrink-0"
                title="分享与多平台分发 (微信公众号/知乎/微博/小红书)"
              >
                <Icon name="share" size={12} />
                <span className="hidden sm:inline">分享</span>
              </button>
            )}
            {content && (
              <button
                type="button"
                onClick={handleCopyContent}
                className="inline-flex items-center gap-1 p-1 sm:px-2 sm:py-0.5 rounded-lg text-[11px] sm:text-xs font-medium text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] active:bg-[var(--aurora-chip)] hover:bg-[var(--aurora-chip)] transition-colors cursor-pointer whitespace-nowrap shrink-0"
                title="复制回答全文"
              >
                <Icon name={copied ? "check" : "copy"} size={12.5} style={{ color: copied ? "#10b981" : undefined }} />
                <span className="hidden sm:inline">{copied ? "已复制" : "复制全文"}</span>
              </button>
            )}
            {content && (
              <button
                type="button"
                onClick={handleSaveToTodo}
                disabled={savedTodo}
                className="inline-flex items-center gap-1 p-1 sm:px-2 sm:py-0.5 rounded-lg text-[11px] sm:text-xs font-medium text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] active:bg-[var(--aurora-chip)] hover:bg-[var(--aurora-chip)] transition-colors cursor-pointer whitespace-nowrap shrink-0"
                title="一键将回答要点存入工作待办"
              >
                <Icon name={savedTodo ? "check" : "inbox"} size={12.5} style={{ color: savedTodo ? "#10b981" : undefined }} />
                <span className="hidden sm:inline">{savedTodo ? "已存待办" : "存为待办"}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </Glass>
  </div>
  );
}, areAssistantPropsEqual);
