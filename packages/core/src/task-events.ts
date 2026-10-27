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

/** 3,640 万 / 1.2 亿 / 8,500: a token count the way the run summary shows it. */
export function formatTokenCount(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)} 亿`;
  if (n >= 1e4) return `${Math.round(n / 1e4).toLocaleString("en-US")} 万`;
  return Math.round(n).toLocaleString("en-US");
}

/**
 * "12 步 · 读取 85 万 token（缓存命中 96%） · $0.21 · 3 分 4 秒" from a run's tool steps and usage. The
 * tokens are what all of the run's requests read, the cache included: each step carries the whole
 * context, so this is what a long run in a big session reads. A cache hit is billed at a tenth of a fresh
 * read, so the hit share says how much of that is cheap (VS Code shows neither, which made a memento run
 * look many times dearer than the same work there).
 */
export function taskRunSummary(events: readonly TaskEvent[]): string {
  const steps = events.filter((e) => e.kind === "tool").length;
  const usage = [...events].reverse().find((e) => e.kind === "usage");
  const parts = [`${steps} 步`];
  if (usage?.kind === "usage") {
    const read = usage.input_tokens;
    if (typeof read === "number" && read > 0) {
      const cached = usage.cache_read_tokens;
      // Rounded down: a run that missed the cache at all doesn't read as 100%
      const hit = typeof cached === "number" && cached > 0 ? Math.floor((Math.min(cached, read) / read) * 100) : 0;
      parts.push(hit > 0 ? `读取 ${formatTokenCount(read)} token（缓存命中 ${hit}%）` : `读取 ${formatTokenCount(read)} token`);
    }
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
