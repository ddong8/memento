"use client";

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { DeviceSummary } from "@/lib/api-client";
import type { ExecutionMode, Turn } from "@/lib/ask/turns";
import { isDeviceOnline } from "@/lib/ask/devices";
import { Icon } from "@/components/aurora/Icon";
import { Btn } from "@/components/aurora/primitives";
import { SuggestedDevicePill } from "@/components/ask/AskInputBanners";

export interface AskComposerHandle {
  getValue: () => string;
  setValue: (next: string | ((prev: string) => string)) => void;
  focus: () => void;
  resetHistory: () => void;
}

export interface AskComposerProps {
  initialValue?: string;
  onCacheSync?: (val: string) => void;
  onSendText: (trimmedText: string) => void;
  onStop: () => void;
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onOpenFilePicker: () => void;
  onToggleVoice: () => void;
  onFocusMobileCollapse: () => void;
  onWarmupAsk: () => void;
  onDeviceSwitch: (deviceId: string) => void;
  turnsRef: RefObject<Turn[]>;
  bottomRef: RefObject<HTMLDivElement | null>;
  devices: DeviceSummary[];
  selectedDevice: string;
  configLocked: boolean;
  executionMode: ExecutionMode;
  streaming: boolean;
  isReconnecting: boolean;
  isRecordingVoice: boolean;
  attachedImageCount: number;
  placeholderText: string;
  compactPlaceholderText?: string;
  sendLabel: string;
  stopLabel: string;
  isZh: boolean;
}

function supportsFieldSizing(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");
}

function computeSuggestedDevice(
  input: string,
  devices: DeviceSummary[],
  selectedDevice: string,
  isZh: boolean
) {
  if (!input || !devices || devices.length <= 1) return null;
  const lower = input.toLowerCase();
  const osOf = (d?: DeviceSummary) => {
    const n = (d?.name || "").toLowerCase();
    if (n.includes("windows") || n.startsWith("desktop-") || n.startsWith("laptop-")) return "windows";
    if (n.includes("darwin") || n.includes("mac")) return "mac";
    if (n.includes("linux")) return "linux";
    return "";
  };
  const currentOs = osOf(devices.find((d) => d.device_id === selectedDevice));
  const firstOf = (os: string) =>
    devices.filter((d) => osOf(d) === os).sort((a, b) => Number(isDeviceOnline(b)) - Number(isDeviceOnline(a)))[0];

  const hasWinPath = /\b[cd]:[\\/]/.test(lower) || /\b(powershell|cmd\.exe|choco|winget)\b/.test(lower);
  if (hasWinPath && currentOs !== "windows") {
    const winDev = firstOf("windows");
    if (winDev) return { device: winDev, reason: isZh ? "检测到 Windows 路径/命令" : "Windows path/command detected" };
  }

  const hasMacPath = /(^|[\s"'`(=])\/users\//.test(lower) || lower.includes(".app/") || /\b(brew\s+|osascript|launchctl)\b/.test(lower);
  if (hasMacPath && currentOs !== "mac") {
    const macDev = firstOf("mac");
    if (macDev) return { device: macDev, reason: isZh ? "检测到 macOS 路径/命令" : "macOS path/command detected" };
  }

  return null;
}

/**
 * Isolated composer holding `input` & `isInputFocused` state so typing never triggers
 * full AskPage re-renders, and using CSS `field-sizing: content` (with a single-read rAF
 * fallback) to eliminate per-keystroke synchronous layout thrashing.
 */
export const AskComposer = memo(
  forwardRef<AskComposerHandle, AskComposerProps>(function AskComposer(
    {
      initialValue = "",
      onCacheSync,
      onSendText,
      onStop,
      onPaste,
      onOpenFilePicker,
      onToggleVoice,
      onFocusMobileCollapse,
      onWarmupAsk,
      onDeviceSwitch,
      turnsRef,
      bottomRef,
      devices,
      selectedDevice,
      configLocked,
      executionMode,
      streaming,
      isReconnecting,
      isRecordingVoice,
      attachedImageCount,
      placeholderText,
      compactPlaceholderText,
      sendLabel,
      stopLabel,
      isZh,
    },
    ref
  ) {
    const [input, setInputState] = useState<string>(initialValue);
    const inputRef = useRef<string>(initialValue);
    const [isInputFocused, setIsInputFocused] = useState<boolean>(false);
    const [isNarrowViewport, setIsNarrowViewport] = useState<boolean>(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const promptHistoryIdxRef = useRef<number>(-1);
    const promptDraftRef = useRef<string>("");
    const lastHeightRef = useRef<number>(24);
    const lastLenRef = useRef<number>(initialValue.length);
    const resizeRafRef = useRef<number>(0);

    useEffect(() => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
      const mq = window.matchMedia("(max-width: 639px)");
      const update = () => setIsNarrowViewport(mq.matches);
      update();
      mq.addEventListener("change", update);
      return () => mq.removeEventListener("change", update);
    }, []);

    // Debounced copy for OS-path device recommendation so regexes don't run synchronously on every key
    const [debouncedInput, setDebouncedInput] = useState<string>(initialValue);
    useEffect(() => {
      if (!input) {
        setDebouncedInput("");
        return;
      }
      const timer = setTimeout(() => setDebouncedInput(input), 220);
      return () => clearTimeout(timer);
    }, [input]);

    const applyValue = useCallback(
      (next: string | ((prev: string) => string)) => {
        setInputState((prev) => {
          const resolved = typeof next === "function" ? next(prev) : next;
          inputRef.current = resolved;
          onCacheSync?.(resolved);
          return resolved;
        });
      },
      [onCacheSync]
    );

    useImperativeHandle(
      ref,
      () => ({
        getValue: () => inputRef.current,
        setValue: applyValue,
        focus: () => textareaRef.current?.focus(),
        resetHistory: () => {
          promptHistoryIdxRef.current = -1;
          promptDraftRef.current = "";
        },
      }),
      [applyValue]
    );

    // Fallback auto-resize only on browsers without CSS `field-sizing: content`.
    // Never resets height to 24px on growth and never reads scrollHeight twice.
    useEffect(() => {
      if (supportsFieldSizing()) return;
      const el = textareaRef.current;
      if (!el) return;

      if (!input) {
        if (lastHeightRef.current !== 24) {
          el.style.height = "24px";
          lastHeightRef.current = 24;
        }
        if (el.style.overflowY !== "hidden") el.style.overflowY = "hidden";
        lastLenRef.current = 0;
        return;
      }

      const prevLen = lastLenRef.current;
      lastLenRef.current = input.length;

      if (lastHeightRef.current === 24 && input.length < 22 && !input.includes("\n")) {
        return;
      }

      const shrunk = input.length < prevLen;
      if (!shrunk && lastHeightRef.current >= 160) {
        return;
      }

      if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = 0;
        const target = textareaRef.current;
        if (!target) return;
        if (shrunk && lastHeightRef.current > 24) {
          target.style.height = "24px";
        }
        const sh = target.scrollHeight;
        const nextHeight = Math.min(Math.max(sh, 24), 160);
        if (nextHeight !== lastHeightRef.current || shrunk) {
          target.style.height = `${nextHeight}px`;
          lastHeightRef.current = nextHeight;
        }
        const nextOverflow = sh > 160 ? "auto" : "hidden";
        if (target.style.overflowY !== nextOverflow) {
          target.style.overflowY = nextOverflow;
        }
      });
    }, [input]);

    useEffect(() => {
      return () => {
        if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
      };
    }, []);

    const suggestedDevice = useMemo(
      () => computeSuggestedDevice(debouncedInput, devices, selectedDevice, isZh),
      [debouncedInput, devices, selectedDevice, isZh]
    );

    const handleSend = useCallback(() => {
      const trimmed = inputRef.current.trim();
      if (!trimmed && attachedImageCount === 0) return;
      promptHistoryIdxRef.current = -1;
      promptDraftRef.current = "";
      applyValue("");
      onSendText(trimmed);
    }, [attachedImageCount, applyValue, onSendText]);

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        promptHistoryIdxRef.current = -1;
        applyValue(e.target.value);
      },
      [applyValue]
    );

    const handleKeyDown = useCallback(
      (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          handleSend();
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          const isMobileViewport = typeof window !== "undefined" && window.innerWidth < 768;
          if (!isMobileViewport) {
            e.preventDefault();
            handleSend();
            return;
          }
        }
        if (e.key === "ArrowUp") {
          const textarea = e.currentTarget;
          const isAtStart = textarea.selectionStart === 0 && textarea.selectionEnd === 0;
          if (isAtStart || !inputRef.current.trim()) {
            const userQuestions = (turnsRef.current || [])
              .filter((t) => t.role === "user" && t.content)
              .map((t) => t.content);
            if (userQuestions.length > 0) {
              e.preventDefault();
              if (promptHistoryIdxRef.current === -1) {
                promptDraftRef.current = inputRef.current;
              }
              const nextIdx =
                promptHistoryIdxRef.current === -1
                  ? userQuestions.length - 1
                  : Math.max(0, promptHistoryIdxRef.current - 1);
              promptHistoryIdxRef.current = nextIdx;
              applyValue(userQuestions[nextIdx]);
            }
          }
        } else if (e.key === "ArrowDown") {
          if (promptHistoryIdxRef.current !== -1) {
            e.preventDefault();
            const userQuestions = (turnsRef.current || [])
              .filter((t) => t.role === "user" && t.content)
              .map((t) => t.content);
            if (promptHistoryIdxRef.current < userQuestions.length - 1) {
              promptHistoryIdxRef.current += 1;
              applyValue(userQuestions[promptHistoryIdxRef.current]);
            } else {
              promptHistoryIdxRef.current = -1;
              applyValue(promptDraftRef.current);
            }
          }
        }
      },
      [handleSend, applyValue, turnsRef]
    );

    const canSend = input.trim().length > 0 || attachedImageCount > 0;

    return (
      <>
        <SuggestedDevicePill
          suggestedDevice={suggestedDevice}
          configLocked={configLocked}
          isZh={isZh}
          onSwitch={onDeviceSwitch}
        />

        <div className="flex items-end gap-1.5 sm:gap-2 w-full min-w-0 box-border">
          <button
            type="button"
            onClick={onOpenFilePicker}
            title={isZh ? "上传图片或截图 (支持直接粘贴 Ctrl+V / Cmd+V)" : "Upload image (supports Ctrl+V / Cmd+V)"}
            style={{
              borderRadius: 11,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: attachedImageCount > 0 ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
              border: `1px solid ${attachedImageCount > 0 ? "var(--aurora-accent)" : "var(--aurora-border)"}`,
              color: attachedImageCount > 0 ? "var(--aurora-accent)" : "var(--aurora-fg3)",
              cursor: "pointer",
              transition: "background-color 160ms ease, border-color 160ms ease, color 160ms ease",
              flexShrink: 0,
              boxSizing: "border-box",
            }}
            className="w-9 h-9 sm:w-10 sm:h-10 hover:text-[var(--aurora-fg1)] hover:border-[var(--aurora-border-strong)] active:scale-95 !rounded-xl"
          >
            <Icon name="image" size={16} />
          </button>

          <label
            className="aurora-input !px-2.5 sm:!px-4 !py-[6px] sm:!py-2 !min-h-[36px] sm:!min-h-[42px] transition-colors !rounded-xl"
            style={{
              flex: 1,
              minWidth: 0,
              background: isInputFocused ? "var(--aurora-surface-solid)" : "var(--aurora-chip)",
              border: isInputFocused ? "1px solid var(--aurora-accent)" : "1px solid var(--aurora-border)",
              boxShadow: isInputFocused ? "0 0 0 2px var(--aurora-accent-soft)" : "none",
              boxSizing: "border-box",
              alignItems: "center",
              borderRadius: 11,
            }}
          >
            <span className="hidden sm:inline-flex" style={{ color: "var(--aurora-fg3)", flexShrink: 0 }}>
              <Icon
                name={
                  executionMode === "shell"
                    ? "terminal"
                    : executionMode === "claude" || executionMode === "codex" || executionMode === "antigravity" || executionMode === "workbuddy"
                    ? "code"
                    : selectedDevice === "ask_only"
                    ? "sparkles"
                    : "brain"
                }
                size={15}
              />
            </span>
            <textarea
              ref={textareaRef}
              rows={1}
              className="ask-composer-textarea"
              value={input}
              onChange={handleChange}
              onPaste={onPaste}
              onFocus={() => {
                setIsInputFocused(true);
                if (typeof window !== "undefined" && window.innerWidth < 768) {
                  onFocusMobileCollapse();
                }
                onWarmupAsk();
                setTimeout(() => {
                  bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
                }, 120);
              }}
              onBlur={() => {
                setTimeout(() => setIsInputFocused(false), 200);
              }}
              onKeyDown={handleKeyDown}
              placeholder={
                streaming
                  ? isZh
                    ? (isNarrowViewport ? "继续追问…" : "继续追问，可以连着发几条…")
                    : (isNarrowViewport ? "Follow up…" : "Follow up; send as many as you like…")
                  : (isNarrowViewport && compactPlaceholderText ? compactPlaceholderText : placeholderText)
              }
              style={{
                minWidth: 0,
                width: "100%",
                minHeight: 22,
                maxHeight: 160,
                lineHeight: "22px",
                padding: 0,
                margin: 0,
                border: "none",
                outline: "none",
                background: "transparent",
                color: "var(--aurora-fg1)",
                resize: "none",
                overflowY: "hidden",
                wordBreak: "break-word",
                fontSize: 14.5,
              }}
            />
          </label>

          <button
            type="button"
            onClick={onToggleVoice}
            title={isRecordingVoice ? (isZh ? "停止倾听" : "Stop listening") : (isZh ? "语音吩咐 (按键说话)" : "Voice input")}
            style={{
              borderRadius: 11,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: isRecordingVoice ? "rgba(239, 68, 68, 0.16)" : "var(--aurora-chip)",
              border: isRecordingVoice ? "1px solid #ef4444" : "1px solid var(--aurora-border)",
              color: isRecordingVoice ? "#ef4444" : "var(--aurora-fg3)",
              cursor: "pointer",
              transition: "background-color 160ms ease, border-color 160ms ease, color 160ms ease",
              flexShrink: 0,
              boxSizing: "border-box",
            }}
            className={`w-9 h-9 sm:w-10 sm:h-10 active:scale-95 !rounded-xl ${isRecordingVoice ? "animate-pulse shadow-sm" : "hover:text-[var(--aurora-fg1)]"}`}
          >
            <Icon name="microphone" size={16} />
          </button>

          {isReconnecting && (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "0 10px",
                height: 36,
                borderRadius: 11,
                background: "rgba(245, 158, 11, 0.15)",
                border: "1px solid rgba(245, 158, 11, 0.35)",
                color: "#f59e0b",
                fontSize: 12,
                fontWeight: 500,
                flexShrink: 0,
              }}
              className="animate-pulse"
            >
              <Icon name="refresh" size={12} className="animate-spin" />
              <span>正在恢复流式同步...</span>
            </div>
          )}

          {streaming && (
            <Btn
              onClick={handleSend}
              disabled={!canSend}
              icon="message"
              title={isZh ? "追问：正在运行的智能体会在下一步读到，读不了的等这轮结束后接着发" : "Follow up"}
              className="!h-[36px] sm:!h-[42px] !w-[36px] sm:!w-auto !px-0 sm:!px-4 !justify-center !rounded-xl"
              style={{ flexShrink: 0 }}
            >
              <span className="hidden sm:inline font-semibold text-sm">{isZh ? "追问" : "Follow up"}</span>
            </Btn>
          )}
          {streaming ? (
            <Btn
              variant="danger"
              icon="close"
              onClick={onStop}
              title={stopLabel}
              className="!h-[36px] sm:!h-[42px] !w-[36px] sm:!w-auto !px-0 sm:!px-4 !justify-center !rounded-xl"
              style={{
                flexShrink: 0,
                background: "rgba(239, 68, 68, 0.18)",
                border: "1px solid rgba(239, 68, 68, 0.45)",
                color: "#ef4444",
              }}
            >
              <span className="hidden sm:inline">{stopLabel}</span>
            </Btn>
          ) : (
            <Btn
              onClick={handleSend}
              disabled={!canSend}
              icon={executionMode === "shell" ? "terminal" : executionMode !== "ai" ? "rocket" : selectedDevice === "ask_only" ? "search" : "rocket"}
              className="!h-[36px] sm:!h-[42px] !px-2.5 sm:!px-4 !gap-1 sm:!gap-1.5 !rounded-xl"
              style={{ flexShrink: 0 }}
            >
              <span className="font-semibold text-xs sm:text-sm">{sendLabel}</span>
            </Btn>
          )}
        </div>
      </>
    );
  })
);
