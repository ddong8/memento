"use client";

import { useState } from "react";
import { Icon } from "./aurora/Icon";
import { Chip } from "./aurora/primitives";
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
}

export default function ExecutionCard({ call }: ExecutionCardProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);

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
  const isSuccess = result?.status === "succeeded" || (result && result.exit_code === 0 && !result.error);
  const isFailed = result?.status === "failed" || (result && typeof result.exit_code === "number" && result.exit_code !== 0);

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
        border: "1px solid var(--aurora-border, rgba(255,255,255,0.12))",
        background: "rgba(13, 17, 23, 0.75)",
        backdropFilter: "blur(12px)",
        overflow: "hidden",
        boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
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
          background: "rgba(255,255,255,0.03)",
          borderBottom: expanded ? "1px solid rgba(255,255,255,0.06)" : "none",
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
                ? "rgba(16,185,129,0.15)"
                : isFailed
                ? "rgba(239,68,68,0.15)"
                : "rgba(59,130,246,0.15)",
              color: isSuccess ? "#10B981" : isFailed ? "#EF4444" : "var(--aurora-accent, #38bdf8)",
            }}
          >
            <Icon name={action === "agent" ? "sparkles" : name === "list_devices" ? "devices" : "terminal"} size={14} />
          </div>

          {machineName && (
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--aurora-fg1, #fff)",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              🖥️ {machineName}
            </span>
          )}

          <Chip tone="neutral" style={{ fontSize: 10, padding: "2px 7px" }}>
            {action === "shell" ? "Shell" : action === "agent" ? "Agent" : name}
          </Chip>

          {command && (
            <span
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 12,
                color: "var(--aurora-fg3, #94a3b8)",
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
                background: "rgba(56,189,248,0.15)",
                color: "var(--aurora-accent, #38bdf8)",
                fontWeight: 500,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--aurora-accent, #38bdf8)",
                  animation: "pulse 1.5s infinite",
                }}
              />
              {t.ask.executing || "执行中..."}
            </span>
          )}

          {isSuccess && (
            <Chip tone="success">
              ✓ {result?.exit_code !== undefined ? `exit ${result.exit_code}` : (t.ask.statusSucceeded || "完成")}
            </Chip>
          )}

          {isFailed && (
            <Chip tone="danger">
              ✕ {result?.exit_code !== undefined ? `exit ${result.exit_code}` : (t.ask.statusFailed || "失败")}
            </Chip>
          )}

          {result?.status === "timeout" && (
            <Chip tone="warn">⏱️ {t.ask.statusTimeout || "超时"}</Chip>
          )}

          <Icon
            name={expanded ? "chevron_up" : "chevron_down"}
            size={14}
            style={{ color: "var(--aurora-fg4, #64748b)" }}
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
              color: "var(--aurora-fg4, #64748b)",
            }}
          >
            <div>
              {cwd && (
                <span style={{ fontFamily: "monospace" }}>
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
                gap: 4,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 6,
                padding: "2px 8px",
                color: "var(--aurora-fg3, #94a3b8)",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              <Icon name={copied ? "check" : "copy"} size={11} />
              {copied ? (t.ask.copied || "已复制") : (t.ask.copyOutput || "复制")}
            </button>
          </div>

          {/* Terminal Console */}
          <pre
            style={{
              margin: 0,
              padding: "10px 14px",
              borderRadius: 8,
              background: "#080c14",
              border: "1px solid rgba(255,255,255,0.05)",
              color: "#e2e8f0",
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
              <div style={{ color: "#ef4444", marginTop: 4 }}>
                [error] {result.error}
              </div>
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
                  background: "var(--aurora-accent, #38bdf8)",
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
