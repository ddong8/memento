"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { api } from "@/lib/api-client";
import { fmt, useI18n } from "@/lib/i18n";
import { Btn, Glass } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";
import { triggerHapticFeedback } from "@/lib/native-notify";

function RenderTodoTitle({ title }: { title: string }) {
  if (!title) return null;
  if (title.includes("`")) {
    const parts = title.split(/(`[^`]+`)/g);
    return (
      <span>
        {parts.map((p, idx) => {
          if (p.startsWith("`") && p.endsWith("`") && p.length >= 2) {
            return (
              <code
                key={idx}
                style={{
                  padding: "1px 5px",
                  borderRadius: 4,
                  background: "rgba(255, 255, 255, 0.08)",
                  fontSize: "0.92em",
                  fontFamily: "monospace",
                  color: "var(--aurora-accent)",
                }}
              >
                {p.slice(1, -1)}
              </code>
            );
          }
          return <span key={idx}>{p}</span>;
        })}
      </span>
    );
  }
  return <span>{title}</span>;
}

type Todo = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? "" : String(v));

export type DueState = "overdue" | "today" | "soon" | "later" | "none";

/** Where a due date (YYYY-MM-DD) stands relative to today. */
function dueState(due: string | null | undefined, today = new Date()): DueState {
  if (!due) return "none";
  const d = new Date(`${due}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "none";
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.round((d.getTime() - day.getTime()) / 86_400_000);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  if (diff <= 3) return "soon";
  return "later";
}

const input: CSSProperties = {
  fontSize: 13,
  padding: "7px 10px",
  borderRadius: 10,
  border: "1px solid var(--aurora-border-strong)",
  background: "var(--aurora-surface-solid)",
  color: "var(--aurora-fg1)",
};

/**
 * Things the user said they'd do later — picked up from what they typed to their
 * AIs, left over by sessions, or added here — with done / drop / due date.
 */
export default function TodoPanel() {
  const { t } = useI18n();
  const d = t.todos;
  const [open, setOpen] = useState<Todo[]>([]);
  const [closed, setClosed] = useState<Todo[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "unsupported">("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [due, setDue] = useState("");

  const reload = useCallback(async () => {
    try {
      const data = await api.getTodos();
      setOpen(Array.isArray(data.open) ? (data.open as Todo[]) : []);
      setClosed(Array.isArray(data.closed) ? (data.closed as Todo[]) : []);
      setState("ready");
      setError(null);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("404")) setState("unsupported");
      else {
        setState("ready");
        setError(fmt(d.loadFailed, { error: msg }));
      }
    }
  }, [d]);

  useEffect(() => {
    reload();
  }, [reload]);

  const update = async (todo: Todo, fields: Record<string, unknown>) => {
    setBusy(str(todo.id));
    try {
      await api.updateTodo(str(todo.id), fields);
      await reload();
    } catch (e) {
      setError(fmt(d.saveFailed, { error: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    if (!title.trim()) return;
    setBusy("add");
    try {
      await api.addTodo(title.trim(), { ...(due ? { due } : {}), ...(project.trim() ? { project: project.trim() } : {}) });
      setTitle("");
      setProject("");
      setDue("");
      setAdding(false);
      await reload();
    } catch (e) {
      setError(fmt(d.saveFailed, { error: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  if (state !== "ready") return null;
  const overdue = open.filter((x) => dueState(str(x.due) || null) === "overdue").length;
  const sources: Record<string, string> = { voice: d.sourceVoice, session: d.sourceSession, agent: d.sourceAgent, mcp: d.sourceAgent, manual: d.sourceManual };

  const dueText = (due: string) => {
    const s = dueState(due);
    if (s === "overdue") {
      const days = Math.round((Date.now() - new Date(`${due}T00:00:00`).getTime()) / 86_400_000);
      return fmt(d.overdueDays, { n: Math.max(1, days) });
    }
    if (s === "today") return d.dueToday;
    const date = new Date(`${due}T00:00:00`);
    return fmt(d.dueOn, { date: `${date.getMonth() + 1}-${date.getDate()}` });
  };

  const item = (todo: Todo, isClosed: boolean) => {
    const id = str(todo.id);
    const dueValue = str(todo.due) || null;
    const ds = dueState(dueValue);
    const evidence = str(isClosed ? todo.close_evidence : todo.evidence);
    const meta = [
      sources[str(todo.source)] ?? str(todo.source),
      str(todo.project),
      isClosed ? (todo.status === "dropped" ? d.dropped : d.done) : "",
    ].filter(Boolean);
    return (
      <div key={id} style={{ display: "flex", gap: 10, padding: "7px 0", alignItems: "flex-start" }}>
        <input
          type="checkbox"
          checked={isClosed}
          disabled={busy !== null}
          onChange={(e) => {
            triggerHapticFeedback(15);
            update(todo, { status: e.target.checked ? "done" : "open" });
          }}
          style={{ marginTop: 4, width: 15, height: 15, accentColor: "var(--aurora-accent)" }}
          aria-label={d.markDone}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            title={evidence || undefined}
            style={{
              fontSize: 13.5,
              lineHeight: 1.4,
              color: isClosed ? "var(--aurora-fg3)" : "var(--aurora-fg1)",
              textDecoration: isClosed ? "line-through" : undefined,
              overflowWrap: "anywhere",
            }}
          >
            <RenderTodoTitle title={str(todo.title)} />
          </div>
          <div style={{ fontSize: 11.5, color: "var(--aurora-fg3)", marginTop: 2 }}>
            {dueValue && !isClosed && (
              <span style={{ color: ds === "overdue" ? "#DC2626" : ds === "today" ? "#B45309" : undefined }}>{dueText(dueValue)} · </span>
            )}
            {meta.join(" · ")}
          </div>
        </div>
        {!isClosed && (
          <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
            <label title={d.setDue} style={{ position: "relative", cursor: "pointer", color: "var(--aurora-fg3)", display: "flex", padding: 4 }}>
              <Icon name="calendar" size={14} />
              <input
                type="date"
                value={dueValue ?? ""}
                disabled={busy !== null}
                onChange={(e) => update(todo, { due: e.target.value })}
                style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }}
              />
            </label>
            <button
              type="button"
              title={d.drop}
              disabled={busy !== null}
              onClick={() => {
                triggerHapticFeedback(10);
                update(todo, { status: "dropped" });
              }}
              style={{ background: "none", border: 0, cursor: "pointer", color: "var(--aurora-fg3)", padding: 4, display: "flex" }}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <Glass padding="14px 18px" radius={18} style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="check" size={16} style={{ color: "var(--aurora-accent)" }} />
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--aurora-fg1)" }}>{fmt(d.title, { n: open.length })}</span>
        {overdue > 0 && <span style={{ fontSize: 12, color: "#DC2626" }}>{fmt(d.overdueCount, { n: overdue })}</span>}
        <span style={{ flex: 1 }} />
        <Btn variant="ghost" size="sm" icon="plus" disabled={busy !== null} onClick={() => setAdding((v) => !v)}>
          {d.add}
        </Btn>
      </div>
      {error && <p style={{ margin: "6px 0 0", fontSize: 12, color: "#DC2626" }}>{error}</p>}
      {adding && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0 4px" }}>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder={d.titleHint}
            style={{ ...input, flex: "2 1 220px" }}
          />
          <input value={project} onChange={(e) => setProject(e.target.value)} placeholder={d.projectHint} style={{ ...input, flex: "1 1 120px" }} />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} style={{ ...input, flex: "0 0 auto" }} aria-label={d.setDue} />
          <Btn size="sm" disabled={busy !== null || !title.trim()} onClick={add}>
            {d.addConfirm}
          </Btn>
        </div>
      )}
      {open.length === 0 && !adding && <p style={{ margin: "6px 0 2px", fontSize: 12.5, color: "var(--aurora-fg3)", lineHeight: 1.5 }}>{d.empty}</p>}
      {open.map((x) => item(x, false))}
      {closed.length > 0 && (
        <button
          type="button"
          onClick={() => setShowClosed((v) => !v)}
          style={{ background: "none", border: 0, padding: "6px 0 0", cursor: "pointer", color: "var(--aurora-accent)", fontSize: 12.5 }}
        >
          {showClosed ? d.hideClosed : fmt(d.showClosed, { n: closed.length })}
        </button>
      )}
      {showClosed && closed.map((x) => item(x, true))}
    </Glass>
  );
}
