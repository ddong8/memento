"use client";

import { useEffect, useState } from "react";
import {
  api,
  type AgentCapabilities,
  type ConversationHandoffResponse,
  type DeviceSummary,
} from "@/lib/api-client";
import { BrandMark } from "@/components/aurora/BrandMark";
import { Icon } from "@/components/aurora/Icon";
import { Btn } from "@/components/aurora/primitives";
import { HANDOFF_MODE_OPTIONS, handoffModeLabel, type HandoffModeOption } from "@/lib/ask/git-review";
import { showInAppToast } from "@/lib/native-notify";

const PRESET_INSTRUCTIONS_ZH = [
  "请基于前序进展和当前工作区改动，继续完成剩余实现并自测验证。",
  "请对当前工作区的代码改动做一次严格 Code Review，重点排查边界条件、安全与性能隐患并直接修复。",
  "请为当前改动补齐单元测试与边界用例，运行全套测试直到全部通过。",
  "请梳理当前方案的技术债并做结构优化，保持既有行为不变且测试通过。",
];

const PRESET_INSTRUCTIONS_EN = [
  "Review current workspace changes and continue implementing the remaining steps.",
  "Perform a strict code review of current workspace diffs, fix edge cases and security issues.",
  "Add comprehensive unit tests for the current changes and verify all tests pass.",
];

interface HandoffModalProps {
  open: boolean;
  onClose: () => void;
  conversationId: string | null;
  conversationTitle: string;
  currentMode: string;
  currentDeviceId: string;
  cwd: string;
  devices: DeviceSummary[];
  onHandoffCreated: (res: ConversationHandoffResponse, autoSend: boolean) => void;
  isZh: boolean;
}

export function HandoffModal({
  open,
  onClose,
  conversationId,
  conversationTitle,
  currentMode,
  currentDeviceId,
  cwd,
  devices,
  onHandoffCreated,
  isZh,
}: HandoffModalProps) {
  const defaultTarget = (): HandoffModeOption["id"] => {
    if (currentMode === "claude") return "codex";
    if (currentMode === "codex") return "claude";
    if (currentMode === "antigravity") return "claude";
    return "claude";
  };

  const [targetMode, setTargetMode] = useState<HandoffModeOption["id"]>(defaultTarget);
  const [targetDevice, setTargetDevice] = useState<string>(currentDeviceId);
  const [targetModel, setTargetModel] = useState<string>("");
  const [targetEffort, setTargetEffort] = useState<string>("");
  const [instruction, setInstruction] = useState<string>("");
  const [autoSend, setAutoSend] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [caps, setCaps] = useState<AgentCapabilities | null>(null);

  useEffect(() => {
    if (!open) return;
    setTargetMode(defaultTarget());
    setTargetDevice(currentDeviceId);
    setTargetModel("");
    setTargetEffort("");
    setInstruction("");
    setAutoSend(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentMode, currentDeviceId]);

  useEffect(() => {
    if (!open) return;
    if (targetMode === "ai") {
      setCaps(null);
      return;
    }
    let cancelled = false;
    api
      .getAgentCapabilities(targetMode, targetDevice)
      .then((data) => {
        if (!cancelled) setCaps(data);
      })
      .catch(() => {
        if (!cancelled) setCaps(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, targetMode, targetDevice]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const handleSubmit = async () => {
    if (!conversationId || submitting) return;
    setSubmitting(true);
    try {
      const res = await api.handoffAskConversation(conversationId, {
        target_execution_mode: targetMode,
        target_device_id: targetDevice || undefined,
        target_model: targetModel || undefined,
        target_effort: targetEffort || undefined,
        instruction: instruction.trim() || undefined,
      });
      onClose();
      onHandoffCreated(res, autoSend);
    } catch (e: unknown) {
      showInAppToast(
        isZh ? "移交失败" : "Handoff failed",
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (!open || !conversationId) return null;

  const presets = isZh ? PRESET_INSTRUCTIONS_ZH : PRESET_INSTRUCTIONS_EN;
  const models = caps?.models || [];
  const efforts = caps?.effort_options || [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-hidden"
      role="dialog"
      aria-modal="true"
    >
      <div className="fixed inset-0 bg-black/45 backdrop-blur-[2px]" onClick={onClose} />

      <div className="relative z-10 w-full sm:max-w-xl max-h-[92vh] flex flex-col rounded-t-2xl sm:rounded-2xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-4 sm:px-5 py-3.5 border-b border-[var(--aurora-border)] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
              style={{
                background: "var(--aurora-accent-soft)",
                border: "1px solid color-mix(in srgb, var(--aurora-accent) 30%, transparent)",
              }}
            >
              <Icon name="arrow_right" size={14} style={{ color: "var(--aurora-accent)" }} />
            </div>
            <div className="min-w-0">
              <h2 className="text-[14.5px] font-semibold text-[var(--aurora-fg1)] truncate">
                {isZh ? "跨智能体移交任务" : "Handoff to Another Agent"}
              </h2>
              <p className="text-[11.5px] text-[var(--aurora-fg3)] truncate">
                {isZh
                  ? `保留原会话（${handoffModeLabel(currentMode, true)}），新建关联会话并带入上下文与检查点`
                  : `Keeps source thread (${handoffModeLabel(currentMode, false)}) intact & creates a linked handoff`}
              </p>
            </div>
          </div>
          <Btn variant="glass" size="sm" icon="close" onClick={onClose} aria-label={isZh ? "关闭" : "Close"} />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 flex flex-col gap-4">
          {/* Source Summary Strip */}
          <div
            className="rounded-xl px-3 py-2 border border-[var(--aurora-border)] text-[12px] flex flex-col gap-0.5"
            style={{ background: "var(--aurora-surface-mute)" }}
          >
            <div className="font-medium text-[var(--aurora-fg1)] truncate">{conversationTitle}</div>
            {cwd && <div className="text-[11px] font-mono text-[var(--aurora-fg3)] truncate">{cwd}</div>}
          </div>

          {/* Target Agent Grid */}
          <div className="flex flex-col gap-2">
            <label className="text-[12.5px] font-semibold text-[var(--aurora-fg1)]">
              {isZh ? "选择接棒智能体" : "Target Agent"}
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {HANDOFF_MODE_OPTIONS.map((opt) => {
                const selected = targetMode === opt.id;
                const isSame = currentMode === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setTargetMode(opt.id);
                      setTargetModel("");
                      setTargetEffort("");
                    }}
                    className="p-2.5 rounded-xl text-left flex items-start gap-2.5 transition-colors cursor-pointer"
                    style={{
                      background: selected ? `${opt.accent}14` : "var(--aurora-surface-mute)",
                      border: `1px solid ${selected ? opt.accent : "var(--aurora-border)"}`,
                    }}
                  >
                    <div
                      className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                      style={{
                        background: `${opt.accent}18`,
                        border: `1px solid ${opt.accent}38`,
                      }}
                    >
                      {opt.brandId ? (
                        <BrandMark id={opt.brandId} size={15} colored />
                      ) : (
                        <Icon name="brain" size={14} style={{ color: opt.accent }} />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12.5px] font-semibold text-[var(--aurora-fg1)]">
                          {isZh ? opt.label : opt.enLabel}
                        </span>
                        {isSame && (
                          <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-[var(--aurora-chip)] text-[var(--aurora-fg3)]">
                            {isZh ? "当前" : "Current"}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-[var(--aurora-fg3)] leading-snug mt-0.5">
                        {isZh ? opt.descZh : opt.descEn}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Optional Device / Model / Effort */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-[11.5px] font-medium text-[var(--aurora-fg2)]">
                {isZh ? "目标设备" : "Device"}
              </label>
              <select
                value={targetDevice}
                onChange={(e) => setTargetDevice(e.target.value)}
                className="rounded-lg border border-[var(--aurora-border)] bg-[var(--aurora-surface-mute)] px-2.5 py-1.5 text-[12px] text-[var(--aurora-fg1)] outline-none"
              >
                <option value="auto">{isZh ? "沿用当前设备" : "Keep current"}</option>
                {devices.map((d) => (
                  <option key={d.device_id} value={d.device_id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11.5px] font-medium text-[var(--aurora-fg2)]">
                {isZh ? "模型（可选）" : "Model (optional)"}
              </label>
              <select
                value={targetModel}
                onChange={(e) => setTargetModel(e.target.value)}
                disabled={models.length === 0}
                className="rounded-lg border border-[var(--aurora-border)] bg-[var(--aurora-surface-mute)] px-2.5 py-1.5 text-[12px] text-[var(--aurora-fg1)] outline-none disabled:opacity-60"
              >
                <option value="">{isZh ? "智能体默认模型" : "Agent default"}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11.5px] font-medium text-[var(--aurora-fg2)]">
                {isZh ? "思考深度（可选）" : "Effort (optional)"}
              </label>
              <select
                value={targetEffort}
                onChange={(e) => setTargetEffort(e.target.value)}
                disabled={efforts.length === 0}
                className="rounded-lg border border-[var(--aurora-border)] bg-[var(--aurora-surface-mute)] px-2.5 py-1.5 text-[12px] text-[var(--aurora-fg1)] outline-none disabled:opacity-60"
              >
                <option value="">{isZh ? "默认" : "Default"}</option>
                {efforts.map((ef) => (
                  <option key={ef.id} value={ef.id}>
                    {ef.name || ef.id}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Instruction Presets & Textarea */}
          <div className="flex flex-col gap-2">
            <label className="text-[12.5px] font-semibold text-[var(--aurora-fg1)]">
              {isZh ? "给接棒智能体的交接指令（可选）" : "Handoff Instruction (optional)"}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {presets.map((p, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setInstruction(p)}
                  className="text-[11px] px-2.5 py-1 rounded-lg border border-[var(--aurora-border)] bg-[var(--aurora-chip)] text-[var(--aurora-fg2)] hover:border-[var(--aurora-accent)] cursor-pointer text-left"
                >
                  {p.slice(0, 22)}…
                </button>
              ))}
            </div>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
              placeholder={
                isZh
                  ? "留空则自动附带最近对话脉络与最新 Git 检查点，让接棒智能体核对代码后继续推进"
                  : "Leave blank to pass recent context & latest Git checkpoint automatically"
              }
              className="w-full rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-mute)] px-3 py-2 text-[12.5px] text-[var(--aurora-fg1)] outline-none focus:border-[var(--aurora-accent)]"
            />
          </div>

          <label className="flex items-center gap-2 text-[12.5px] text-[var(--aurora-fg1)] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoSend}
              onChange={(e) => setAutoSend(e.target.checked)}
              className="w-4 h-4 accent-[var(--aurora-accent)]"
            />
            <span>
              {isZh
                ? "创建移交会话后立即发送交接上下文并启动执行"
                : "Send handoff context immediately after creating the linked conversation"}
            </span>
          </label>
        </div>

        {/* Footer */}
        <div className="px-4 sm:px-5 py-3 border-t border-[var(--aurora-border)] flex items-center justify-end gap-2 shrink-0 bg-[var(--aurora-surface-solid)]">
          <Btn variant="glass" size="sm" onClick={onClose} disabled={submitting}>
            {isZh ? "取消" : "Cancel"}
          </Btn>
          <Btn
            variant="primary"
            size="sm"
            icon="arrow_right"
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting
              ? isZh
                ? "移交中..."
                : "Handing off..."
              : isZh
                ? `移交给 ${handoffModeLabel(targetMode, true)}`
                : `Handoff to ${handoffModeLabel(targetMode, false)}`}
          </Btn>
        </div>
      </div>
    </div>
  );
}
