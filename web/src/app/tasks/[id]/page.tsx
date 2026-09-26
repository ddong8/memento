"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, DeviceTask, getApiBase, invalidateApiCache } from "@/lib/api-client";
import { Icon } from "@/components/aurora/Icon";
import { Btn, Chip, Glass, TopBar } from "@/components/aurora/primitives";

// Where a phone push (Bark) lands: what the task is, what risky things it did,
// how it ended, and a way to stop it.

const TERMINAL = new Set(["succeeded", "failed", "timeout", "cancelled"]);
const POLL_MS = 4000;
const OUTPUT_TAIL = 4000;

const STATUS: Record<string, { text: string; tone: "neutral" | "accent" | "success" | "warn" | "danger" }> = {
  queued: { text: "排队中", tone: "neutral" },
  running: { text: "运行中", tone: "accent" },
  succeeded: { text: "已完成", tone: "success" },
  failed: { text: "失败", tone: "danger" },
  timeout: { text: "超时", tone: "danger" },
  cancelled: { text: "已停止", tone: "warn" },
};

function formatTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}

export default function TaskPage() {
  const params = useParams();
  const router = useRouter();
  const taskId = params.id as string;
  const [task, setTask] = useState<DeviceTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  const load = useCallback(async () => {
    invalidateApiCache(`${getApiBase()}/api/tasks/${taskId}`);
    try {
      setTask(await api.getDeviceTask(taskId));
      setError(null);
    } catch (e) {
      setError((e as Error).message.includes("404") ? "任务不存在，或不属于当前账号" : (e as Error).message);
    }
  }, [taskId]);

  useEffect(() => {
    // Opened from a push on a phone that isn't signed in yet: come back here after login.
    let token: string | null = null;
    try {
      token = localStorage.getItem("dr_token");
    } catch {}
    if (!token) {
      router.replace(`/auth/login?next=${encodeURIComponent(`/tasks/${taskId}`)}`);
      return;
    }
    load();
  }, [load, router, taskId]);

  useEffect(() => {
    if (!task || TERMINAL.has(task.status)) return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [task, load]);

  const stop = async () => {
    setStopping(true);
    try {
      await api.cancelDeviceTask(taskId);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStopping(false);
    }
  };

  const payload = (task?.payload || {}) as Record<string, unknown>;
  const what = String(payload.prompt || payload.command || "");
  const agent = String(payload.binary || (task?.action === "shell" ? "shell" : "agent"));
  const status = task ? STATUS[task.status] || { text: task.status, tone: "neutral" as const } : null;
  const output = [task?.stdout, task?.stderr, task?.error].filter(Boolean).join("\n").trim();
  const alerts = task?.alerts || [];

  return (
    <div className="w-full max-w-3xl mx-auto pb-16 min-w-0">
      <TopBar
        title="任务详情"
        subtitle={task ? `${agent} · 创建于 ${formatTime(task.created_at)}` : undefined}
        right={
          task && !TERMINAL.has(task.status) ? (
            <Btn variant="danger" size="sm" icon="close" onClick={stop} disabled={stopping}>
              {stopping ? "正在停止…" : "停止任务"}
            </Btn>
          ) : undefined
        }
      />

      {error && (
        <Glass padding={14} radius={14} style={{ marginBottom: 14, color: "#DC2626", fontSize: 13 }}>{error}</Glass>
      )}
      {!task && !error && <div style={{ color: "var(--aurora-fg4)", textAlign: "center", marginTop: 60 }}>加载中…</div>}

      {task && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Glass padding="clamp(14px, 3vw, 20px)" radius={16}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
              {status && <Chip tone={status.tone}>{status.text}</Chip>}
              {task.exit_code != null && <Chip>退出码 {task.exit_code}</Chip>}
              {task.finished_at && (
                <span style={{ fontSize: 12, color: "var(--aurora-fg4)" }}>结束于 {formatTime(task.finished_at)}</span>
              )}
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--aurora-fg1)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {what || "（无描述）"}
            </div>
          </Glass>

          {alerts.length > 0 && (
            <Glass padding="clamp(14px, 3vw, 20px)" radius={16} style={{ border: "1px solid rgba(245,158,11,0.45)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, color: "#D97706", marginBottom: 8, fontSize: 14 }}>
                <Icon name="lock" size={14} /> 危险操作（{alerts.length}）
              </div>
              {alerts.map((a, i) => (
                <div key={i} style={{ padding: "6px 0", borderTop: i ? "1px solid var(--aurora-border)" : "none", fontSize: 13 }}>
                  <div style={{ fontWeight: 600, color: "var(--aurora-fg1)" }}>
                    {a.label}
                    {a.at && <span style={{ fontWeight: 400, color: "var(--aurora-fg4)", marginLeft: 8, fontSize: 12 }}>{formatTime(a.at)}</span>}
                  </div>
                  <code style={{ display: "block", marginTop: 2, color: "var(--aurora-fg2)", fontSize: 12, wordBreak: "break-all" }}>
                    {a.detail}
                  </code>
                </div>
              ))}
            </Glass>
          )}

          <Glass padding="clamp(14px, 3vw, 20px)" radius={16}>
            <div style={{ fontWeight: 600, color: "var(--aurora-fg2)", marginBottom: 8, fontSize: 13 }}>
              输出{output.length > OUTPUT_TAIL ? "（最后部分）" : ""}
            </div>
            <div style={{ overflowX: "auto" }}>
              <pre style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--aurora-fg2)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {output ? output.slice(-OUTPUT_TAIL) : TERMINAL.has(task.status) ? "（没有输出）" : "运行中，输出在任务结束后显示…"}
              </pre>
            </div>
          </Glass>
        </div>
      )}
    </div>
  );
}
