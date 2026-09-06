"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, DeviceTask, DeviceSummary, getApiBase, authFetch } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { Btn, Chip, Glass, GhostInput, TopBar } from "@/components/aurora/primitives";

const TERMINAL = new Set(["succeeded", "failed", "timeout", "cancelled"]);
// Poll while anything is still in flight. Device polls the server every 10s,
// so a faster cadence here would just spin without new information.
const POLL_MS = 4000;

function statusTone(s: string): "neutral" | "accent" | "success" | "warn" | "danger" {
  if (s === "succeeded") return "success";
  if (s === "failed" || s === "timeout") return "danger";
  if (s === "running") return "accent";
  if (s === "cancelled") return "warn";
  return "neutral";
}

export default function TasksPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/ask");
  }, [router]);

  const { t } = useI18n();
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [action, setAction] = useState<"shell" | "agent">("shell");
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [timeout, setTimeoutSec] = useState(300);
  const [tasks, setTasks] = useState<DeviceTask[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    authFetch(`${getApiBase()}/api/devices`)
      .then((r) => r.json())
      .then((d: DeviceSummary[]) => {
        setDevices(d || []);
        if (d?.length) setDeviceId((prev) => prev || d[0].device_id);
      })
      .catch(() => setDevices([]));
  }, []);

  const refresh = useCallback(async () => {
    try {
      setTasks(await api.listDeviceTasks(undefined, undefined, 30));
    } catch {
      /* transient — the next tick retries */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-poll only while something is unfinished; stop once everything settles
  // so an idle page isn't hitting the API forever.
  useEffect(() => {
    const pending = tasks.some((x) => !TERMINAL.has(x.status));
    if (!pending) return;
    timerRef.current = setTimeout(refresh, POLL_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [tasks, refresh]);

  const dispatch = async () => {
    if (!deviceId || !command.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const payload: Record<string, unknown> =
        action === "shell" ? { command } : { prompt: command };
      if (cwd.trim()) payload.cwd = cwd.trim();
      await api.dispatchDeviceTask(deviceId, action, payload, timeout);
      setCommand("");
      await refresh();
    } catch (e) {
      // 403 here almost always means the remote-exec switch is off.
      const msg = (e as Error)?.message || "";
      setErr(msg.includes("403") || /disabled|key/i.test(msg) ? t.tasks.disabled : msg);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      await api.cancelDeviceTask(id);
      await refresh();
    } catch {
      /* ignore — refresh will show the real state */
    }
  };

  const statusLabel = (s: string) =>
    ({
      queued: t.tasks.statusQueued,
      running: t.tasks.statusRunning,
      succeeded: t.tasks.statusSucceeded,
      failed: t.tasks.statusFailed,
      timeout: t.tasks.statusTimeout,
      cancelled: t.tasks.statusCancelled,
    }[s] || s);

  return (
    <div className="max-w-4xl mx-auto">
      <TopBar title={t.tasks.title} subtitle={t.tasks.subtitle} />

      <Glass padding={18} radius={18} style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <label className="aurora-input" style={{ minWidth: 220, flex: 1 }}>
            <Icon name="devices" size={15} style={{ color: "var(--aurora-fg3)" }} />
            <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              {devices.length === 0 && <option value="">{t.tasks.noDevices}</option>}
              {devices.map((d) => (
                <option key={d.device_id} value={d.device_id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>

          <label className="aurora-input" style={{ minWidth: 150 }}>
            <Icon name="command" size={15} style={{ color: "var(--aurora-fg3)" }} />
            <select
              value={action}
              onChange={(e) => setAction(e.target.value as "shell" | "agent")}
            >
              <option value="shell">{t.tasks.shell}</option>
              <option value="agent">{t.tasks.agent}</option>
            </select>
          </label>

          <label className="aurora-input" style={{ width: 130 }}>
            <Icon name="clock" size={15} style={{ color: "var(--aurora-fg3)" }} />
            <input
              type="number"
              min={1}
              max={86400}
              value={timeout}
              onChange={(e) => setTimeoutSec(Number(e.target.value) || 300)}
              style={{ width: "100%", background: "transparent", border: "none", outline: "none", color: "var(--aurora-fg1)" }}
            />
          </label>
        </div>

        <GhostInput
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              dispatch();
            }
          }}
          placeholder={action === "shell" ? t.tasks.commandPlaceholder : t.tasks.promptPlaceholder}
          icon={action === "shell" ? "code" : "sparkles"}
          wrapStyle={{ marginBottom: 10 }}
        />

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <GhostInput
            type="text"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder={t.tasks.cwd}
            icon="folder"
            wrapStyle={{ flex: 1, minWidth: 200 }}
          />
          <Btn onClick={dispatch} disabled={busy || !command.trim() || !deviceId} icon="rocket">
            {t.tasks.dispatch}
          </Btn>
        </div>

        {err && (
          <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--aurora-danger, #d33)", lineHeight: 1.5 }}>
            {err}
          </div>
        )}
      </Glass>

      <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginBottom: 8 }}>
        {t.tasks.history}
      </div>

      {tasks.length === 0 && (
        <Glass padding={30} radius={18} style={{ textAlign: "center" }}>
          <p style={{ color: "var(--aurora-fg4)", fontSize: 13 }}>{t.tasks.empty}</p>
        </Glass>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {tasks.map((task) => {
          const dev = devices.find((d) => d.device_id === task.device_id);
          const open = expanded === task.id;
          const body = (task.stdout || "") + (task.stderr ? `\n[stderr]\n${task.stderr}` : "");
          return (
            <Glass key={task.id} padding={14} radius={16}>
              <div
                onClick={() => setExpanded(open ? null : task.id)}
                style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", flexWrap: "wrap" }}
              >
                <Chip tone={statusTone(task.status)}>{statusLabel(task.status)}</Chip>
                <Chip>{task.action}</Chip>
                <span style={{ fontSize: 12, color: "var(--aurora-fg3)" }}>
                  {dev?.name || task.device_id.slice(0, 8)}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--aurora-fg2)",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                    minWidth: 120,
                  }}
                >
                  {String(task.payload?.command || task.payload?.prompt || "")}
                </span>
                {!TERMINAL.has(task.status) && (
                  <Btn
                    onClick={(e) => {
                      e.stopPropagation();
                      cancel(task.id);
                    }}
                  >
                    {t.tasks.cancel}
                  </Btn>
                )}
              </div>

              {open && (
                <div style={{ marginTop: 10 }}>
                  {task.error && (
                    <div style={{ fontSize: 12.5, color: "var(--aurora-danger, #d33)", marginBottom: 8 }}>
                      {task.error}
                    </div>
                  )}
                  {body ? (
                    <pre
                      style={{
                        margin: 0,
                        padding: 12,
                        borderRadius: 10,
                        background: "var(--aurora-bg2, rgba(0,0,0,0.25))",
                        color: "var(--aurora-fg2)",
                        fontSize: 12,
                        lineHeight: 1.5,
                        maxHeight: 340,
                        overflow: "auto",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {body}
                    </pre>
                  ) : (
                    <span style={{ fontSize: 12, color: "var(--aurora-fg4)" }}>—</span>
                  )}
                  {task.exit_code !== null && (
                    <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginTop: 6 }}>
                      exit {task.exit_code}
                    </div>
                  )}
                </div>
              )}
            </Glass>
          );
        })}
      </div>
    </div>
  );
}
