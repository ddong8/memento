"use client";

import { useState, useRef, useEffect } from "react";
import { Icon } from "./aurora/Icon";
import { useI18n } from "@/lib/i18n";

export interface ToolCallItem {
  id?: string;
  name: string;
  args: Record<string, unknown>;
  device_name?: string;
  result?: {
    task_id?: string;
    device_id?: string;
    device_name?: string;
    action?: string;
    status?: "queued" | "running" | "succeeded" | "failed" | "timeout" | "still_running" | string;
    exit_code?: number | null;
    stdout?: string;
    stderr?: string;
    error?: string;
    note?: string;
    devices?: Array<{ device_id: string; name: string; collector_version?: string; online: boolean }>;
  };
}

interface ExecutionCardProps {
  call: ToolCallItem;
  isVisible?: boolean;
}

export default function ExecutionCard({ call, isVisible = true }: ExecutionCardProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  const terminalRef = useRef<HTMLPreElement>(null);

  const { name, args, device_name, result } = call;
  const action = (result?.action || (args?.action as string) || (name === "run_on_device" ? "shell" : name));
  const machineName = result?.device_name || device_name || (args?.device_id as string) || "";
  const command = (args?.command as string) || (args?.prompt as string) || "";
  const cwd = (args?.cwd as string) || "";

  const isTerminal =
    result?.status === "succeeded" ||
    result?.status === "failed" ||
    result?.status === "timeout";
  const isRunning = !result || result.status === "running" || result.status === "queued" || result.status === "still_running";

  useEffect(() => {
    if (isVisible && isRunning && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [result?.stdout, result?.stderr, isRunning, isVisible]);

  const isMatchFilter = Boolean(
    command && /(grep|findstr|lsof|pgrep|which)\b/i.test(command)
  );
  const isExit1NoMatch = result?.exit_code === 1 && isMatchFilter && (!result.stderr || result.stderr.trim().length === 0);

  const isSuccess = result?.status === "succeeded" || (result && result.exit_code === 0 && !result.error);
  const isFailed = !isExit1NoMatch && (result?.status === "failed" || (result && typeof result.exit_code === "number" && result.exit_code !== 0));

  const copyText = () => {
    const parts: string[] = [];
    if (command) parts.push(`$ ${command}`);
    if (result?.stdout) parts.push(result.stdout);
    if (result?.stderr) parts.push(`[stderr]\n${result.stderr}`);
    if (result?.error) parts.push(`[error] ${result.error}`);
    if (parts.length > 0) {
      navigator.clipboard.writeText(parts.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div
      style={{
        margin: "10px 0",
        borderRadius: 14,
        border: "1px solid var(--aurora-border-strong)",
        background: "var(--aurora-surface-solid)",
        overflow: "hidden",
        boxShadow: "0 2px 10px -2px rgba(0,0,0,0.06)",
      }}
    >
      {/* Header bar */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "9px 14px",
          background: "var(--aurora-chip)",
          borderBottom: expanded ? "1px solid var(--aurora-border)" : "none",
          cursor: "pointer",
          userSelect: "none",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 200 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              borderRadius: 7,
              background: isSuccess
                ? "rgba(16,185,129,0.12)"
                : isFailed
                ? "rgba(239,68,68,0.12)"
                : "var(--aurora-accent-soft)",
              color: isSuccess ? "#10B981" : isFailed ? "#EF4444" : "var(--aurora-accent)",
            }}
          >
            <Icon name={action === "agent" ? "sparkles" : name === "list_devices" ? "devices" : "terminal"} size={14} />
          </div>

          {machineName && (
            <span
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: "var(--aurora-fg1)",
                display: "flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              🖥️ {machineName}
            </span>
          )}

          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 6,
              background: "var(--aurora-surface-solid)",
              border: "1px solid var(--aurora-border-strong)",
              color: "var(--aurora-fg2)",
              letterSpacing: "0.02em",
            }}
          >
            {action === "shell" ? "Shell" : action === "agent" ? "Agent" : name}
          </span>

          {command && (
            <span
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 12,
                color: "var(--aurora-fg2)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 280,
              }}
            >
              $ {command}
            </span>
          )}
        </div>

        {/* Right side status badge & toggles */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {isRunning && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 11,
                padding: "3px 9px",
                borderRadius: 9999,
                background:
                  result?.status === "queued"
                    ? "rgba(245, 158, 11, 0.12)"
                    : "var(--aurora-accent-soft)",
                color:
                  result?.status === "queued"
                    ? "#d97706"
                    : "var(--aurora-accent)",
                fontWeight: 600,
                border: `1px solid ${result?.status === "queued" ? "rgba(245, 158, 11, 0.25)" : "var(--aurora-border)"}`,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background:
                    result?.status === "queued"
                      ? "#d97706"
                      : "var(--aurora-accent)",
                  animation: "pulse 1.5s infinite",
                }}
              />
              {result?.status === "queued"
                ? (t.ask.statusWaitingPoll || "等待设备拉取...")
                : (result?.stdout || result?.stderr) && isRunning
                ? (t.ask.statusStreaming || "⚡ 实时输出中...")
                : result?.status === "running"
                ? (t.ask.statusDeviceRunning || "设备运行中...")
                : result?.status === "still_running"
                ? (t.ask.statusStillRunning || "后台仍在执行...")
                : (t.ask.executing || "执行中...")}
            </span>
          )}

          {isExit1NoMatch && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 9999,
                background: "var(--aurora-surface-solid)",
                border: "1px solid var(--aurora-border-strong)",
                color: "var(--aurora-fg3)",
              }}
            >
              ○ 无匹配 (exit 1)
            </span>
          )}

          {isSuccess && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 9999,
                background: "rgba(16, 185, 129, 0.12)",
                border: "1px solid rgba(16, 185, 129, 0.25)",
                color: "#059669",
              }}
            >
              ✓ {result?.exit_code !== undefined ? `exit ${result.exit_code}` : (t.ask.statusSucceeded || "完成")}
            </span>
          )}

          {isFailed && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 9999,
                background: "rgba(239, 68, 68, 0.12)",
                border: "1px solid rgba(239, 68, 68, 0.25)",
                color: "#dc2626",
              }}
            >
              ✕ {result?.exit_code !== undefined ? `exit ${result.exit_code}` : (t.ask.statusFailed || "失败")}
            </span>
          )}

          {result?.status === "timeout" && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 9999,
                background: "rgba(245, 158, 11, 0.12)",
                border: "1px solid rgba(245, 158, 11, 0.25)",
                color: "#d97706",
              }}
            >
              ⏱️ {t.ask.statusTimeout || "超时"}
            </span>
          )}

          <Icon
            name={expanded ? "chevron_up" : "chevron_down"}
            size={14}
            style={{ color: "var(--aurora-fg3)" }}
          />
        </div>
      </div>

      {/* Terminal Content Box */}
      {expanded && (
        <div style={{ padding: 12 }}>
          {/* Sub-bar: cwd & copy */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
              fontSize: 11,
              color: "var(--aurora-fg3)",
            }}
          >
            <div>
              {cwd && (
                <span style={{ fontFamily: "monospace", color: "var(--aurora-fg2)" }}>
                  📁 {cwd}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                copyText();
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                background: "var(--aurora-chip)",
                border: "1px solid var(--aurora-border-strong)",
                borderRadius: 6,
                padding: "3px 9px",
                color: "var(--aurora-fg2)",
                fontSize: 11,
                fontWeight: 500,
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "var(--aurora-accent)";
                e.currentTarget.style.color = "var(--aurora-accent)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "var(--aurora-border-strong)";
                e.currentTarget.style.color = "var(--aurora-fg2)";
              }}
            >
              <Icon name={copied ? "check" : "copy"} size={12} />
              {copied ? (t.ask.copied || "已复制") : (t.ask.copyOutput || "复制输出")}
            </button>
          </div>

          {/* Terminal Console */}
          <pre
            ref={terminalRef}
            style={{
              margin: 0,
              padding: "12px 14px",
              borderRadius: 10,
              background: "#080c14",
              border: "1px solid rgba(255,255,255,0.08)",
              color: "#f1f5f9",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 12,
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              maxHeight: 320,
              overflowY: "auto",
            }}
          >
            {command && (
              <div style={{ color: "#38bdf8", marginBottom: 6, fontWeight: 600 }}>
                $ {command}
              </div>
            )}

            {isRunning && !result?.stdout && !result?.stderr && !result?.error && (
              <div style={{ color: "#94a3b8", fontStyle: "italic", margin: "4px 0" }}>
                {result?.status === "queued"
                  ? (t.ask.statusWaitingPoll || "等待设备拉取任务...")
                  : (t.ask.statusDeviceRunning || "设备已接收，命令正在运行...")}
              </div>
            )}

            {name === "list_devices" && result?.devices && (
              <div style={{ color: "#94a3b8" }}>
                {result.devices.length === 0
                  ? "没有可用设备。"
                  : result.devices.map((d, i) => (
                      <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", margin: "2px 0" }}>
                        <span style={{ color: d.online ? "#10b981" : "#ef4444" }}>
                          {d.online ? "● 在线" : "○ 离线"}
                        </span>
                        <span style={{ color: "#fff", fontWeight: 500 }}>{d.name}</span>
                        <span style={{ color: "#64748b" }}>({d.device_id.slice(0, 8)})</span>
                      </div>
                    ))}
              </div>
            )}

            {result?.stdout && (
              <div>{result.stdout}</div>
            )}

            {result?.stderr && (
              <div style={{ color: "#f87171", marginTop: 4 }}>
                <span style={{ opacity: 0.7 }}>[stderr]</span>
                <br />
                {result.stderr}
              </div>
            )}

            {result?.error && (
              isExit1NoMatch ? (
                <div style={{ color: "#94a3b8", marginTop: 4 }}>
                  ℹ️ 退出码 1：未匹配到目标内容（探查命令正常执行完毕，目标端口空闲或未检索到匹配项）
                </div>
              ) : (
                <div style={{ color: "#ef4444", marginTop: 4 }}>
                  [error] {result.error}
                </div>
              )
            )}

            {result?.note && (
              <div style={{ color: "#fbbf24", marginTop: 4 }}>
                ℹ️ {result.note}
              </div>
            )}

            {isRunning && (
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 14,
                  background: "#38bdf8",
                  verticalAlign: "text-bottom",
                  marginLeft: 4,
                  animation: "pulse 1s infinite",
                }}
              />
            )}
          </pre>
        </div>
      )}
    </div>
  );
}

export { default as ExecutionTabs } from "./ExecutionTabs";
