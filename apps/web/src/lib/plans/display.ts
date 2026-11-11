import type { AgentPlan, PlanStatus, PlanStep, PlanStepStatus } from "@/lib/api-client";

export type Tone = "neutral" | "accent" | "success" | "warn" | "danger";

export const PLAN_STATUS: Record<PlanStatus, { text: string; tone: Tone }> = {
  planning: { text: "规划中", tone: "accent" },
  ready: { text: "待开始", tone: "warn" },
  running: { text: "执行中", tone: "accent" },
  integrating: { text: "汇总中", tone: "accent" },
  succeeded: { text: "已完成", tone: "success" },
  failed: { text: "未全部完成", tone: "danger" },
  cancelled: { text: "已停止", tone: "warn" },
};

export const STEP_STATUS: Record<PlanStepStatus, { text: string; tone: Tone }> = {
  pending: { text: "等待", tone: "neutral" },
  running: { text: "执行中", tone: "accent" },
  succeeded: { text: "完成", tone: "success" },
  failed: { text: "失败", tone: "danger" },
  cancelled: { text: "已停止", tone: "warn" },
  skipped: { text: "已跳过", tone: "neutral" },
};

export const AGENTS: { id: string; name: string; icon: "sparkles" | "code" | "rocket" }[] = [
  { id: "claude", name: "Claude Code", icon: "sparkles" },
  { id: "codex", name: "Codex", icon: "code" },
  { id: "antigravity", name: "Antigravity", icon: "rocket" },
];

export function agentName(id: string | null | undefined): string {
  return AGENTS.find((a) => a.id === id)?.name || (id ? id : "自动分配");
}

export const OPEN_PLAN = new Set<PlanStatus>(["planning", "running", "integrating"]);

/** Steps in the order they can run: each stage only waits on the ones before it. */
export function planStages(steps: PlanStep[]): PlanStep[][] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (s: PlanStep): number => {
    const known = level.get(s.id);
    if (known !== undefined) return known;
    if (visiting.has(s.id)) return 0;
    visiting.add(s.id);
    let d = 0;
    for (const dep of s.depends_on || []) {
      const p = byId.get(dep);
      if (p) d = Math.max(d, depth(p) + 1);
    }
    visiting.delete(s.id);
    level.set(s.id, d);
    return d;
  };
  const stages: PlanStep[][] = [];
  for (const s of steps) {
    const d = depth(s);
    (stages[d] ||= []).push(s);
  }
  return stages.filter(Boolean);
}

/** "3/5 完成" for a plan card. */
export function planProgress(plan: Pick<AgentPlan, "step_counts" | "step_total">): { done: number; total: number; percent: number } {
  const c = plan.step_counts || {};
  const done = (c.succeeded || 0) + (c.failed || 0) + (c.cancelled || 0) + (c.skipped || 0);
  const total = plan.step_total || 0;
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

export function workspaceNote(ws: PlanStep["workspace"]): string {
  if (!ws) return "";
  switch (ws.status) {
    case "applied":
      return `改动已合回源目录（${ws.files || 0} 个文件）`;
    case "conflict":
      return `与源目录冲突，改动放在分支 ${ws.branch || "?"}`;
    case "saved":
      return `改动另存在 ${ws.branch || ws.patch_path || "源设备"}`;
    case "pending":
      return "源设备离线，上线后自动送回改动";
    case "unchanged":
      return "没有改动文件";
    default:
      return `改动没能送回：${ws.error || ws.status}`;
  }
}

export function duration(start: string | null | undefined, end: string | null | undefined, now = Date.now()): string {
  if (!start) return "";
  const ms = (end ? Date.parse(end) : now) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
