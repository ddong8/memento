import type { TaskEvent } from "./events.js";

/**
 * A tool step arrives as "running" and again when it's done; keep one row per
 * tool id, updated in place. Other events are appended.
 */
export function mergeTaskEvent(events: readonly TaskEvent[], event: TaskEvent): TaskEvent[] {
  if ((event.kind === "tool" || event.kind === "question") && event.id) {
    const i = events.findIndex((e) => e.kind === event.kind && e.id === event.id);
    if (i >= 0) {
      const merged = { ...events[i], ...event } as TaskEvent;
      return [...events.slice(0, i), merged, ...events.slice(i + 1)];
    }
  }
  return [...events, event];
}

/** "12 步 · $0.21 · 3 分 4 秒" from a run's tool steps and usage. */
export function taskRunSummary(events: readonly TaskEvent[]): string {
  const steps = events.filter((e) => e.kind === "tool").length;
  const usage = [...events].reverse().find((e) => e.kind === "usage");
  const parts = [`${steps} 步`];
  if (usage?.kind === "usage") {
    const cost = usage.cost_usd;
    if (typeof cost === "number" && cost > 0) parts.push(`$${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}`);
    const ms = usage.duration_ms;
    if (typeof ms === "number" && ms > 0) {
      const s = Math.round(ms / 1000);
      parts.push(s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`);
    }
  }
  return parts.join(" · ");
}

/** What a Claude Code / Codex tool does, in the user's words. */
export function taskToolLabel(name: string | undefined): string {
  switch (name) {
    case "Bash":
    case "BashOutput":
    case "Shell":
      return "运行命令";
    case "Read":
      return "读取";
    case "Write":
      return "新建文件";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "修改";
    case "Grep":
    case "Glob":
      return "查找";
    case "WebSearch":
      return "搜索网页";
    case "WebFetch":
      return "打开网页";
    case "Task":
    case "Agent":
      return "派子任务";
    case "TodoWrite":
      return "更新待办";
    default:
      return name ?? "工具";
  }
}

/** What happened to a follow-up the user sent to a running task. */
export function steerNote(status: string | undefined): string {
  switch (status) {
    case "late":
      return "任务已结束，没来得及送达";
    case "unsupported":
      return "这个 agent 不支持中途补充，等它做完后续接再说";
    default:
      return "已送达，会在下一步读到";
  }
}
