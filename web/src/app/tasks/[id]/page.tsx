"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, DeviceTask, getApiBase, invalidateApiCache } from "@/lib/api-client";
import { Icon } from "@/components/aurora/Icon";
import { Btn, Chip, Glass, TopBar } from "@/components/aurora/primitives";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";

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
  const [viewMode, setViewMode] = useState<"markdown" | "terminal">("markdown");

  const load = useCallback(async () => {
    invalidateApiCache(`${getApiBase()}/api/tasks/${taskId}`);
    try {
      const loaded = await api.getDeviceTask(taskId);
      const convId = String((loaded?.payload as Record<string, unknown> | undefined)?.conversation_id || "").trim();
      if (convId) {
        if (typeof window !== "undefined" && typeof (window as any).__memento_navigate === "function") {
          (window as any).__memento_navigate(`/ask?id=${encodeURIComponent(convId)}&scroll=bottom`);
        } else {
          router.replace(`/ask?id=${encodeURIComponent(convId)}&scroll=bottom`);
        }
        return;
      }
      setTask(loaded);
      setError(null);
    } catch (e) {
      setError((e as Error).message.includes("404") ? "任务不存在，或不属于当前账号" : (e as Error).message);
    }
  }, [taskId, router]);

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
            <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--aurora-fg1)" }}>
              {what ? <MarkdownViewer content={what} /> : "（无描述）"}
            </div>
          </Glass>

          {alerts.length > 0 && (
            <Glass padding="clamp(14px, 3vw, 20px)" radius={16} style={{ border: "1px solid rgba(245,158,11,0.35)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, color: "var(--aurora-fg1)", marginBottom: 10, fontSize: 14 }}>
                <Icon name="lock" size={14} style={{ color: "#F59E0B" }} /> 高危与敏感操作提示（{alerts.length}）
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {alerts.map((a, i) => {
                  const isCritical = a.level === "critical";
                  const isWarn = a.level === "warn";
                  const toneColor = isCritical ? "#EF4444" : isWarn ? "#38BDF8" : "#F59E0B";
                  const bgTone = isCritical ? "rgba(239, 68, 68, 0.08)" : isWarn ? "rgba(56, 189, 248, 0.08)" : "rgba(245, 158, 11, 0.08)";
                  const borderTone = isCritical ? "rgba(239, 68, 68, 0.28)" : isWarn ? "rgba(56, 189, 248, 0.28)" : "rgba(245, 158, 11, 0.28)";
                  const levelTag = isCritical ? "高危阻断" : isWarn ? "关注提示" : "风险操作";
                  return (
                    <div
                      key={i}
                      style={{
                        padding: "8px 12px",
                        borderRadius: 10,
                        background: bgTone,
                        border: `1px solid ${borderTone}`,
                        fontSize: 13,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: toneColor,
                              padding: "1px 6px",
                              borderRadius: 4,
                              background: "rgba(0,0,0,0.12)",
                            }}
                          >
                            {levelTag}
                          </span>
                          <span style={{ fontWeight: 600, color: "var(--aurora-fg1)" }}>{a.label}</span>
                        </div>
                        {a.at && <span style={{ color: "var(--aurora-fg4)", fontSize: 11.5 }}>{formatTime(a.at)}</span>}
                      </div>
                      <code style={{ display: "block", marginTop: 4, color: "var(--aurora-fg2)", fontSize: 11.5, wordBreak: "break-all", fontFamily: "monospace" }}>
                        {a.detail}
                      </code>
                    </div>
                  );
                })}
              </div>
            </Glass>
          )}

          <Glass padding="clamp(14px, 3vw, 20px)" radius={16}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ fontWeight: 600, color: "var(--aurora-fg1)", fontSize: 13 }}>
                任务执行产物与输出{output.length > OUTPUT_TAIL ? "（截取尾部）" : ""}
              </div>
              {output && (
                <div
                  style={{
                    display: "inline-flex",
                    background: "var(--aurora-chip)",
                    border: "1px solid var(--aurora-border)",
                    borderRadius: 8,
                    padding: 2,
                    gap: 2,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setViewMode("markdown")}
                    style={{
                      background: viewMode === "markdown" ? "var(--aurora-accent-soft)" : "transparent",
                      border: "none",
                      color: viewMode === "markdown" ? "var(--aurora-accent)" : "var(--aurora-fg3)",
                      borderRadius: 6,
                      padding: "2px 8px",
                      fontSize: 11,
                      fontWeight: viewMode === "markdown" ? 600 : 400,
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    Markdown
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode("terminal")}
                    style={{
                      background: viewMode === "terminal" ? "var(--aurora-accent-soft)" : "transparent",
                      border: "none",
                      color: viewMode === "terminal" ? "var(--aurora-accent)" : "var(--aurora-fg3)",
                      borderRadius: 6,
                      padding: "2px 8px",
                      fontSize: 11,
                      fontWeight: viewMode === "terminal" ? 600 : 400,
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    Terminal
                  </button>
                </div>
              )}
            </div>
            {output ? (
              viewMode === "markdown" ? (
                <div className="prose prose-sm max-w-none" style={{ fontSize: 13.5, lineHeight: 1.6 }}>
                  <MarkdownViewer content={output.slice(-OUTPUT_TAIL)} />
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <pre style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--aurora-fg2)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {output.slice(-OUTPUT_TAIL)}
                  </pre>
                </div>
              )
            ) : (
              <div style={{ color: "var(--aurora-fg4)", fontSize: 12.5, fontStyle: "italic", padding: "8px 0" }}>
                {TERMINAL.has(task.status) ? "（没有输出内容）" : "任务仍在运行中，输出将在结束后完整呈现…"}
              </div>
            )}
          </Glass>
        </div>
      )}
    </div>
  );
}
