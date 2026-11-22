export type LiveActivityAction = "start" | "update" | "end";

export interface LiveActivityTaskEventUpdate {
  status: string;
  currentStep: string;
  toolName?: string | null;
}

const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);

/**
 * Sanitize step text pushed to iOS Live Activity / Dynamic Island.
 * Existing installed iOS clients (<= v1.0.153) mistakenly treat any `currentStep`
 * containing "完成" / "已结束" / "已停止" as finished (`isFinished == true`) even when
 * `status` is still running/executing/background. Rewriting these tokens for
 * non-terminal updates immediately protects installed iOS clients without requiring
 * an app reinstall.
 */
export function sanitizeLiveActivityStep(
  step: string,
  status = "running",
  action: LiveActivityAction = "update",
): string {
  const cleaned = String(step || "").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return action === "end" || TERMINAL_STATUSES.has(status) ? "任务完成" : "正在执行...";
  }
  if (action === "end" || TERMINAL_STATUSES.has(status)) {
    return cleaned.slice(0, 85);
  }
  const safe = cleaned
    .replaceAll("已完成", "已就绪")
    .replaceAll("完成", "就绪")
    .replaceAll("已结束", "收尾中")
    .replaceAll("已停止", "暂停中");
  return (safe || "正在执行...").slice(0, 85);
}

export function formatLiveActivityToolStep(
  name: string,
  args?: Record<string, unknown> | null,
): string {
  const toolName = String(name || "tool").trim() || "tool";
  const obj = args && typeof args === "object" ? args : {};
  if (toolName === "run_on_device") {
    const shellCmd = String(obj.command || "").replace(/\s+/g, " ").trim();
    if (shellCmd) {
      return sanitizeLiveActivityStep(`设备命令: ${shellCmd.slice(0, 36)}`, "tool", "update");
    }
    // Never echo user's raw prompt into currentStep: it is already in the title and may contain "完成".
    return "正在设备上执行智能体任务...";
  }
  const cmdRaw = String(obj.command || obj.prompt || obj.code || "").replace(/\s+/g, " ").trim();
  const raw = cmdRaw ? `调用工具: ${toolName} (${cmdRaw.slice(0, 36)})` : `调用工具: ${toolName}`;
  return sanitizeLiveActivityStep(raw, "tool", "update");
}

export function formatLiveActivityProgressStep(status?: string | null): string {
  const raw = String(status || "").replace(/\s+/g, " ").trim();
  const lower = raw.toLowerCase();
  if (!raw || lower === "running") return "设备任务执行中...";
  if (lower === "queued") return "任务排队中...";
  return sanitizeLiveActivityStep(`执行进度: ${raw}`, "executing", "update");
}

export function formatLiveActivityTaskEvent(
  event: Record<string, unknown> | null | undefined,
): LiveActivityTaskEventUpdate | null {
  if (!event || typeof event !== "object") return null;
  const kind = event.kind;
  if (kind === "background" && Array.isArray(event.tasks)) {
    const tasks = event.tasks.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
    if (tasks.length > 0) {
      const firstDesc = String(tasks[0].description || tasks[0].id || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 30);
      const raw = firstDesc
        ? `后台运行中（${tasks.length}个）: ${firstDesc}`
        : `后台任务运行中（${tasks.length}个）`;
      return {
        status: "background",
        currentStep: sanitizeLiveActivityStep(raw, "background", "update"),
        toolName: "background",
      };
    }
    return {
      status: "thinking",
      currentStep: "后台结果已返回，继续推理中...",
      toolName: null,
    };
  }
  if (kind === "subagent" && event.status === "running") {
    const name = String(event.name || "子智能体").replace(/\s+/g, " ").trim().slice(0, 30);
    return {
      status: "executing",
      currentStep: sanitizeLiveActivityStep(`子智能体运行中: ${name}`, "executing", "update"),
      toolName: "subagent",
    };
  }
  if (kind === "tool" && (event.status === "running" || event.status === "background")) {
    const isBg = event.status === "background";
    const tname = String(event.name || "tool").replace(/\s+/g, " ").trim() || "tool";
    const detail = String(event.detail || "").replace(/\s+/g, " ").trim().slice(0, 30);
    const prefix = isBg ? "后台运行" : "执行工具";
    const raw = detail ? `${prefix}: ${tname} (${detail})` : `${prefix}: ${tname}`;
    const status = isBg ? "background" : "tool";
    return {
      status,
      currentStep: sanitizeLiveActivityStep(raw, status, "update"),
      toolName: tname,
    };
  }
  if (kind === "thinking" && event.text) {
    return {
      status: "thinking",
      currentStep: "正在深度思考与推演...",
    };
  }
  return null;
}
