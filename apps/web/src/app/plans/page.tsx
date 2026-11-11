"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, AgentPlan, DeviceSummary } from "@/lib/api-client";
import { Icon } from "@/components/aurora/Icon";
import { Btn, Chip, Glass, TopBar } from "@/components/aurora/primitives";
import { OPEN_PLAN, PLAN_STATUS, planProgress } from "@/lib/plans/display";

// Collaborative tasks: a big task split into sub-tasks that several agents on several devices do at once.

const POLL_MS = 5000;

function formatTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}

export default function PlansPage() {
  const router = useRouter();
  const [plans, setPlans] = useState<AgentPlan[] | null>(null);
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [cwd, setCwd] = useState("");
  const [source, setSource] = useState("");
  const [autoStart, setAutoStart] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setPlans(await api.listPlans());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    api.getDevices().then(setDevices).catch(() => {});
  }, [load]);

  const anyOpen = (plans || []).some((p) => OPEN_PLAN.has(p.status));
  useEffect(() => {
    if (!anyOpen) return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [anyOpen, load]);

  const create = async () => {
    if (!goal.trim()) return;
    setCreating(true);
    try {
      const plan = await api.createPlan({
        goal: goal.trim(),
        cwd: cwd.trim() || null,
        source_device_id: cwd.trim() && source ? source : null,
        auto_start: autoStart,
      });
      setGoal("");
      router.push(`/plans/${plan.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const fieldStyle = {
    width: "100%",
    background: "var(--aurora-chip)",
    border: "1px solid var(--aurora-border)",
    borderRadius: 10,
    padding: "8px 10px",
    color: "var(--aurora-fg1)",
    fontSize: 13,
    outline: "none",
  } as const;

  return (
    <div className="w-full max-w-4xl mx-auto pb-16 min-w-0">
      <TopBar title="协作任务" subtitle="大任务自动拆开，按智能体特点和设备额度分派到多台设备并行完成，最后复查汇总" />

      <Glass padding="clamp(14px, 3vw, 20px)" radius={16} style={{ marginBottom: 16 }}>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="描述要完成的大任务，比如：给 memento 加一个导出功能，服务端接口、网页按钮、手机端入口和测试都要做"
          rows={4}
          style={{ ...fieldStyle, resize: "vertical", lineHeight: 1.6, fontSize: 14 }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) create();
          }}
        />
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_200px] gap-2" style={{ marginTop: 10 }}>
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="代码目录（可选），如 /Users/me/dev/memento" style={fieldStyle} />
          <select value={source} onChange={(e) => setSource(e.target.value)} style={fieldStyle} disabled={!cwd.trim()}>
            <option value="">代码所在设备</option>
            {devices.map((d) => (
              <option key={d.id} value={d.device_id}>
                {d.name}
                {d.online === false ? "（离线）" : ""}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--aurora-fg3)", cursor: "pointer" }}>
            <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
            规划好直接开始（不勾选则先给我看计划）
          </label>
          <Btn icon="rocket" onClick={create} disabled={creating || !goal.trim() || (!!cwd.trim() && !source)}>
            {creating ? "正在创建…" : "拆分并执行"}
          </Btn>
        </div>
      </Glass>

      {error && (
        <Glass padding={14} radius={14} style={{ marginBottom: 14, color: "#DC2626", fontSize: 13 }}>
          {error}
        </Glass>
      )}
      {plans === null && !error && <div style={{ color: "var(--aurora-fg4)", textAlign: "center", marginTop: 40 }}>加载中…</div>}
      {plans && plans.length === 0 && (
        <div style={{ color: "var(--aurora-fg4)", textAlign: "center", marginTop: 40, fontSize: 13 }}>
          还没有协作任务。也可以在 AI 执事里直接说「拆开做」。
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {(plans || []).map((p) => {
          const st = PLAN_STATUS[p.status] || { text: p.status, tone: "neutral" as const };
          const prog = planProgress(p);
          return (
            <Link key={p.id} href={`/plans/${p.id}`} style={{ textDecoration: "none" }}>
              <Glass padding="14px 16px" radius={14} hover>
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <Icon name="layers" size={15} style={{ color: "var(--aurora-accent)", flexShrink: 0 }} />
                  <div style={{ fontWeight: 600, color: "var(--aurora-fg1)", fontSize: 14, flex: 1, minWidth: 0 }} className="truncate">
                    {p.title}
                  </div>
                  <Chip tone={st.tone}>{st.text}</Chip>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                  <div style={{ flex: 1, height: 4, borderRadius: 2, background: "var(--aurora-chip)", overflow: "hidden" }}>
                    <div
                      style={{
                        width: `${prog.percent}%`,
                        height: "100%",
                        background: p.status === "failed" ? "#EF4444" : "var(--aurora-accent)",
                        transition: "width 0.4s ease",
                      }}
                    />
                  </div>
                  <span style={{ fontSize: 11.5, color: "var(--aurora-fg4)", whiteSpace: "nowrap" }}>
                    {p.status === "planning" ? "正在拆分" : `${prog.done}/${prog.total} 个子任务`} · {formatTime(p.created_at)}
                  </span>
                </div>
              </Glass>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
