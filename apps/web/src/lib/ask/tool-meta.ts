export type ToolIconName =
  | "brain"
  | "search"
  | "clock"
  | "file_text"
  | "message"
  | "layers"
  | "book"
  | "grid"
  | "share"
  | "sparkles"
  | "edit"
  | "calendar"
  | "lock"
  | "zap"
  | "alert"
  | "plus"
  | "check"
  | "link"
  | "devices"
  | "terminal"
  | "target";

export interface OrchestratorToolMeta {
  labelZh: string;
  labelEn: string;
  icon: ToolIconName;
  color: string;
  category: "memory" | "web" | "plan" | "device";
}

export const TOOL_META_MAP: Record<string, OrchestratorToolMeta> = {
  mind_resonance: { labelZh: "心领神会", labelEn: "Mind Resonance", icon: "sparkles", color: "#8B5CF6", category: "memory" },
  search_memory: { labelZh: "检索记忆", labelEn: "Search Memory", icon: "search", color: "#3B82F6", category: "memory" },
  memory_recall: { labelZh: "召回近期记忆", labelEn: "Recall Memory", icon: "clock", color: "#0EA5E9", category: "memory" },
  memory_open: { labelZh: "读取完整文档", labelEn: "Open Document", icon: "file_text", color: "#2563EB", category: "memory" },
  memory_conversation: { labelZh: "读取历史对话", labelEn: "Read Conversation", icon: "message", color: "#6366F1", category: "memory" },
  memory_context: { labelZh: "项目上下文", labelEn: "Project Context", icon: "layers", color: "#0891B2", category: "memory" },
  memory_blueprint: { labelZh: "读取蓝图", labelEn: "Read Blueprint", icon: "book", color: "#0D9488", category: "memory" },
  memory_project_map: { labelZh: "项目全景图", labelEn: "Project Map", icon: "grid", color: "#14B8A6", category: "memory" },
  memory_graph: { labelZh: "知识图谱", labelEn: "Knowledge Graph", icon: "share", color: "#7C3AED", category: "memory" },
  memory_core: { labelZh: "核心记忆", labelEn: "Core Memory", icon: "brain", color: "#6D28D9", category: "memory" },
  memory_store: { labelZh: "写入长期记忆", labelEn: "Store Memory", icon: "edit", color: "#059669", category: "memory" },
  daily_summary: { labelZh: "日报摘要", labelEn: "Daily Summary", icon: "calendar", color: "#D97706", category: "memory" },
  check_rules: { labelZh: "检查铁律与避坑", labelEn: "Check Rules", icon: "lock", color: "#DC2626", category: "memory" },
  use_skill: { labelZh: "调用技能", labelEn: "Use Skill", icon: "zap", color: "#EA580C", category: "memory" },
  remember_pitfall: { labelZh: "记录避坑", labelEn: "Save Pitfall", icon: "alert", color: "#B45309", category: "memory" },
  add_todo: { labelZh: "新增待办", labelEn: "Add Todo", icon: "plus", color: "#16A34A", category: "memory" },
  list_todos: { labelZh: "查询待办", labelEn: "List Todos", icon: "check", color: "#15803D", category: "memory" },
  todo_update: { labelZh: "更新待办", labelEn: "Update Todo", icon: "check", color: "#059669", category: "memory" },
  fetch_url: { labelZh: "读取网页", labelEn: "Fetch URL", icon: "link", color: "#0284C7", category: "web" },
  plan_and_run: { labelZh: "创建协作任务", labelEn: "Create Plan", icon: "target", color: "#7C3AED", category: "plan" },
  plan_status: { labelZh: "查询协作进度", labelEn: "Plan Status", icon: "layers", color: "#6366F1", category: "plan" },
  list_devices: { labelZh: "设备发现", labelEn: "Discover Devices", icon: "devices", color: "#0EA5E9", category: "device" },
  run_on_device: { labelZh: "设备执行", labelEn: "Run on Device", icon: "terminal", color: "#38BDF8", category: "device" },
};

export function getToolMeta(name: string, isZh = true): OrchestratorToolMeta & { label: string } {
  const entry = TOOL_META_MAP[name];
  if (entry) {
    return { ...entry, label: isZh ? entry.labelZh : entry.labelEn };
  }
  return {
    labelZh: name || "工具",
    labelEn: name || "Tool",
    label: name || (isZh ? "工具" : "Tool"),
    icon: "sparkles",
    color: "var(--aurora-accent)",
    category: "memory",
  };
}

export function isNonDeviceTool(name: string): boolean {
  const entry = TOOL_META_MAP[name];
  return Boolean(entry && entry.category !== "device");
}

export function isMemoryOrWebTool(name: string): boolean {
  const entry = TOOL_META_MAP[name];
  return Boolean(entry && (entry.category === "memory" || entry.category === "web"));
}

export function isPlanTool(name: string): boolean {
  return name === "plan_and_run" || name === "plan_status";
}

export function formatToolArgsSummary(name: string, args?: Record<string, unknown> | null): string {
  if (!args || typeof args !== "object") return "";
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const val = args[k];
      if (typeof val === "string" && val.trim()) return val.replace(/\s+/g, " ").trim();
      if (typeof val === "number") return String(val);
    }
    return "";
  };
  if (name === "memory_blueprint") {
    const p = pick("project_name");
    const sec = pick("section");
    return sec && sec !== "summary" ? `${p} · ${sec}` : p;
  }
  if (name === "memory_recall") {
    const parts = [pick("date"), pick("category"), pick("project")].filter(Boolean);
    return parts.join(" · ");
  }
  if (name === "memory_store") {
    const ent = pick("entity_name");
    const body = pick("content");
    return ent ? `${ent}: ${body}` : body;
  }
  if (name === "todo_update") {
    return [pick("todo_id").slice(0, 8), pick("status"), pick("title")].filter(Boolean).join(" → ");
  }
  if (name === "check_rules") {
    return [pick("action"), pick("project"), pick("detail")].filter(Boolean).join(" · ");
  }
  return pick(
    "query",
    "project_name",
    "entity_name",
    "doc_id",
    "url",
    "date_str",
    "name",
    "title",
    "goal",
    "plan_id",
    "category",
    "project",
    "command",
    "prompt",
  );
}

export function formatToolResultMarkdown(name: string, result?: Record<string, unknown> | null): string {
  if (!result || typeof result !== "object") return "";
  if (typeof result.markdown === "string" && result.markdown.trim()) {
    return result.markdown.trim();
  }
  if (typeof result.guidance === "string" && result.guidance.trim()) {
    return result.guidance.trim();
  }
  if (typeof result.skill === "string" && result.skill.trim()) {
    return result.skill.trim();
  }
  if (typeof result.resonance === "string" && result.resonance.trim()) {
    return result.resonance.trim();
  }
  if (typeof result.content === "string" && result.content.trim()) {
    return result.content.trim();
  }
  if (Array.isArray(result.results)) {
    const items = result.results as Array<Record<string, unknown>>;
    if (items.length === 0) return "未检索到匹配的记忆记录。";
    return items
      .map((it, idx) => {
        const title = String(it.title || it.path || "未命名");
        const tool = it.tool ? `[${it.tool}] ` : "";
        const excerpt = String(it.excerpt || "").replace(/\s+/g, " ").slice(0, 220);
        return `${idx + 1}. ${tool}${title}\n   ${excerpt}`;
      })
      .join("\n\n");
  }
  if (Array.isArray(result.todos)) {
    const todos = result.todos as Array<Record<string, unknown>>;
    if (todos.length === 0) return "当前没有未完成的待办事项。";
    return todos
      .map((td) => `- [${String(td.id || "").slice(0, 8)}] ${String(td.title || "")}${td.due ? ` (截止 ${td.due})` : ""}`)
      .join("\n");
  }
  if (result.todo && typeof result.todo === "object") {
    const td = result.todo as Record<string, unknown>;
    return `待办：${String(td.title || "")}（状态：${String(td.status || "open")}）`;
  }
  if (name === "plan_and_run" && result.plan_id) {
    return `已创建协作任务（ID: \`${String(result.plan_id).slice(0, 8)}\`，状态：${String(result.status || "planning")}），可前往 [协作任务](${String(result.url || `/plans/${result.plan_id}`)}) 查看进度。`;
  }
  if (typeof result.saved === "boolean") {
    return result.saved ? "已保存。" : String(result.note || "未保存。");
  }
  return "";
}
