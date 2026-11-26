"use client";

// 工作待办 → 定时任务: an agent (or a shell command) run on one of the user's devices every hour / day / week.
// Each result goes into memory and to the phone (server: services/scheduled_tasks.py).
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/aurora/Icon";
import { Glass } from "@/components/aurora/primitives";
import { api, authFetch, getApiBase, type DeviceSummary } from "@/lib/api-client";
import { showInAppToast } from "@/lib/native-notify";

export interface ScheduledTask {
  id: string;
  title: string;
  device: string;
  agent: string;
  prompt: string;
  cwd: string | null;
  permission_mode: string;
  schedule: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
}

const AGENTS = [
  ["claude", "Claude Code"], ["codex", "Codex"], ["antigravity", "Antigravity"], ["workbuddy", "WorkBuddy"],
  ["opencode", "OpenCode"], ["gemini", "Gemini CLI"], ["cursor", "Cursor"], ["kiro", "Kiro"], ["copilot", "Copilot CLI"], ["shell", "Shell 命令"],
] as const;
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** "daily:09:00" -> "每天 09:00" */
export function describeSchedule(s: string): string {
  const pad = (n: string) => n.padStart(2, "0");
  let m = /^hourly:(\d+)$/.exec(s);
  if (m) return `每小时第 ${m[1]} 分`;
  m = /^daily:(\d+):(\d+)$/.exec(s);
  if (m) return `每天 ${pad(m[1]!)}:${pad(m[2]!)}`;
  m = /^weekly:(\d):(\d+):(\d+)$/.exec(s);
  if (m) return `每${WEEKDAYS[Number(m[1])]} ${pad(m[2]!)}:${pad(m[3]!)}`;
  return s;
}

/** The form's choice back to the server's schedule string. */
export function buildSchedule(kind: "hourly" | "daily" | "weekly", time: string, weekday: number): string {
  const [hh = "9", mm = "0"] = time.split(":");
  if (kind === "hourly") return `hourly:${Number(mm)}`;
  if (kind === "daily") return `daily:${Number(hh)}:${Number(mm)}`;
  return `weekly:${weekday}:${Number(hh)}:${Number(mm)}`;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(`${getApiBase()}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { detail?: string }).detail || res.statusText);
  return data as T;
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

export default function ScheduledTasksPanel() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: "", device: "", agent: "claude", prompt: "", cwd: "", kind: "daily" as "hourly" | "daily" | "weekly", time: "09:00", weekday: 0 });

  const load = useCallback(async () => {
    try {
      setTasks((await call<{ tasks: ScheduledTask[] }>("/api/scheduled-tasks")).tasks);
    } catch {
      setTasks([]);
    }
  }, []);

  useEffect(() => {
    void load();
    void api.getDevices().then((d: DeviceSummary[]) => setDevices((Array.isArray(d) ? d : []).filter((x) => !(x as { is_archived?: boolean }).is_archived)));
  }, [load]);

  const save = async () => {
    if (!form.title.trim() || !form.prompt.trim() || !form.device) {
      showInAppToast("还差一点", "名称、设备和要做的事都要填");
      return;
    }
    try {
      await call("/api/scheduled-tasks", {
        method: "POST",
        body: JSON.stringify({
          title: form.title, device: form.device, agent: form.agent, prompt: form.prompt, cwd: form.cwd || null,
          schedule: buildSchedule(form.kind, form.time, form.weekday), tz_offset_min: -new Date().getTimezoneOffset(),
        }),
      });
      setAdding(false);
      setForm((f) => ({ ...f, title: "", prompt: "" }));
      void load();
    } catch (e) {
      showInAppToast("没建成", (e as Error).message);
    }
  };

  const act = async (t: ScheduledTask, what: "toggle" | "run" | "delete") => {
    try {
      if (what === "toggle") await call(`/api/scheduled-tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !t.enabled }) });
      else if (what === "run") {
        await call(`/api/scheduled-tasks/${t.id}/run`, { method: "POST" });
        showInAppToast("已开始运行", `${t.title}，跑完会推送并记进记忆`);
      } else await call(`/api/scheduled-tasks/${t.id}`, { method: "DELETE" });
      void load();
    } catch (e) {
      showInAppToast("操作失败", (e as Error).message);
    }
  };

  const input = "w-full rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-mute)] px-3 py-2 text-[13px] text-[var(--aurora-fg1)] outline-none focus:border-[var(--aurora-accent)]";

  return (
    <div className="pt-2" data-testid="scheduled-tasks">
      <div className="flex items-end justify-between gap-3 mb-3">
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--aurora-fg1)", marginBottom: 4 }}>定时任务</h3>
          <p style={{ fontSize: 13, color: "var(--aurora-fg3)" }}>让智能体按时在你的设备上做事，结果记进记忆并推送到手机。</p>
        </div>
        <button type="button" onClick={() => setAdding((v) => !v)} className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12.5px] font-medium text-[var(--aurora-accent)] border border-[var(--aurora-accent)]/40 bg-[var(--aurora-accent-soft)] cursor-pointer">
          <Icon name={adding ? "close" : "plus"} size={13} />
          {adding ? "取消" : "新建"}
        </button>
      </div>

      <Glass padding={6} radius={20}>
        {adding && (
          <div className="flex flex-col gap-2.5 p-3 border-b border-[var(--aurora-border)]">
            <input className={input} placeholder="名称，如「每日依赖检查」" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <textarea className={input} rows={3} placeholder="要做的事，如「检查依赖有没有安全更新，有就列出来」" value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <select className={input} value={form.device} onChange={(e) => setForm({ ...form, device: e.target.value })}>
                <option value="">选择设备</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.name}>{d.name.replace(/\.local\b/, "")}</option>
                ))}
              </select>
              <select className={input} value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value })}>
                {AGENTS.map(([id, label]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
              <input className={input} placeholder="项目目录（可选）" value={form.cwd} onChange={(e) => setForm({ ...form, cwd: e.target.value })} />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <select className={`${input} !w-auto`} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as "hourly" | "daily" | "weekly" })}>
                <option value="hourly">每小时</option>
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
              </select>
              {form.kind === "weekly" && (
                <select className={`${input} !w-auto`} value={form.weekday} onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}>
                  {WEEKDAYS.map((w, i) => (
                    <option key={w} value={i}>{w}</option>
                  ))}
                </select>
              )}
              <input type="time" className={`${input} !w-auto`} value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
              <button type="button" onClick={() => void save()} className="ml-auto px-4 py-2 rounded-xl text-[13px] font-semibold text-white bg-[var(--aurora-accent)] cursor-pointer">
                保存
              </button>
            </div>
          </div>
        )}
        {tasks.length === 0 && !adding && (
          <div style={{ textAlign: "center", color: "var(--aurora-fg4)", fontSize: 13, padding: 28 }}>还没有定时任务</div>
        )}
        {tasks.map((t, i) => (
          <div key={t.id} className="flex items-start gap-3 px-4 py-3 flex-wrap" style={{ borderTop: i === 0 && !adding ? "none" : "1px solid var(--aurora-border)", opacity: t.enabled ? 1 : 0.6 }}>
            <div className="flex-1 min-w-[200px]">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[14px] font-medium text-[var(--aurora-fg1)]">{t.title}</span>
                <span className="text-[11.5px] px-1.5 py-0.5 rounded-md bg-[var(--aurora-chip)] text-[var(--aurora-fg2)]">{describeSchedule(t.schedule)}</span>
                <span className="text-[11.5px] text-[var(--aurora-fg3)]">{AGENTS.find(([id]) => id === t.agent)?.[1] ?? t.agent} · {t.device.replace(/\.local\b/, "")}</span>
              </div>
              <div className="text-[12.5px] text-[var(--aurora-fg2)] mt-1 line-clamp-2 break-words">{t.prompt}</div>
              <div className="text-[11.5px] text-[var(--aurora-fg3)] mt-1">
                {t.enabled ? `下次 ${fmt(t.next_run_at)}` : "已暂停"}
                {t.last_run_at ? ` · 上次 ${fmt(t.last_run_at)}${t.last_status ? `（${t.last_status === "succeeded" ? "成功" : t.last_status === "running" ? "运行中" : "失败"}）` : ""}` : ""}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button type="button" onClick={() => void act(t, "run")} className="px-2 py-1 rounded-md text-[12px] text-[var(--aurora-fg2)] hover:text-[var(--aurora-accent)] cursor-pointer">立即运行</button>
              <button type="button" onClick={() => void act(t, "toggle")} className="px-2 py-1 rounded-md text-[12px] text-[var(--aurora-fg2)] hover:text-[var(--aurora-accent)] cursor-pointer">{t.enabled ? "暂停" : "启用"}</button>
              <button type="button" onClick={() => void act(t, "delete")} className="px-2 py-1 rounded-md text-[12px] text-[var(--aurora-fg3)] hover:text-[#EF4444] cursor-pointer" aria-label="删除">
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
        ))}
      </Glass>
    </div>
  );
}
