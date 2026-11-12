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
  // A snapshot of what's still running in the background: the latest one replaces the last
  if (event.kind === "background") return [...events.filter((e) => e.kind !== "background"), event];
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

/** What kind of step a tool call is, whichever agent made it (Claude Code, Codex, Antigravity, WorkBuddy). */
export type TaskToolKind = "command" | "read" | "edit" | "write" | "list" | "search" | "web" | "agent" | "todo" | "task" | "question" | "mcp" | "other";

const TOOL_KINDS: Record<string, TaskToolKind> = {
  Bash: "command", BashOutput: "command", Shell: "command", run_command: "command", command_status: "command",
  Read: "read", read_file: "read", view_file: "read", view_file_outline: "read", view_code_item: "read", NotebookRead: "read",
  Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit", edit_file: "edit", replace_file_content: "edit", multi_replace_file_content: "edit",
  Write: "write", write_file: "write", write_to_file: "write",
  LS: "list", list_dir: "list",
  Grep: "search", Glob: "search", grep_search: "search", find_by_name: "search", codebase_search: "search", ToolSearch: "search",
  WebSearch: "web", WebFetch: "web", search_web: "web", read_url_content: "web", view_content_chunk: "web",
  Task: "agent", Agent: "agent", invoke_subagent: "agent", manage_subagents: "agent", send_message: "agent",
  TodoWrite: "todo",
  TaskOutput: "task", TaskStop: "task", KillShell: "task", manage_task: "task", schedule: "task", Monitor: "task",
  AskUserQuestion: "question", ask_question: "question",
};

/** "Bash: `ls`" -> "Bash": a badge's tool name with its detail. */
const toolKey = (name: string) => (name.includes(":") ? (name.split(":")[0] ?? "").trim() : name);
/** A table entry, never one Object.prototype has ("constructor"). */
const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);

export function taskToolKind(name: string | undefined): TaskToolKind {
  if (!name) return "other";
  const clean = toolKey(name);
  return own(TOOL_KINDS, clean) ?? (clean.startsWith("mcp__") ? "mcp" : "other");
}

const TOOL_LABELS: Record<string, string> = {
  Bash: "运行命令", BashOutput: "运行命令", Shell: "运行命令", run_command: "运行命令", command_status: "命令进度",
  Read: "读取", read_file: "读取", view_file: "读取", view_file_outline: "查看大纲", view_code_item: "读取", NotebookRead: "读取",
  Write: "新建文件", write_file: "写入文件", write_to_file: "写入文件",
  Edit: "修改", MultiEdit: "修改", NotebookEdit: "修改", edit_file: "修改", replace_file_content: "修改", multi_replace_file_content: "修改",
  LS: "查看目录", list_dir: "查看目录",
  Grep: "查找", Glob: "查找", grep_search: "查找", find_by_name: "查找", codebase_search: "查找",
  WebSearch: "搜索网页", search_web: "搜索网页", WebFetch: "打开网页", read_url_content: "打开网页", view_content_chunk: "打开网页",
  Task: "派子任务", Agent: "派子任务", invoke_subagent: "派子任务", manage_subagents: "管理子任务", send_message: "发消息",
  TaskOutput: "任务输出", TaskStop: "停止后台任务", KillShell: "停止后台任务", manage_task: "管理后台任务", schedule: "定时",
  Monitor: "监视", TodoWrite: "更新待办", ToolSearch: "加载工具", Skill: "使用技能",
  AskUserQuestion: "提问", ask_question: "提问",
};

/** What a tool call does, in the user's words; "memento-memory · memory_search" for an MCP tool. */
export function taskToolLabel(name: string | undefined): string {
  if (!name) return "工具";
  const clean = toolKey(name);
  const label = own(TOOL_LABELS, clean);
  if (label) return label;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(clean);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : clean;
}

/** What happened to a follow-up the user sent to a running task. */
export function steerNote(status: string | undefined): string {
  switch (status) {
    case "late":
      return "没赶上这一轮，这轮结束后自动接着发";
    case "unsupported":
      return "这个智能体运行中读不了补充，这轮结束后自动接着发";
    default:
      return "已送达，会在下一步读到";
  }
}
