"use client";

import { useState, useId } from "react";
import type { TaskEvent } from "@memento/core";
import { authFetch, getApiBase } from "@/lib/api-client";
import { useI18n, fmt } from "@/lib/i18n";
import { Icon } from "./aurora/Icon";

interface NormalizedOption {
  label: string;
  description?: string;
  value: string;
}

interface QuestionPromptProps {
  questionEvent: TaskEvent & {
    id?: string;
    tool?: string;
    question?: string;
    options?: Array<{ label: string; description?: string; value?: string } | string>;
    is_multi_select?: boolean;
    status?: "waiting" | "answered";
    answer?: string;
  };
  taskId?: string;
  disabled?: boolean;
  onAnswered?: (answer: string) => void;
}

export function QuestionPrompt({ questionEvent, taskId, disabled, onAnswered }: QuestionPromptProps) {
  const { t, locale } = useI18n();
  const isZh = locale === "zh-CN";
  const inputId = useId();

  const isAnswered = questionEvent.status === "answered" || Boolean(questionEvent.answer);
  const qText = questionEvent.question || (isZh ? "请确认下一步操作" : "Please confirm next action");

  // Normalize options
  const options: NormalizedOption[] = (questionEvent.options || []).map((opt) => {
    if (typeof opt === "string") {
      return { label: opt, value: opt };
    }
    return {
      label: opt.label || opt.value || "",
      description: opt.description,
      value: opt.value || opt.label || "",
    };
  });

  const [selectedMulti, setSelectedMulti] = useState<string[]>([]);
  const [customText, setCustomText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localAnswer, setLocalAnswer] = useState<string | null>(questionEvent.answer || null);
  const [errorNote, setErrorNote] = useState<string | null>(null);

  const sendAnswer = async (answerText: string) => {
    const val = answerText.trim();
    if (!val || submitting || disabled || !taskId) return;

    setSubmitting(true);
    setErrorNote(null);
    try {
      const res = await authFetch(`${getApiBase()}/api/tasks/${taskId}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: val }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (data.ok) {
        setLocalAnswer(val);
        onAnswered?.(val);
      } else {
        setErrorNote(isZh ? "发送失败，任务可能已结束" : "Failed to send input");
      }
    } catch {
      setErrorNote(isZh ? "网络异常，发送失败" : "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSingleOptionClick = (opt: NormalizedOption) => {
    sendAnswer(opt.value);
  };

  const handleToggleMulti = (val: string) => {
    setSelectedMulti((prev) =>
      prev.includes(val) ? prev.filter((x) => x !== val) : [...prev, val]
    );
  };

  const handleMultiSubmit = () => {
    if (selectedMulti.length > 0) {
      sendAnswer(selectedMulti.join(", "));
    }
  };

  const currentAnswer = localAnswer || questionEvent.answer;

  return (
    <div
      style={{
        margin: "10px 0",
        padding: "12px 14px",
        borderRadius: 12,
        background: isAnswered
          ? "rgba(16,185,129,0.06)"
          : "rgba(245,158,11,0.08)",
        border: `1px solid ${isAnswered ? "rgba(16,185,129,0.25)" : "rgba(245,158,11,0.3)"}`,
        boxShadow: "0 2px 8px -1px rgba(0,0,0,0.04)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              borderRadius: 6,
              background: isAnswered
                ? "rgba(16,185,129,0.18)"
                : "rgba(245,158,11,0.2)",
              color: isAnswered ? "#10B981" : "#D97706",
            }}
          >
            <Icon name={isAnswered ? "check" : "message"} size={13} />
          </div>
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: isAnswered ? "var(--aurora-fg1)" : "#B45309",
            }}
          >
            {isAnswered
              ? (isZh ? "已完成确认回复" : "Question Answered")
              : (isZh ? "Agent 正在询问并等待回复" : "Agent is waiting for your response")}
          </span>
        </div>

        <span
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 10,
            fontWeight: 500,
            background: isAnswered ? "rgba(16,185,129,0.12)" : "rgba(245,158,11,0.15)",
            color: isAnswered ? "#059669" : "#D97706",
          }}
        >
          {isAnswered ? (isZh ? "已回复" : "Answered") : (isZh ? "等待交互" : "Waiting")}
        </span>
      </div>

      {/* Question Content */}
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.5,
          color: "var(--aurora-fg1)",
          marginBottom: isAnswered ? 4 : 10,
          fontWeight: 500,
        }}
      >
        {qText}
      </div>

      {/* Answered View */}
      {isAnswered && (
        <div
          style={{
            fontSize: 12,
            color: "var(--aurora-fg2)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 4,
          }}
        >
          <span style={{ color: "#10B981", fontWeight: 600 }}>
            {isZh ? "回复内容：" : "Response: "}
          </span>
          <span style={{ fontWeight: 500 }}>{currentAnswer || (isZh ? "已确认" : "Confirmed")}</span>
        </div>
      )}

      {/* Interactive Options View */}
      {!isAnswered && (
        <div>
          {/* Options List */}
          {options.length > 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                marginBottom: 10,
              }}
            >
              {options.map((opt, idx) => {
                const isSelected = selectedMulti.includes(opt.value);
                const isMulti = Boolean(questionEvent.is_multi_select);

                return (
                  <button
                    key={`${opt.value}-${idx}`}
                    type="button"
                    disabled={disabled || submitting}
                    onClick={() => {
                      if (isMulti) {
                        handleToggleMulti(opt.value);
                      } else {
                        handleSingleOptionClick(opt);
                      }
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: "8px 12px",
                      borderRadius: 8,
                      border: `1px solid ${
                        isSelected
                          ? "var(--aurora-accent)"
                          : "var(--aurora-border-strong)"
                      }`,
                      background: isSelected
                        ? "var(--aurora-accent-soft)"
                        : "var(--aurora-surface-solid)",
                      color: "var(--aurora-fg1)",
                      cursor: disabled || submitting ? "default" : "pointer",
                      textAlign: "left",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 500 }}>
                        {opt.label}
                      </div>
                      {opt.description && (
                        <div
                          style={{
                            fontSize: 11.5,
                            color: "var(--aurora-fg3)",
                            marginTop: 2,
                          }}
                        >
                          {opt.description}
                        </div>
                      )}
                    </div>
                    {isMulti ? (
                      <div
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 4,
                          border: `1.5px solid ${isSelected ? "var(--aurora-accent)" : "var(--aurora-border-strong)"}`,
                          background: isSelected ? "var(--aurora-accent)" : "transparent",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#fff",
                          flexShrink: 0,
                        }}
                      >
                        {isSelected && <Icon name="check" size={11} />}
                      </div>
                    ) : (
                      <div
                        style={{
                          fontSize: 11.5,
                          color: "var(--aurora-accent)",
                          fontWeight: 500,
                          flexShrink: 0,
                        }}
                      >
                        {isZh ? "选择" : "Select"}
                      </div>
                    )}
                  </button>
                );
              })}

              {/* Multi-select confirm button */}
              {questionEvent.is_multi_select && (
                <button
                  type="button"
                  disabled={disabled || submitting || selectedMulti.length === 0}
                  onClick={handleMultiSubmit}
                  style={{
                    alignSelf: "flex-end",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "6px 14px",
                    borderRadius: 7,
                    fontSize: 12,
                    fontWeight: 500,
                    border: "none",
                    background: "var(--aurora-accent)",
                    color: "#fff",
                    cursor: disabled || submitting || selectedMulti.length === 0 ? "default" : "pointer",
                    opacity: disabled || submitting || selectedMulti.length === 0 ? 0.6 : 1,
                  }}
                >
                  {submitting ? (isZh ? "提交中..." : "Submitting...") : (isZh ? "确认选择" : "Confirm Selection")}
                </button>
              )}
            </div>
          )}

          {/* Custom Text / Write-in Input */}
          <div style={{ display: "flex", gap: 6, marginTop: options.length > 0 ? 6 : 0 }}>
            <input
              id={inputId}
              value={customText}
              disabled={disabled || submitting}
              onChange={(e) => setCustomText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  sendAnswer(customText);
                }
              }}
              placeholder={
                options.length > 0
                  ? (isZh ? "或输入自定义回复..." : "Or type custom response...")
                  : (isZh ? "输入回答并按回车发送..." : "Type answer and press Enter...")
              }
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 12.5,
                padding: "7px 10px",
                borderRadius: 8,
                border: "1px solid var(--aurora-border-strong)",
                background: "var(--aurora-surface-solid)",
                color: "var(--aurora-fg1)",
              }}
            />
            <button
              type="button"
              disabled={disabled || submitting || !customText.trim()}
              onClick={() => sendAnswer(customText)}
              title={isZh ? "发送回答" : "Send answer"}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 34,
                borderRadius: 8,
                border: "1px solid var(--aurora-accent)",
                background: "var(--aurora-accent-soft)",
                color: "var(--aurora-accent)",
                cursor: disabled || submitting || !customText.trim() ? "default" : "pointer",
                opacity: disabled || submitting || !customText.trim() ? 0.5 : 1,
              }}
            >
              <Icon name="message" size={14} />
            </button>
          </div>

          {errorNote && (
            <div style={{ fontSize: 11.5, color: "#DC2626", marginTop: 4 }}>
              {errorNote}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
