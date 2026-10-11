"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { Icon } from "./aurora/Icon";
import { BrandMark } from "./aurora/BrandMark";
import MarkdownViewer from "./viewers/MarkdownViewer";
import { useI18n } from "@/lib/i18n";
import type { TaskEvent } from "@memento/core";
import TaskTimeline, { SteerBox } from "./TaskTimeline";

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
    /** Steps of a structured agent run (Claude Code / Codex), live and after it ends. */
    events?: TaskEvent[];
    session_id?: string;
  };
}

interface ExecutionCardProps {
  call: ToolCallItem;
  isVisible?: boolean;
  parentContent?: string;
  onSmartCompactAndRetry?: (sessionId?: string) => void;
}

export default function ExecutionCard({
  call,
  isVisible = true,
  parentContent,
  onSmartCompactAndRetry,
}: ExecutionCardProps) {
  const { t } = useI18n();
  const terminalRef = useRef<HTMLPreElement>(null);

  const { name, args, device_name, result } = call;
  const action = (result?.action || (args?.action as string) || (name === "run_on_device" ? "shell" : name));
  const machineName = result?.device_name || device_name || (args?.device_id as string) || "";
  const command = (args?.command as string) || (args?.prompt as string) || "";
  const cwd = (args?.cwd as string) || "";

  const binary = (
    (args?.binary as string) ||
    ((call as any).binary as string) ||
    (result as any)?.binary ||
    ""
  ).toLowerCase();

  const isAgent = action === "agent" || binary.length > 0;
  let agentLabel = action === "shell" ? "Shell" : isAgent ? "Agent" : name;
  let agentBrandId: string | null = null;
  let agentColor = "var(--aurora-accent)";

  if (isAgent) {
    if (binary.includes("claude")) {
      agentLabel = "Claude Code";
      agentBrandId = "claude_code";
      agentColor = "#D97757";
    } else if (binary.includes("codex")) {
      agentLabel = "Codex";
      agentBrandId = "codex";
      agentColor = "#10A37F";
    } else if (binary.includes("agy") || binary.includes("antigravity")) {
      agentLabel = "Antigravity";
      agentBrandId = "antigravity";
      agentColor = "#3186FF";
    } else {
      agentLabel = "Agent";
      agentColor = "#9D67EF";
    }
  } else if (action === "shell") {
    agentLabel = "Shell";
    agentColor = "#38BDF8";
  } else if (name === "list_devices") {
    agentLabel = t.ask.deviceDiscovery || "设备发现";
  }

  const isTerminal =
    result?.status === "succeeded" ||
    result?.status === "failed" ||
    result?.status === "timeout";
  const isRunning = !result || result.status === "running" || result.status === "queued" || result.status === "still_running";

  // 过滤内部遥测噪音（例如 agy_cli 写入 stderr 的 session id: <uuid>，用于服务端进程关联，并非实际报错）
  const cleanStderr = useMemo(() => {
    if (!result?.stderr) return "";
    return result.stderr
      .split("\n")
      .filter((line) => !/^\s*session id:\s*[0-9a-fA-F-]+\s*$/i.test(line))
      .join("\n")
      .trim();
  }, [result?.stderr]);

  const isMatchFilter = Boolean(
    command && /(grep|findstr|lsof|pgrep|which)\b/i.test(command)
  );
  const isExit1NoMatch = result?.exit_code === 1 && isMatchFilter && (!cleanStderr || cleanStderr.length === 0);
  const isPromptTooLong = Boolean(
    (result?.stdout && result.stdout.includes("Prompt is too long")) ||
    (cleanStderr && cleanStderr.includes("Prompt is too long"))
  );

  const isStillRunning = result?.status === "still_running";
  const isSuccess = !isStillRunning && (result?.status === "succeeded" || (result && result.exit_code === 0 && !result.error));
  const isFailed = !isExit1NoMatch && !isStillRunning && (result?.status === "failed" || (result && typeof result.exit_code === "number" && result.exit_code !== 0));

  const hasParentContent = Boolean(parentContent && parentContent.trim().length > 0);
  const hasStructuredEvents = Boolean(result?.events && result.events.length > 0);

  // 严格比对：当父级主回复已包含或实时呈现卡片 stdout 时，避免在卡片内重复渲染窄框
  const isOutputInParentContent = Boolean(
    hasParentContent &&
    result?.stdout &&
    result.stdout.trim().length > 0 &&
    (
      isAgent ||
      parentContent!.trim() === result.stdout.trim() ||
      (parentContent!.length >= result.stdout.length * 0.85 && parentContent!.includes(result.stdout.trim()))
    )
  );

  // Agent 流式/完成输出已在主回复区全宽渲染时，默认折叠为单行状态条，消除框套框与宽度收缩
  const [userToggled, setUserToggled] = useState<boolean>(false);
  const [expanded, setExpanded] = useState<boolean>(() => {
    if ((isSuccess && hasParentContent) || (isAgent && hasParentContent && !isFailed && !hasStructuredEvents)) {
      return false;
    }
    return true;
  });

  useEffect(() => {
    if (userToggled) return;
    if ((isSuccess && hasParentContent) || (isAgent && hasParentContent && !isFailed && !hasStructuredEvents)) {
      setExpanded(false);
    }
  }, [userToggled, isSuccess, hasParentContent, isAgent, isFailed, hasStructuredEvents]);

  // Agent (Claude Code / Codex / Antigravity) 的输出是 Markdown 富文本，默认必须保持 markdown 视图，杜绝以原始 monospace 打印；shell 默认 terminal 视图
  const [viewMode, setViewMode] = useState<"markdown" | "terminal">(() => {
    return isAgent ? "markdown" : "terminal";
  });

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isVisible && isRunning && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [result?.stdout, cleanStderr, isRunning, isVisible]);

  const copyText = () => {
    const parts: string[] = [];
    if (command) parts.push(isAgent ? `[prompt] ${command}` : `$ ${command}`);
    if (result?.stdout) parts.push(result.stdout);
    if (cleanStderr) parts.push(`[stderr]\n${cleanStderr}`);
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
        maxWidth: "100%",
        minWidth: 0,
        boxShadow: "0 2px 10px -2px rgba(0,0,0,0.06)",
      }}
    >
      {/* Header bar */}
      <div
        onClick={() => {
          setUserToggled(true);
          setExpanded(!expanded);
        }}
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
          flexWrap: "nowrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7, flex: 1, minWidth: 0, overflow: "hidden" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              borderRadius: 7,
              flexShrink: 0,
              background: isSuccess
                ? "rgba(16,185,129,0.12)"
                : isFailed
                ? "rgba(239,68,68,0.12)"
                : "var(--aurora-accent-soft)",
              color: isSuccess ? "#10B981" : isFailed ? "#EF4444" : agentColor,
            }}
          >
            {agentBrandId ? (
              <BrandMark id={agentBrandId} size={15} colored={!isFailed && !isSuccess} tint={isSuccess ? "#10B981" : isFailed ? "#EF4444" : undefined} />
            ) : (
              <Icon name={isAgent ? "sparkles" : name === "list_devices" ? "devices" : "terminal"} size={14} />
            )}
          </div>

          {machineName && (
            <span
              title={machineName}
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--aurora-fg1)",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                maxWidth: "min(130px, 28vw)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flexShrink: 1,
                minWidth: 0,
              }}
            >
              🖥️ {machineName.replace(/\.local\b/i, "")}
            </span>
          )}

          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: "2px 7px",
              borderRadius: 6,
              background: "var(--aurora-surface-solid)",
              border: `1px solid ${agentBrandId ? agentColor + "40" : "var(--aurora-border-strong)"}`,
              color: agentBrandId ? agentColor : "var(--aurora-fg2)",
              letterSpacing: "0.02em",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            {agentLabel}
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
                maxWidth: "min(280px, 45vw)",
                flexShrink: 2,
                minWidth: 0,
              }}
            >
              $ {command}
            </span>
          )}
        </div>

        {/* Right side status badge & toggles */}
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0, marginLeft: "auto" }}>
          {isRunning && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 11,
                padding: "3px 9px",
                borderRadius: 9999,
                flexShrink: 0,
                whiteSpace: "nowrap",
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
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              ○ 无匹配 (exit 1)
            </span>
          )}

          {isStillRunning && (
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
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              ⏳ {t.ask.statusStillRunning || "后台执行中"}
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
                flexShrink: 0,
                whiteSpace: "nowrap",
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
                flexShrink: 0,
                whiteSpace: "nowrap",
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
                flexShrink: 0,
                whiteSpace: "nowrap",
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
        <div style={{ padding: "10px 12px" }}>
          {/* Sub-bar: cwd & format toggle & copy */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
              fontSize: 11,
              color: "var(--aurora-fg3)",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              {cwd && (
                <span style={{ fontFamily: "monospace", color: "var(--aurora-fg2)" }}>
                  📁 {cwd}
                </span>
              )}
              {(isAgent || result?.stdout) && (
                <div
                  style={{
                    display: "inline-flex",
                    background: "var(--aurora-chip)",
                    border: "1px solid var(--aurora-border)",
                    borderRadius: 8,
                    padding: 2,
                    gap: 2,
                  }}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setViewMode("markdown");
                    }}
                    style={{
                      background: viewMode === "markdown" ? "var(--aurora-accent-soft)" : "transparent",
                      border: "none",
                      color: viewMode === "markdown" ? "var(--aurora-accent)" : "var(--aurora-fg3)",
                      borderRadius: 6,
                      padding: "2px 8px",
                      fontSize: 11,
                      fontWeight: viewMode === "markdown" ? 600 : 400,
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    Markdown
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setViewMode("terminal");
                    }}
                    style={{
                      background: viewMode === "terminal" ? "var(--aurora-accent-soft)" : "transparent",
                      border: "none",
                      color: viewMode === "terminal" ? "var(--aurora-accent)" : "var(--aurora-fg3)",
                      borderRadius: 6,
                      padding: "2px 8px",
                      fontSize: 11,
                      fontWeight: viewMode === "terminal" ? 600 : 400,
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    Terminal
                  </button>
                </div>
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

          {result?.events && result.events.length > 0 && <TaskTimeline events={result.events} running={isRunning} />}
          {/* Claude reads follow-ups while it runs (stream-json input); other agents don't take them. */}
          {isRunning && binary.includes("claude") && result?.task_id && (result.events?.length ?? 0) > 0 && (
            <SteerBox taskId={result.task_id} />
          )}

          {/* Conditional Content: Markdown or Terminal Console */}
          {viewMode === "markdown" ? (
            <div
              className="prose prose-sm max-w-none w-full"
              style={{
                color: "var(--aurora-fg1)",
                fontSize: 13.5,
              }}
            >
              {command && (
                isAgent ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      padding: "8px 12px",
                      borderRadius: 8,
                      background: "var(--aurora-chip)",
                      border: "1px solid var(--aurora-border)",
                      marginBottom: 10,
                      fontSize: 12.5,
                      lineHeight: 1.5,
                      color: "var(--aurora-fg1)",
                    }}
                  >
                    <span style={{ color: agentColor, fontWeight: 600, flexShrink: 0 }}>
                      {t.ask.promptLabel || "提示词"}:
                    </span>
                    <span style={{ wordBreak: "break-word" }}>{command}</span>
                  </div>
                ) : (
                  <div style={{ color: "#38bdf8", marginBottom: 10, fontFamily: "monospace", fontSize: 12, fontWeight: 600 }}>
                    $ {command}
                  </div>
                )
              )}

              {isRunning && !result?.stdout && !cleanStderr && !result?.error && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--aurora-fg3)", fontStyle: "italic", padding: "10px 4px" }}>
                  <span
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: agentColor,
                      animation: "pulse 1.5s infinite ease-in-out",
                    }}
                  />
                  <span>
                    {result?.status === "queued"
                      ? (t.ask.statusWaitingPoll || "等待设备拉取任务...")
                      : (t.ask.statusDeviceRunning || `${agentLabel} 正在运行中...`)}
                  </span>
                </div>
              )}

              {result?.stdout ? (
                isOutputInParentContent ? (
                  <div
                    style={{
                      padding: "10px 14px",
                      borderRadius: 8,
                      background: "var(--aurora-chip)",
                      border: "1px dashed var(--aurora-border)",
                      color: "var(--aurora-fg2)",
                      fontSize: 12.5,
                      lineHeight: 1.6,
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, color: "var(--aurora-fg1)", marginBottom: 2 }}>
                      <Icon name="check" size={13} style={{ color: "#10b981" }} />
                      <span>执行产物与回复已在下方主回复区全宽呈现</span>
                    </div>
                    <div style={{ color: "var(--aurora-fg3)", fontSize: 11.5 }}>
                      为避免界面重复排版，此卡片聚焦执行状态。您可以切换至“Terminal”模式查验底层输出与命令日志。
                    </div>
                  </div>
                ) : (
                  <MarkdownViewer content={result.stdout} compactMedia={true} />
                )
              ) : null}

              {cleanStderr && (
                <div style={{ color: "#f87171", marginTop: 12, borderTop: "1px solid var(--aurora-border)", paddingTop: 8, fontFamily: "monospace", fontSize: 12 }}>
                  <span style={{ opacity: 0.7 }}>[stderr]</span>
                  <br />
                  {cleanStderr}
                </div>
              )}

              {result?.error && !isExit1NoMatch && (
                <div style={{ color: "#ef4444", marginTop: 8, fontFamily: "monospace", fontSize: 12 }}>
                  [error] {result.error}
                </div>
              )}

              {result?.note && (
                <div style={{ color: "#fbbf24", marginTop: 8, fontSize: 12 }}>
                  ℹ️ {result.note}
                </div>
              )}
            </div>
          ) : (
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
              maxWidth: "100%",
              maxHeight: "min(280px, 35vh)",
              overflowX: "auto",
              overflowY: "auto",
              overscrollBehavior: "contain",
              WebkitOverflowScrolling: "touch",
            }}
          >
            {command && (
              <div style={{ color: "#38bdf8", marginBottom: 6, fontWeight: 600 }}>
                {isAgent ? `[prompt] ${command}` : `$ ${command}`}
              </div>
            )}

            {isRunning && !result?.stdout && !cleanStderr && !result?.error && (
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

            {cleanStderr && (
              <div style={{ color: "#f87171", marginTop: 4 }}>
                <span style={{ opacity: 0.7 }}>[stderr]</span>
                <br />
                {cleanStderr}
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
          )}

          {isPromptTooLong && (
            <div
              style={{
                marginTop: 10,
                padding: "12px 14px",
                borderRadius: 8,
                background: "rgba(245, 158, 11, 0.12)",
                border: "1px solid rgba(245, 158, 11, 0.35)",
                color: "var(--aurora-fg1)",
                fontSize: 12,
              }}
            >
              <div style={{ fontWeight: 600, color: "#f59e0b", marginBottom: 4 }}>
                ⚠️ Claude Code 历史会话超出上下文限制 (Prompt is too long)
              </div>
              <div style={{ color: "var(--aurora-fg2)", lineHeight: 1.5 }}>
                “Prompt is too long” 并非指您输入的提问过长，而是当前续接的历史会话已累计大量消息与工具记录（超过了 200,000 Token 上下文限制）。
                <br />
                👉 <b>推荐解决办法</b>：点击下方按钮在<b>当前对话内就地智能提炼</b>并无缝轻装重试（保持当前对话连贯，无需新开会话）；或在下方下拉框中切换为<b>【➕ 新建独立会话】</b>。
              </div>
              {onSmartCompactAndRetry && (
                <div style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      const sid = (result as any)?.session_id || (args?.session_id as string) || "";
                      onSmartCompactAndRetry(sid);
                    }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      background: "linear-gradient(135deg, #f59e0b, #d97706)",
                      color: "#fff",
                      border: "none",
                      borderRadius: 6,
                      padding: "6px 14px",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                      boxShadow: "0 2px 6px rgba(245, 158, 11, 0.25)",
                    }}
                  >
                    <Icon name="sparkles" size={13} />
                    <span>⚡ 立即智能瘦身并重试 (Smart Compact & Retry)</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export { default as ExecutionTabs } from "./ExecutionTabs";
