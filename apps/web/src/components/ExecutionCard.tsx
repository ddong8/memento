"use client";

import { memo, useState, useEffect, useMemo } from "react";
import { Icon } from "./aurora/Icon";
import { BrandMark } from "./aurora/BrandMark";
import MarkdownViewer from "./viewers/MarkdownViewer";
import { useI18n } from "@/lib/i18n";
import type { TaskEvent } from "@memento/core";
import TaskTimeline from "./TaskTimeline";
import { useMediaInspector, extractMediaFromMarkdown } from "./viewers/MediaInspectorContext";
import { deviceOfCall } from "@/lib/file-devices";
import {
  formatToolArgsSummary,
  formatToolResultMarkdown,
  getToolMeta,
  isNonDeviceTool,
} from "@/lib/ask/tool-meta";

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
    /** "usage_limit": the agent's account ran out of quota; "prompt_too_long", "agent_login_required" */
    error_type?: string | null;
    note?: string;
    devices?: Array<{ device_id: string; name: string; collector_version?: string; online: boolean }>;
    /** Steps of a structured agent run (Claude Code / Codex), live and after it ends. */
    events?: TaskEvent[];
    session_id?: string;
    /** The device's session for this conversation is gone: the next question starts a new one. */
    session_reset?: boolean;
    alerts?: Array<{ label: string; detail?: string; tool?: string; level?: string }>;
  };
}

interface ExecutionCardProps {
  call: ToolCallItem;
  parentContent?: string;
  /** The user's message for this round: an agent card doesn't echo it back as its 提示词 */
  userPrompt?: string;
  onSmartCompactAndRetry?: (sessionId?: string) => void;
}

export function formatShortPath(pathStr?: string): string {
  if (!pathStr) return "";
  const p = pathStr.trim();
  return p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

export function cleanPromptText(text?: string): string {
  if (!text) return "";
  return text
    .replace(/^【用户上传了图片[\s\S]*?提示:[^\n]*\n*/g, "")
    .replace(/【用户上传了图片[\s\S]*?】/g, "")
    .replace(/^【用户附加文件:[\s\S]*?```[\s\S]*?```\n*/g, "")
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, "")
    .trim();
}

/** The agent was sent what the user typed (the bubble right above shows it): no need to print it again in the card.
 *  An orchestrator-written brief, or a prompt that only shares a few words with the question, is still shown. */
export function promptRepeatsUser(prompt?: string, userText?: string): boolean {
  const norm = (v?: string) => cleanPromptText(v).replace(/\s+/g, " ").trim();
  const p = norm(prompt);
  const u = norm(userText);
  if (!p || !u) return false;
  return p === u || (p.includes(u) && u.length >= p.length * 0.6);
}

/** Last folder of a working directory, for the card header ("~/dev/memento" -> "memento"). */
function shortDirName(pathStr: string): string {
  const parts = pathStr.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || pathStr;
}

const ExecutionCard = memo(function ExecutionCard({
  call,
  parentContent,
  userPrompt,
  onSmartCompactAndRetry,
}: ExecutionCardProps) {
  const { t, locale } = useI18n();
  const inspector = useMediaInspector?.() || null;
  const device = deviceOfCall(call);

  const { name, args, device_name, result } = call;
  const action = (result?.action || (args?.action as string) || (name === "run_on_device" ? "shell" : name));
  const machineName = result?.device_name || device_name || (args?.device_id as string) || "";
  const command = (args?.command as string) || (args?.prompt as string) || "";
  const cwd = (args?.cwd as string) || "";

  const discoveredMedia = useMemo(() => {
    // Only scan actual execution output (stdout, note, stderr), NEVER user input prompts or commands
    const textToScan = [
      result?.stdout,
      result?.note,
      result?.stderr,
    ]
      .filter(Boolean)
      .join("\n");
    const extracted = extractMediaFromMarkdown(textToScan);
    if (extracted.length === 0) return extracted;

    // Filter out temporary user-uploaded paths or items directly present in prompt arguments
    const promptRef = (
      (typeof args?.prompt === "string" ? args.prompt : "") + " " +
      (typeof args?.command === "string" ? args.command : "")
    );
    return extracted.filter((item) => {
      if (item.url.includes("/tmp/memento_images/") || item.url.includes("/memento/images/") || item.url.startsWith("blob:")) {
        return false;
      }
      if (promptRef && promptRef.includes(item.url)) {
        return false;
      }
      return true;
    });
  }, [result?.stdout, result?.note, result?.stderr, args?.prompt, args?.command]);

  const binary = (
    (args?.binary as string) ||
    ((call as any).binary as string) ||
    (result as any)?.binary ||
    ""
  ).toLowerCase();

  const isAgent = action === "agent" || binary.length > 0;
  const isNonDevice = !isAgent && action !== "shell" && isNonDeviceTool(name);
  const toolMeta = useMemo(() => getToolMeta(name, locale === "zh-CN"), [name, locale]);
  const nonDeviceArgSummary = useMemo(
    () => (isNonDevice ? formatToolArgsSummary(name, args) : ""),
    [isNonDevice, name, args],
  );
  const nonDeviceResultMarkdown = useMemo(
    () => (isNonDevice && result ? formatToolResultMarkdown(name, result as Record<string, unknown>) : ""),
    [isNonDevice, name, result],
  );

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
    } else if (binary.includes("workbuddy")) {
      agentLabel = "WorkBuddy";
      agentBrandId = "workbuddy";
      agentColor = "#0EC7A8";
    } else {
      agentLabel = "Agent";
      agentColor = "#9D67EF";
    }
  } else if (action === "shell") {
    agentLabel = "Shell";
    agentColor = "#38BDF8";
  } else if (name === "list_devices") {
    agentLabel = t.ask.deviceDiscovery || "设备发现";
  } else if (isNonDevice) {
    agentLabel = toolMeta.label;
    agentColor = toolMeta.color;
  }

  const callStatus = (call as any).status;
  const hasParentContent = Boolean(parentContent && parentContent.trim().length > 0);
  const nonDeviceDone = isNonDevice && Boolean(result);
  const isTerminal =
    nonDeviceDone ||
    (name === "list_devices" && Boolean(result)) ||
    result?.status === "succeeded" ||
    result?.status === "failed" ||
    result?.status === "timeout" ||
    callStatus === "executed" ||
    callStatus === "succeeded" ||
    callStatus === "failed";
  const isStillRunning = result?.status === "still_running";

  // The agent asked something (AskUserQuestion) and waits for the answer: the task goes on, whatever it
  // wrote before asking ("here are the drafts first:"), so its options stay clickable
  const awaitingAnswer =
    !isTerminal &&
    (!result || result.status === "running" || result.status === "queued" || isStillRunning) &&
    (result?.events || []).some((e) => {
      const q = e as { kind?: string; status?: string; answer?: string };
      return q.kind === "question" && q.status !== "answered" && !q.answer;
    });

  const hasActiveBackground =
    !isTerminal &&
    (result?.events || []).some(
      (e) =>
        (e.kind === "background" && Array.isArray((e as any).tasks) && (e as any).tasks.length > 0) ||
        (e.kind === "tool" && (e as any).status === "background"),
    );

  // While the underlying device task is still running/queued or tracking active background work, keep the
  // card in running state even after live text has started streaming. Only once a run has terminated with
  // still_running AND already produced its answer does it switch to the "留有后台任务" badge.
  const isRunning =
    !isTerminal &&
    (awaitingAnswer ||
      result?.status === "running" ||
      result?.status === "queued" ||
      hasActiveBackground ||
      (!hasParentContent && (isStillRunning || !result)));

  // 过滤内部遥测噪音（例如 agy_cli 写入 stderr 的 session id: <uuid>，用于服务端进程关联，并非实际报错）
  const cleanStderr = useMemo(() => {
    if (!result?.stderr) return "";
    const noisePatterns = [
      /^\s*session id:\s*[0-9a-fA-F-]+\s*$/i,
      /Tool is running as a background task/i,
      /The command was sent to the background as a task/i,
      /running as a background task with task id/i,
      /Command running in background/i,
      /Task running in background/i,
      /Task logs are available at:/i,
      /Task timed out after/i,
      /\b(?:timed?\s*out|timeout)\b/i,
      /\bbackground task\b/i,
      /(?:已转入|仍在|正在|已置于|提交至)后台(?:运行|执行|持续执行)/i,
      /(?:后台任务|后台进程)(?:已启动|正在执行|仍在运行|未完成)/i,
      /⏳\s*\[(?:等待后台任务|后台任务启动|后台任务运行中)/i,
      /⚡\s*\[(?:环境自愈|模型容灾降级|自动重试|自动自愈)\]/i,
      /STATUS_STILL_RUNNING/i,
      /No capacity available/i,
    ];
    return result.stderr
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        return !noisePatterns.some((pattern) => pattern.test(trimmed));
      })
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
  // The session's latest copy is on another device and couldn't be fetched from it (the device says why)
  const sessionUnavailable = String(result?.error || "").includes("没能取到原会话");

  const isFailed = !isExit1NoMatch && !isStillRunning && (
    result?.status === "failed" ||
    callStatus === "failed" ||
    (isNonDevice && Boolean(result?.error)) ||
    (result && typeof result.exit_code === "number" && result.exit_code !== 0)
  );
  const isSuccess = !isRunning && !isStillRunning && !isFailed && !awaitingAnswer && (
    isTerminal ||
    result?.status === "succeeded" ||
    callStatus === "executed" ||
    callStatus === "succeeded" ||
    (result && result.exit_code === 0 && !result.error) ||
    hasParentContent
  );
  const hasStructuredEvents = Boolean(result?.events && result.events.length > 0);

  // 当已有主回复内容 (hasParentContent)、或属于 Agent 回复场景、或任务正常成功时，彻底屏蔽 stderr 输出
  // 仅在任务真正彻底失败且无主回复内容时才展示实质性错误信息
  const shouldShowStderr = Boolean(
    cleanStderr &&
    !hasParentContent &&
    !isSuccess &&
    isFailed
  );

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

  const waitingQuestion = useMemo(() => {
    return result?.events?.find(
      (e) => e.kind === "question" && (e.status === "waiting" || !e.status)
    );
  }, [result?.events]);

  // Agent 流式/完成输出已在主回复区全宽渲染时，默认折叠为单行状态条，消除框套框与宽度收缩
  const [userToggled, setUserToggled] = useState<boolean>(false);
  const [expanded, setExpanded] = useState<boolean>(() => {
    if (waitingQuestion) return true;
    if (isNonDevice && isSuccess) return false;
    if (hasParentContent && (isSuccess || (isAgent && !isFailed))) {
      return false;
    }
    return true;
  });

  useEffect(() => {
    if (waitingQuestion) {
      setExpanded(true);
      return;
    }
    if (userToggled) return;
    if ((isNonDevice && isSuccess) || (hasParentContent && (isSuccess || (isAgent && !isFailed)))) {
      setExpanded(false);
    }
  }, [userToggled, isNonDevice, isSuccess, hasParentContent, isAgent, isFailed, waitingQuestion]);

  const [copied, setCopied] = useState(false);
  const [showAllLogs, setShowAllLogs] = useState(false);

  // Copy only appears once there's something worth copying: a shell command, or output / an error
  const hasCopyableOutput = Boolean(
    (!isAgent && command) || result?.stdout || nonDeviceResultMarkdown || (shouldShowStderr && cleanStderr) || result?.error,
  );

  const copyText = () => {
    const parts: string[] = [];
    if (command) parts.push(isAgent ? `[prompt] ${command}` : `$ ${command}`);
    else if (nonDeviceArgSummary) parts.push(`[${agentLabel}] ${nonDeviceArgSummary}`);
    if (result?.stdout) parts.push(result.stdout);
    if (nonDeviceResultMarkdown) parts.push(nonDeviceResultMarkdown);
    if (shouldShowStderr && cleanStderr) parts.push(`[stderr]\n${cleanStderr}`);
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
        margin: "8px 0",
        borderRadius: 11,
        border: "1px solid var(--aurora-border)",
        background: "var(--aurora-thinking-bg)",
        overflow: "hidden",
        maxWidth: "100%",
        minWidth: 0,
      }}
    >
      {/* Header bar */}
      <div
        onClick={() => {
          setUserToggled(true);
          setExpanded(!expanded);
        }}
        className="px-2.5 sm:px-3 py-1.5 sm:py-2 transition-colors hover:bg-[var(--aurora-chip)]"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "var(--aurora-thinking-header)",
          borderBottom: expanded ? "1px solid var(--aurora-border)" : "none",
          cursor: "pointer",
          userSelect: "none",
          gap: 8,
          flexWrap: "nowrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7, flex: 1, minWidth: 0, overflow: "hidden" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 24,
              height: 24,
              borderRadius: 6,
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
              <BrandMark id={agentBrandId} size={14} colored={!isFailed && !isSuccess} tint={isSuccess ? "#10B981" : isFailed ? "#EF4444" : undefined} />
            ) : (
              <Icon name={isAgent ? "sparkles" : name === "list_devices" ? "devices" : isNonDevice ? toolMeta.icon : "terminal"} size={13} />
            )}
          </div>

          {machineName && (
            <span
              title={machineName}
              className="hidden sm:inline-flex"
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: "var(--aurora-fg2)",
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
              <Icon name="devices" size={11.5} style={{ color: "var(--aurora-fg3)", flexShrink: 0 }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{machineName.replace(/\.local\b/i, "")}</span>
            </span>
          )}

          <span
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              padding: "1.5px 6.5px",
              borderRadius: 5,
              background: "var(--aurora-surface-solid)",
              border: `1px solid ${agentBrandId ? agentColor + "35" : "var(--aurora-border)"}`,
              color: agentBrandId ? agentColor : "var(--aurora-fg2)",
              letterSpacing: "0.01em",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            {agentLabel}
          </span>

          {/* Agents: the working folder sits in the header (full path on hover) instead of its own row */}
          {isAgent && cwd && (
            <span
              title={cwd}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--aurora-fg3)",
                overflow: "hidden",
                whiteSpace: "nowrap",
                minWidth: 0,
                flexShrink: 1,
              }}
            >
              <Icon name="folder" size={11} style={{ color: "var(--aurora-accent)", flexShrink: 0 }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{shortDirName(cwd)}</span>
            </span>
          )}

          {command ? (
            <span
              className={isAgent ? "hidden md:inline" : "inline"}
              style={{
                fontFamily: "var(--font-mono)",
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
          ) : nonDeviceArgSummary ? (
            <span
              style={{
                fontSize: 12,
                color: "var(--aurora-fg2)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: "min(300px, 46vw)",
                flexShrink: 2,
                minWidth: 0,
              }}
            >
              {nonDeviceArgSummary}
            </span>
          ) : null}
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
                  waitingQuestion
                    ? "rgba(245, 158, 11, 0.18)"
                    : hasActiveBackground
                    ? "rgba(245, 158, 11, 0.14)"
                    : result?.status === "queued"
                    ? "rgba(245, 158, 11, 0.12)"
                    : "var(--aurora-accent-soft)",
                color:
                  waitingQuestion || hasActiveBackground || result?.status === "queued"
                    ? "#d97706"
                    : "var(--aurora-accent)",
                fontWeight: 600,
                border: `1px solid ${
                  waitingQuestion
                    ? "rgba(245, 158, 11, 0.4)"
                    : hasActiveBackground
                    ? "rgba(245, 158, 11, 0.32)"
                    : result?.status === "queued"
                    ? "rgba(245, 158, 11, 0.25)"
                    : "var(--aurora-border)"
                }`,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background:
                    waitingQuestion || hasActiveBackground || result?.status === "queued"
                      ? "#d97706"
                      : "var(--aurora-accent)",
                  animation: "pulse 1.5s infinite",
                }}
              />
              {waitingQuestion
                ? (locale === "zh-CN" ? "等待回复选择..." : "Waiting for response...")
                : hasActiveBackground
                ? (locale === "zh-CN" ? "后台运行中..." : "Running in background...")
                : result?.status === "queued"
                ? (t.ask.statusWaitingPoll || "等待设备拉取...")
                : (result?.stdout || result?.stderr) && isRunning
                ? (t.ask.statusStreaming || "实时输出中...")
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
                background: "var(--aurora-warn-soft)",
                border: "1px solid transparent",
                color: "var(--aurora-warn)",
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              <Icon name="clock" size={11} strokeWidth={2.2} />
              {hasParentContent ? (t.ask.statusBackgroundLeft || "留有后台任务") : (t.ask.statusStillRunning || "后台执行中")}
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
                background: "var(--aurora-success-soft)",
                border: "1px solid transparent",
                color: "var(--aurora-success)",
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              <Icon name="check" size={11} strokeWidth={2.4} />
              {result?.exit_code !== undefined ? `exit ${result.exit_code}` : (t.ask.statusSucceeded || "完成")}
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
                background: "var(--aurora-danger-soft)",
                border: "1px solid transparent",
                color: "var(--aurora-danger)",
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              <Icon name="close" size={11} strokeWidth={2.4} />
              {result?.error_type === "usage_limit"
                ? (t.ask.statusUsageLimit || "额度已用完")
                : result?.exit_code !== undefined ? `exit ${result.exit_code}` : (t.ask.statusFailed || "失败")}
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
                background: "var(--aurora-warn-soft)",
                border: "1px solid transparent",
                color: "var(--aurora-warn)",
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

      {/* Content Box */}
      {expanded && (
        <div style={{ padding: "10px 12px" }}>
          {/* Safety Alerts Banner */}
          {result?.alerts && result.alerts.length > 0 && (
            <div style={{ marginBottom: 10, display: "flex", flexDirection: "column", gap: 6 }}>
              {result.alerts.map((alt: any, idx: number) => {
                const isCrit = alt.level === "critical";
                const isDanger = alt.level === "danger" || !alt.level;
                const bg = isCrit ? "rgba(239, 68, 68, 0.12)" : isDanger ? "rgba(249, 115, 22, 0.12)" : "rgba(245, 158, 11, 0.12)";
                const border = isCrit ? "#ef4444" : isDanger ? "#f97316" : "#f59e0b";
                const fg = isCrit ? "#ef4444" : isDanger ? "#f97316" : "#d97706";
                return (
                  <div
                    key={idx}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      padding: "8px 12px",
                      borderRadius: 8,
                      background: bg,
                      border: `1px solid ${border}`,
                      fontSize: 12,
                      lineHeight: 1.5,
                    }}
                  >
                    <Icon name={isCrit ? "close" : isDanger ? "activity" : "sparkles"} size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: fg }}>
                        {isCrit ? "【核心高危指令】" : isDanger ? "【高危操作风险】" : "【操作提醒】"} {alt.label}
                      </div>
                      {alt.detail && (
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--aurora-fg2)", wordBreak: "break-all", marginTop: 2 }}>
                          {alt.detail}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Sub-bar: cwd (shell commands; agents show it in the header) & copy (only once there is output to copy) */}
          {((!isAgent && cwd) || hasCopyableOutput) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
              fontSize: 11,
              color: "var(--aurora-fg3)",
              gap: 6,
              minWidth: 0,
              width: "100%",
            }}
          >
            <div style={{ minWidth: 0, flex: "1 1 auto", overflow: "hidden", display: "flex", alignItems: "center" }}>
              {!isAgent && cwd && (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--aurora-fg3)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: "100%",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                  title={cwd}
                >
                  <Icon name="folder" size={11.5} style={{ color: "var(--aurora-accent)", flexShrink: 0 }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{formatShortPath(cwd)}</span>
                </span>
              )}
            </div>

            {hasCopyableOutput && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
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
                  background: "var(--aurora-chip)",
                  border: "1px solid var(--aurora-border-strong)",
                  borderRadius: 6,
                  padding: "2px 7px",
                  color: "var(--aurora-fg2)",
                  fontSize: 10.5,
                  fontWeight: 500,
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                  whiteSpace: "nowrap",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--aurora-accent)";
                  e.currentTarget.style.color = "var(--aurora-accent)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--aurora-border-strong)";
                  e.currentTarget.style.color = "var(--aurora-fg2)";
                }}
                title={t.ask.copyOutput || "复制输出"}
              >
                <Icon name={copied ? "check" : "copy"} size={11} />
                <span>{copied ? (t.ask.copied || "已复制") : "复制"}</span>
              </button>
            </div>
            )}
          </div>
          )}

          {result?.events && result.events.length > 0 && (
            <TaskTimeline events={result.events} running={isRunning} taskId={result?.task_id} device={device} />
          )}
          {/* Follow-ups go in from the main input below: it steers the running agent or queues for the next message */}

          <div
              className="prose prose-sm max-w-none w-full"
              style={{
                color: "var(--aurora-fg1)",
                fontSize: 13.5,
              }}
            >
              {/* 生成产物快速唤起横幅 */}
              {discoveredMedia.length > 0 && inspector && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    padding: "8px 12px",
                    borderRadius: 10,
                    background: "rgba(56, 189, 248, 0.12)",
                    border: "1px solid rgba(56, 189, 248, 0.3)",
                    marginBottom: 10,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <Icon name={discoveredMedia[0].type === "presentation" ? "layers" : discoveredMedia[0].type === "spreadsheet" ? "grid" : "book"} size={16} style={{ flexShrink: 0 }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--aurora-fg1)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        已生成产物：{discoveredMedia[0].title}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--aurora-fg3)" }}>
                        点击在 Memento 应用内直接打开视窗预览
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      inspector.openMediaByUrl(discoveredMedia[0].url, discoveredMedia[0].title, null, device);
                    }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "4px 12px",
                      borderRadius: 8,
                      background: "var(--aurora-accent)",
                      color: "#fff",
                      fontSize: 11.5,
                      fontWeight: 600,
                      border: "none",
                      cursor: "pointer",
                      flexShrink: 0,
                      boxShadow: "0 2px 8px rgba(56, 189, 248, 0.3)",
                    }}
                  >
                    <span>应用内打开 ↗</span>
                  </button>
                </div>
              )}
              {command && (
                isAgent ? (
                  // 当外层主对话已包含用户提问气泡（hasParentContent）时，不在此卡片内重复展示提示词；仅当独立卡片且净化后非空时展示
                  !hasParentContent && cleanPromptText(command) && !promptRepeatsUser(command, userPrompt) ? (
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
                      <span style={{ wordBreak: "break-word" }}>{cleanPromptText(command)}</span>
                    </div>
                  ) : null
                ) : (
                  <div style={{ color: "#38bdf8", marginBottom: 10, fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, wordBreak: "break-all" }}>
                    $ {command}
                  </div>
                )
              )}

              {/* No "设备运行中…" line here: the badge in the header already says it */}

              {name === "list_devices" && result?.devices && (
                <div style={{ fontSize: 12.5, color: "var(--aurora-fg2)" }}>
                  {result.devices.length === 0
                    ? "没有可用设备。"
                    : result.devices.map((d, i) => (
                        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", margin: "2px 0" }}>
                          <span style={{ color: d.online ? "#10b981" : "#ef4444" }}>{d.online ? "● 在线" : "○ 离线"}</span>
                          <span style={{ color: "var(--aurora-fg1)", fontWeight: 500 }}>{d.name}</span>
                          <span style={{ color: "var(--aurora-fg3)" }}>({d.device_id.slice(0, 8)})</span>
                        </div>
                      ))}
                </div>
              )}

              {isNonDevice && nonDeviceResultMarkdown && (
                <div style={{ fontSize: 13, lineHeight: 1.55 }}>
                  <MarkdownViewer
                    content={nonDeviceResultMarkdown.length > 20_000 && !showAllLogs ? nonDeviceResultMarkdown.slice(0, 20_000) : nonDeviceResultMarkdown}
                    compactText={true}
                  />
                  {nonDeviceResultMarkdown.length > 20_000 && !showAllLogs && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowAllLogs(true);
                      }}
                      style={{ background: "transparent", border: "none", color: "var(--aurora-accent)", fontSize: 11.5, cursor: "pointer", padding: "4px 0" }}
                    >
                      展开全部 ({nonDeviceResultMarkdown.length.toLocaleString()} 字符)
                    </button>
                  )}
                </div>
              )}

              {result?.stdout ? (
                isOutputInParentContent ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "6px 10px",
                      borderRadius: 7,
                      background: "var(--aurora-chip-soft, rgba(255, 255, 255, 0.04))",
                      border: "1px solid var(--aurora-border)",
                      fontSize: 11.5,
                      color: "var(--aurora-fg3)",
                      marginTop: 4,
                      marginBottom: 6,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <Icon name="check" size={12} style={{ color: "#10b981" }} />
                      <span style={{ color: "var(--aurora-fg2)", fontWeight: 500 }}>
                        执行产物与回复已在下方主回复区呈现
                      </span>
                    </div>
                  </div>
                ) : (
                  <>
                    <MarkdownViewer
                      content={result.stdout.length > 60_000 && !showAllLogs ? result.stdout.slice(-40_000) : result.stdout}
                      compactMedia={true}
                      isStreaming={isRunning}
                    />
                    {result.stdout.length > 60_000 && !showAllLogs && (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 8, fontSize: 11.5, color: "var(--aurora-fg3)" }}>
                        <span>输出共 {result.stdout.length.toLocaleString()} 字符，为保持流畅只显示最近 40,000 字符</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowAllLogs(true);
                          }}
                          style={{ background: "transparent", border: "none", color: "var(--aurora-accent)", fontSize: 11.5, cursor: "pointer", padding: "2px 4px", flexShrink: 0 }}
                        >
                          展开全部
                        </button>
                      </div>
                    )}
                  </>
                )
              ) : null}

              {shouldShowStderr && (
                <div style={{ color: "#f87171", marginTop: 12, borderTop: "1px solid var(--aurora-border)", paddingTop: 8, fontFamily: "var(--font-mono)", fontSize: 12 }}>
                  <span style={{ opacity: 0.7 }}>[stderr]</span>
                  <br />
                  {cleanStderr}
                </div>
              )}

              {result?.error && !isExit1NoMatch && (
                <div style={{ color: "#ef4444", marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 12 }}>
                  [error] {result.error}
                </div>
              )}

              {result?.note && (
                <div style={{ color: "#fbbf24", marginTop: 8, fontSize: 12 }}>
                  ℹ️ {result.note}
                </div>
              )}
            </div>

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
                Claude Code 历史会话超出上下文上限
              </div>
              <div style={{ color: "var(--aurora-fg2)", lineHeight: 1.5 }}>
                “Prompt is too long” 并非指您输入的提问过长，而是当前续接的历史会话已累计大量消息与工具记录（超过了 200,000 Token 上下文限制）。
                <br />
                推荐解决办法：点击下方按钮在<b>当前对话内就地智能提炼</b>并无缝轻装重试（保持当前对话连贯，无需新开会话）；或在下方下拉框中切换为<b>「新建独立会话」</b>。
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
                      boxShadow: "0 2px 6px rgba(217, 119, 6, 0.24)",
                    }}
                  >
                    <Icon name="sparkles" size={13} />
                    <span>压缩上下文后重试</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {sessionUnavailable && onSmartCompactAndRetry && (
            <div
              style={{
                marginTop: 10,
                padding: "10px 14px",
                borderRadius: 8,
                background: "rgba(245, 158, 11, 0.12)",
                border: "1px solid rgba(245, 158, 11, 0.35)",
                fontSize: 12,
                color: "var(--aurora-fg2)",
                lineHeight: 1.5,
              }}
            >
              原会话在另一台设备上，这次没能取过来。打开那台设备上的 Memento 后重发，会在原会话里原样接着做；
              也可以用它的核心记忆快照在这台设备上新开一个会话接着做。
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSmartCompactAndRetry((args?.session_id as string) || "");
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    background: "linear-gradient(135deg, #f59e0b, #d97706)",
                    color: "#fff",
                    border: "none",
                    borderRadius: 6,
                    padding: "5px 12px",
                    fontSize: 11.5,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  <Icon name="sparkles" size={12} />
                  <span>用快照接着做</span>
                </button>
              </div>
            </div>
          )}

          {isFailed && !isPromptTooLong && !sessionUnavailable && (
            <div
              style={{
                marginTop: 10,
                padding: "8px 12px",
                borderRadius: 8,
                background: "rgba(239, 68, 68, 0.08)",
                border: "1px solid rgba(239, 68, 68, 0.25)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <div style={{ fontSize: 12, color: "#ef4444", display: "flex", alignItems: "center", gap: 6 }}>
                <span>任务执行遇到错误 {result?.exit_code !== undefined ? `(exit ${result.exit_code})` : ""}</span>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  const errMsg = (result?.error || result?.stderr || result?.stdout || "").trim().slice(-600);
                  const cmd = (command || (args?.command as string) || "").trim();
                  const fixPrompt = `我在执行以下命令/任务时遇到了报错：\n\`\`\`bash\n${cmd || name}\n\`\`\`\n报错信息如下：\n\`\`\`text\n${errMsg || "执行失败，未返回具体 stderr"}\n\`\`\`\n请帮我深入分析该错误根因，并提供修复方案或直接代我执行修复操作。`;
                  if (typeof window !== "undefined") {
                    window.dispatchEvent(
                      new CustomEvent("memento_fill_input", {
                        detail: { text: fixPrompt, autoSubmit: true },
                      })
                    );
                  }
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  background: "linear-gradient(135deg, #ef4444, #dc2626)",
                  color: "#fff",
                  border: "none",
                  borderRadius: 6,
                  padding: "5px 12px",
                  fontSize: 11.5,
                  fontWeight: 600,
                  cursor: "pointer",
                  boxShadow: "0 2px 6px rgba(239, 68, 68, 0.25)",
                  transition: "opacity 0.15s ease",
                }}
                title="自动将此报错交给执事分析并尝试自动修复"
              >
                <Icon name="sparkles" size={12} />
                <span>请求执事分析并修复</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default ExecutionCard;
export { default as ExecutionTabs } from "./ExecutionTabs";
