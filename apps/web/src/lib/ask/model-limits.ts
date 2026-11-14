import type { AgentQuotasResponse, LimitedModelInfo } from "@/lib/api-client";

/**
 * Models the device reported out of quota (守护进程 model-limits.ts): the picker marks them, the task
 * still runs, the device moves on to another model by itself. Families as the device counts them.
 */
const TOOL_KEY: Record<string, "antigravity" | "claude_code" | "codex"> = { antigravity: "antigravity", claude: "claude_code", codex: "codex" };
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function modelFamily(mode: string, id: string): string {
  const m = id.trim().toLowerCase();
  if (mode === "claude") return ["fable", "opus", "sonnet", "haiku"].find((f) => m.includes(f)) ?? m;
  if (mode === "antigravity") {
    const parts = m.split("-");
    return parts.length > 1 && EFFORTS.includes(parts.at(-1)!) ? parts.slice(0, -1).join("-") : m;
  }
  return m;
}

/** The limit covering model `id` ("" for the agent's default), when it's still out. */
export function modelLimitOf(quotas: AgentQuotasResponse | null | undefined, mode: string, id: string, now = Date.now()): LimitedModelInfo | undefined {
  const key = TOOL_KEY[mode];
  const tool = key ? quotas?.tools?.[key] : undefined;
  const model = id || tool?.default_model || "";
  if (!tool?.limited_models?.length || !model) return undefined;
  const family = modelFamily(mode, model);
  return tool.limited_models.find((l) => l.family === family && Date.parse(l.until) > now);
}

/** "额度用完·约 3 小时后恢复" for the picker; "账号不支持" for a model the account can't use (Codex's "not supported"). */
export function modelLimitLabel(limit: LimitedModelInfo, isZh: boolean, now = Date.now()): string {
  if (/model is not supported/i.test(limit.message ?? "")) return isZh ? "账号不支持" : "not on this account";
  const mins = Math.max(1, Math.ceil((Date.parse(limit.until) - now) / 60_000));
  const span = mins < 60 ? (isZh ? `${mins} 分钟` : `${mins}m`) : mins < 48 * 60 ? (isZh ? `${Math.round(mins / 60)} 小时` : `${Math.round(mins / 60)}h`) : isZh ? `${Math.round(mins / 1440)} 天` : `${Math.round(mins / 1440)}d`;
  return isZh ? `额度用完·约 ${span}后恢复` : `out of quota · ~${span}`;
}

const QUOTA_TOOL_KEY: Record<string, "antigravity" | "claude_code" | "codex" | "workbuddy"> = { ...TOOL_KEY, workbuddy: "workbuddy" };

export interface ModelQuota {
  /** Remaining percent for this model, null when the tool doesn't say. */
  percent: number | null;
  /** The model it's about ("" when the tool's own figure stands for it). */
  modelId: string;
  label: string;
  resetTime?: string | null;
  statusText?: string;
  /** True when the figure is this model's own; false when it's the tool's (shared quota, or the model wasn't listed). */
  perModel: boolean;
}

/**
 * Quota left for the model a conversation runs (`id`, "" for the agent's default). Antigravity counts each
 * model on its own (Gemini 4 Argon resets weekly, Hydrogen/Flash/Claude every few hours), so the tool's
 * figure, which is the default model's, says nothing about a conversation on another model. Claude Code
 * and Codex share one quota across models: their figure is the tool's.
 */
export function modelQuotaOf(quotas: AgentQuotasResponse | null | undefined, mode: string, id: string, now = Date.now()): ModelQuota | undefined {
  const key = QUOTA_TOOL_KEY[mode];
  const tool = key ? quotas?.tools?.[key] : undefined;
  if (!tool) return undefined;
  const want = (id || tool.default_model || "").trim().toLowerCase();
  const models = tool.models ?? [];
  const exact = want ? models.find((m) => m.model_id?.toLowerCase() === want) : undefined;
  const family = want ? modelFamily(mode, want) : "";
  const kin = exact ?? (mode === "antigravity" && family ? models.find((m) => m.model_id && modelFamily(mode, m.model_id) === family && m.remaining_percent != null) : undefined);
  const limit = want ? modelLimitOf(quotas, mode, want, now) : undefined;
  if (kin && kin.remaining_percent != null) {
    return { percent: limit ? 0 : kin.remaining_percent, modelId: kin.model_id, label: exact?.label || kin.label || kin.model_id, resetTime: limit?.until ?? kin.reset_time, statusText: limit ? "额度用完" : kin.status_text, perModel: true };
  }
  if (limit) return { percent: 0, modelId: want, label: exact?.label || want, resetTime: limit.until, statusText: "额度用完", perModel: true };
  return { percent: tool.remaining_percent ?? null, modelId: "", label: exact?.label || tool.name, resetTime: tool.reset_time, statusText: undefined, perModel: false };
}
