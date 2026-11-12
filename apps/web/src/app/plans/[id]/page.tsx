"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api, AgentPlan, PlanExcludedModel, PlanStep } from "@/lib/api-client";
import { Icon } from "@/components/aurora/Icon";
import { Btn, Chip, Glass, TopBar } from "@/components/aurora/primitives";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";
import { AGENTS, agentName, duration, OPEN_PLAN, PLAN_STATUS, planProgress, planStages, STEP_STATUS, workspaceNote } from "@/lib/plans/display";

// One collaborative task: its sub-tasks stage by stage (each stage waits on the ones above), who does
// each one where, what came back, and the summary at the end. Also where a phone push lands.

const POLL_MS = 3000;

function StepCard({
  step,
  editing,
  onEdit,
  onStop,
  onRetry,
  busy,
}: {
  step: PlanStep;
  editing: boolean;
  onEdit: (patch: Partial<PlanStep>) => void;
  onStop: () => void;
  onRetry: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const st = STEP_STATUS[step.status] || { text: step.status, tone: "neutral" as const };
  const agent = AGENTS.find((a) => a.id === step.agent);
  const ws = workspaceNote(step.workspace);
  const took = duration(step.started_at, step.finished_at);
  const field = {
    width: "100%",
    background: "var(--aurora-chip)",
    border: "1px solid var(--aurora-border)",
    borderRadius: 8,
    padding: "6px 8px",
    color: "var(--aurora-fg1)",
    fontSize: 12.5,
    outline: "none",
  } as const;

  return (
    <Glass
      padding="12px 14px"
      radius={14}
      style={{
        flex: "1 1 260px",
        minWidth: 0,
        border: step.status === "running" ? "1px solid var(--aurora-accent)" : step.status === "failed" ? "1px solid rgba(239,68,68,0.4)" : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <Icon name={step.kind === "review" ? "check" : agent?.icon || "sparkles"} size={14} style={{ color: "var(--aurora-accent)", flexShrink: 0 }} />
        {editing ? (
          <input value={step.title} onChange={(e) => onEdit({ title: e.target.value })} style={{ ...field, fontWeight: 600 }} />
        ) : (
          <div className="truncate" style={{ fontWeight: 600, fontSize: 13.5, color: "var(--aurora-fg1)", flex: 1, minWidth: 0 }}>
            {step.title}
          </div>
        )}
        <Chip tone={st.tone}>{st.text}</Chip>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, fontSize: 11.5, color: "var(--aurora-fg3)" }}>
        {editing && step.kind !== "review" ? (
          <select value={step.agent} onChange={(e) => onEdit({ agent: e.target.value, model: "" })} style={{ ...field, width: "auto" }}>
            <option value="">自动分配智能体</option>
            {AGENTS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        ) : (
          <span>{agentName(step.agent)}</span>
        )}
        {step.device_name && <span>· {step.device_name}</span>}
        {step.model && <span>· {step.model}</span>}
        {step.attempts > 1 && <span>· 第 {step.attempts} 次尝试</span>}
        {took && <span>· {took}</span>}
      </div>

      {editing && step.kind !== "review" && (
        <>
          <textarea value={step.prompt} onChange={(e) => onEdit({ prompt: e.target.value })} rows={4} style={{ ...field, marginTop: 8, lineHeight: 1.5, resize: "vertical" }} />
          <input value={step.acceptance} onChange={(e) => onEdit({ acceptance: e.target.value })} placeholder="验收标准" style={{ ...field, marginTop: 6 }} />
        </>
      )}

      {!editing && step.acceptance && (
        <div style={{ fontSize: 12, color: "var(--aurora-fg3)", marginTop: 8, lineHeight: 1.5 }}>验收：{step.acceptance}</div>
      )}
      {ws && (
        <div style={{ fontSize: 12, marginTop: 6, color: step.workspace?.status === "applied" || step.workspace?.status === "unchanged" ? "#10B981" : "#D97706" }}>{ws}</div>
      )}
      {step.error && step.status !== "succeeded" && (
        <div style={{ fontSize: 12, marginTop: 6, color: step.status === "pending" ? "var(--aurora-fg3)" : "#DC2626", lineHeight: 1.5, wordBreak: "break-word" }}>
          {step.error}
        </div>
      )}
      {step.history?.length > 0 && (
        <div style={{ fontSize: 11.5, marginTop: 6, color: "var(--aurora-fg4)", lineHeight: 1.5 }}>
          {step.history.map((h) => (
            <div key={`${h.attempt}-${h.at}`} className="truncate">
              第 {h.attempt} 次 {agentName(h.agent)}
              {h.model ? `（${h.model}）` : ""}
              {h.device_name ? `@${h.device_name}` : ""} 没成功：{h.error_type === "usage_limit" ? "额度用完" : h.status === "timeout" ? "超时没做完" : h.error}
            </div>
          ))}
        </div>
      )}

      {!editing && (
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
          {(step.result || step.prompt) && (
            <Btn variant="ghost" size="sm" icon={open ? "minus" : "plus"} onClick={() => setOpen(!open)}>
              {open ? "收起" : step.result ? "看结果" : "看指令"}
            </Btn>
          )}
          {step.task_id && (
            <Link href={`/tasks/${step.task_id}`} style={{ fontSize: 12, color: "var(--aurora-accent)" }}>
              完整输出
            </Link>
          )}
          <span style={{ flex: 1 }} />
          {(step.status === "running" || step.status === "pending") && (
            <Btn variant="ghost" size="sm" icon="close" onClick={onStop} disabled={busy}>
              停止
            </Btn>
          )}
          {(step.status === "failed" || step.status === "cancelled" || step.status === "skipped") && (
            <Btn variant="glass" size="sm" icon="refresh" onClick={onRetry} disabled={busy}>
              重做
            </Btn>
          )}
        </div>
      )}
      {open && !editing && (
        <div className="prose prose-sm max-w-none" style={{ fontSize: 13, lineHeight: 1.6, marginTop: 8, borderTop: "1px solid var(--aurora-border)", paddingTop: 8 }}>
          <MarkdownViewer content={step.result || step.prompt} />
        </div>
      )}
    </Glass>
  );
}

export default function PlanPage() {
  const params = useParams();
  const router = useRouter();
  const planId = params.id as string;
  const [plan, setPlan] = useState<AgentPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<PlanStep[] | null>(null);

  const load = useCallback(async () => {
    try {
      setPlan(await api.getPlan(planId));
      setError(null);
    } catch (e) {
      setError((e as Error).message.includes("404") ? "协作任务不存在，或不属于当前账号" : (e as Error).message);
    }
  }, [planId]);

  useEffect(() => {
    let token: string | null = null;
    try {
      token = localStorage.getItem("dr_token");
    } catch {}
    if (!token) {
      router.replace(`/auth/login?next=${encodeURIComponent(`/plans/${planId}`)}`);
      return;
    }
    load();
  }, [load, router, planId]);

  const open = !!plan && OPEN_PLAN.has(plan.status);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [open, load]);

  const act = async (fn: () => Promise<AgentPlan>) => {
    setBusy(true);
    try {
      setPlan(await fn());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    if (!draft) return;
    await act(() => api.editPlanSteps(planId, draft.filter((s) => s.kind !== "review")));
    setDraft(null);
  };

  const steps = draft || plan?.steps || [];
  const stages = planStages(steps);
  const st = plan ? PLAN_STATUS[plan.status] || { text: plan.status, tone: "neutral" as const } : null;
  const prog = plan ? planProgress(plan) : null;
  const excluded = (Array.isArray(plan?.options?.excluded_models) ? plan.options.excluded_models : []) as PlanExcludedModel[];

  return (
    <div className="w-full max-w-5xl mx-auto pb-16 min-w-0">
      <TopBar
        title={plan?.title || "协作任务"}
        subtitle={plan ? `${prog?.done}/${prog?.total} 个子任务 · ${duration(plan.started_at, plan.finished_at) || "未开始"}` : undefined}
        right={
          plan ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {plan.status === "ready" && !draft && (
                <>
                  <Btn variant="glass" size="sm" icon="edit" onClick={() => setDraft(JSON.parse(JSON.stringify(plan.steps || [])))}>
                    修改
                  </Btn>
                  <Btn variant="glass" size="sm" icon="refresh" onClick={() => act(() => api.replan(planId))} disabled={busy}>
                    重新规划
                  </Btn>
                  <Btn size="sm" icon="rocket" onClick={() => act(() => api.startPlan(planId))} disabled={busy}>
                    开始执行
                  </Btn>
                </>
              )}
              {draft && (
                <>
                  <Btn variant="ghost" size="sm" onClick={() => setDraft(null)}>
                    取消修改
                  </Btn>
                  <Btn size="sm" icon="check" onClick={saveDraft} disabled={busy}>
                    保存
                  </Btn>
                </>
              )}
              {(plan.status === "failed" || plan.status === "cancelled") && (
                <Btn variant="glass" size="sm" icon="refresh" onClick={() => act(() => api.replan(planId))} disabled={busy}>
                  重新规划
                </Btn>
              )}
              {(open || plan.status === "ready") && (
                <Btn variant="danger" size="sm" icon="close" onClick={() => act(() => api.cancelPlan(planId))} disabled={busy}>
                  全部停止
                </Btn>
              )}
            </div>
          ) : undefined
        }
      />

      {error && (
        <Glass padding={14} radius={14} style={{ marginBottom: 14, color: "#DC2626", fontSize: 13 }}>
          {error}
        </Glass>
      )}
      {!plan && !error && <div style={{ color: "var(--aurora-fg4)", textAlign: "center", marginTop: 60 }}>加载中…</div>}

      {plan && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Glass padding="clamp(14px, 3vw, 20px)" radius={16}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
              {st && <Chip tone={st.tone}>{st.text}</Chip>}
              {plan.cwd && (
                <span style={{ fontSize: 12, color: "var(--aurora-fg4)", fontFamily: "monospace" }} className="truncate">
                  {plan.cwd}
                </span>
              )}
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--aurora-fg1)", whiteSpace: "pre-wrap" }}>{plan.goal}</div>
            {plan.plan_note && <div style={{ fontSize: 12.5, color: "var(--aurora-fg3)", marginTop: 10 }}>拆分思路：{plan.plan_note}</div>}
            {plan.status === "planning" && (
              <div style={{ fontSize: 13, color: "var(--aurora-accent)", marginTop: 12, display: "flex", alignItems: "center", gap: 6 }}>
                <Icon name="activity" size={14} /> 正在根据各设备的智能体、模型、额度和负载拆分任务…
              </div>
            )}
          </Glass>

          {!!plan.roster?.length && plan.status !== "planning" && (
            <Glass padding="clamp(14px, 3vw, 20px)" radius={16}>
              <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--aurora-fg1)", marginBottom: 10 }}>本次安排</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {plan.roster.map((r) => {
                  const agent = AGENTS.find((a) => a.id === r.agent);
                  return (
                    <div
                      key={`${r.device_id}/${r.agent}/${r.model}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "8px 12px",
                        borderRadius: 12,
                        background: "var(--aurora-chip)",
                        border: "1px solid var(--aurora-border)",
                        minWidth: 0,
                      }}
                    >
                      <Icon name={agent?.icon || "sparkles"} size={14} style={{ color: "var(--aurora-accent)", flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: "var(--aurora-fg1)" }} className="truncate">
                          {r.device_name || "待定设备"} · {agentName(r.agent)}
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--aurora-fg4)" }} className="truncate">
                          {r.model || "默认模型"} · {r.steps.length} 个子任务
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {excluded.length > 0 && (
                <div style={{ fontSize: 12, color: "var(--aurora-fg4)", marginTop: 10, lineHeight: 1.7 }}>
                  没有安排的模型：
                  {excluded.map((e, i) => (
                    <span key={`${e.agent}/${e.model}`}>
                      {i > 0 ? "；" : ""}
                      {agentName(e.agent)} {e.model}（{e.reason}，{e.devices.join("、")}）
                    </span>
                  ))}
                </div>
              )}
            </Glass>
          )}

          {(plan.summary || plan.error) && (
            <Glass padding="clamp(14px, 3vw, 20px)" radius={16} style={{ border: `1px solid ${plan.status === "succeeded" ? "rgba(16,185,129,0.35)" : "rgba(245,158,11,0.35)"}` }}>
              <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--aurora-fg1)", marginBottom: 8 }}>最终结果</div>
              {plan.summary && (
                <div className="prose prose-sm max-w-none" style={{ fontSize: 13.5, lineHeight: 1.65 }}>
                  <MarkdownViewer content={plan.summary} />
                </div>
              )}
              {plan.error && <div style={{ fontSize: 12.5, color: "#D97706", marginTop: 8 }}>{plan.error}</div>}
            </Glass>
          )}

          {stages.map((stage, i) => (
            <div key={i}>
              <div style={{ fontSize: 12, color: "var(--aurora-fg4)", margin: "2px 4px 8px", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: 600, color: "var(--aurora-fg3)" }}>第 {i + 1} 批</span>
                {stage.length > 1 ? `${stage.length} 个子任务并行` : ""}
                {i > 0 ? "，等上一批完成后开始" : ""}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                {stage.map((s) => (
                  <StepCard
                    key={s.id}
                    step={s}
                    editing={!!draft}
                    busy={busy}
                    onEdit={(patch) => setDraft((d) => (d ? d.map((x) => (x.id === s.id ? { ...x, ...patch } : x)) : d))}
                    onStop={() => act(() => api.cancelPlanStep(planId, s.id))}
                    onRetry={() => act(() => api.retryPlanStep(planId, s.id))}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
