"use client";

import { useState, type CSSProperties } from "react";
import { steerNote, taskRunSummary, taskToolLabel, type TaskEvent } from "@memento/core";
import { authFetch, getApiBase } from "@/lib/api-client";
import { fmt, useI18n } from "@/lib/i18n";
import { Icon } from "./aurora/Icon";
import { QuestionPrompt } from "./QuestionPrompt";

type IconName = Parameters<typeof Icon>[0]["name"];

const COLLAPSED = 6;
const mono: CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 };

function toolIcon(name: string | undefined): IconName {
  switch (name) {
    case "Bash":
    case "BashOutput":
    case "Shell":
      return "terminal";
    case "Read":
      return "book";
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit";
    case "Grep":
    case "Glob":
    case "WebSearch":
      return "search";
    case "WebFetch":
      return "link";
    case "Task":
    case "Agent":
      return "layers";
    case "TodoWrite":
      return "check";
    default:
      return "cube";
  }
}

const str = (v: unknown) => (v == null ? "" : String(v));

/**
 * The steps of a structured agent run (Claude Code, Codex): tool calls as they
 * happen, follow-ups, the worktree it ran in, and what it cost.
 */
export default function TaskTimeline({
  events,
  running,
  taskId,
}: {
  events: readonly TaskEvent[];
  running: boolean;
  taskId?: string;
}) {
  const { t } = useI18n();
  const tl = t.taskRun;
  const [showAll, setShowAll] = useState(false);
  const [openTool, setOpenTool] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const rows = events.filter((e) => e.kind !== "usage" && e.kind !== "session");
  const kept = [...events].reverse().find((e) => e.kind === "worktree" && e.status === "kept") as (TaskEvent & Record<string, unknown>) | undefined;
  const hidden = !showAll && rows.length > COLLAPSED ? rows.length - COLLAPSED : 0;
  const visible = hidden ? rows.slice(hidden) : rows;

  const plain = (icon: IconName, text: string, note: string | null, color = "var(--aurora-fg3)") => (
    <div style={{ display: "flex", gap: 8, padding: "4px 0", fontSize: 12.5, lineHeight: 1.45 }}>
      <Icon name={icon} size={13} style={{ color, flexShrink: 0, marginTop: 2 }} />
      <span style={{ color: "var(--aurora-fg2)" }}>
        {text}
        {note && <span style={{ color: "var(--aurora-fg3)" }}>{`  ${note}`}</span>}
      </span>
    </div>
  );

  const row = (e: TaskEvent, i: number) => {
    const ev = e as TaskEvent & Record<string, unknown>;
    switch (e.kind) {
      case "tool": {
        const id = str(ev.id) || String(i);
        const output = str(ev.output);
        const open = openTool === id && !!output;
        const status = str(ev.status);
        return (
          <div key={id}>
            <button
              type="button"
              disabled={!output}
              onClick={() => setOpenTool(open ? null : id)}
              style={{ display: "flex", width: "100%", alignItems: "center", gap: 8, padding: "4px 0", background: "none", border: 0, cursor: output ? "pointer" : "default", textAlign: "left" }}
            >
              <Icon name={toolIcon(str(ev.name))} size={13} style={{ color: "var(--aurora-fg3)", flexShrink: 0 }} />
              <span style={{ fontSize: 12.5, color: "var(--aurora-fg2)", flexShrink: 0 }}>{taskToolLabel(str(ev.name) || undefined)}</span>
              <span style={{ ...mono, flex: 1, minWidth: 0, color: "var(--aurora-fg1)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{str(ev.detail)}</span>
              {status === "failed" ? (
                <Icon name="close" size={13} style={{ color: "#DC2626" }} />
              ) : status === "running" ? (
                <span className={running ? "animate-pulse" : undefined} style={{ fontSize: 12, color: running ? "var(--aurora-accent)" : "var(--aurora-fg4)" }}>
                  •••
                </span>
              ) : (
                <Icon name="check" size={13} style={{ color: "#10B981" }} />
              )}
            </button>
            {open && (
              <pre style={{ ...mono, fontSize: 11.5, margin: "4px 0 4px 21px", padding: 8, borderRadius: 6, background: "var(--aurora-surface-solid)", color: "var(--aurora-fg2)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {output}
              </pre>
            )}
          </div>
        );
      }
      case "steer":
        return (
          <div key={i}>
            {plain("message", fmt(tl.youAdded, { text: str(ev.text) }), steerNote(str(ev.status) || undefined), ev.status === "sent" ? "var(--aurora-accent)" : "#D97706")}
          </div>
        );
      case "worktree":
        if (ev.status === "created") return <div key={i}>{plain("layers", fmt(tl.onBranch, { branch: str(ev.branch) }), null)}</div>;
        if (ev.status === "removed") return <div key={i}>{plain("layers", tl.branchRemoved, null)}</div>;
        if (ev.status === "skipped") return <div key={i}>{plain("layers", tl.noBranch, str(ev.reason) || null, "#D97706")}</div>;
        return null;
      case "error":
        return <div key={i}>{plain("close", str(ev.message) || tl.error, null, "#DC2626")}</div>;
      case "question":
        return (
          <QuestionPrompt
            key={str(ev.id) || i}
            questionEvent={ev as any}
            taskId={taskId}
            disabled={!running}
          />
        );
      default:
        return null;
    }
  };

  const merge = kept ? `git merge ${str(kept.branch)}` : "";

  return (
    <div style={{ marginBottom: 10, padding: "10px 12px", borderRadius: 10, background: "var(--aurora-surface-mute)", border: "1px solid var(--aurora-border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--aurora-fg2)" }}>{tl.title}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--aurora-fg3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{taskRunSummary(events)}</span>
        {rows.length > COLLAPSED && (
          <button type="button" onClick={() => setShowAll((v) => !v)} style={{ background: "none", border: 0, cursor: "pointer", fontSize: 12, color: "var(--aurora-accent)" }}>
            {showAll ? tl.recentOnly : fmt(tl.showAll, { n: rows.length })}
          </button>
        )}
      </div>
      {hidden > 0 && <div style={{ fontSize: 11.5, color: "var(--aurora-fg4)", marginTop: 6 }}>{fmt(tl.hiddenBefore, { n: hidden })}</div>}
      <div style={{ marginTop: 4 }}>{visible.map(row)}</div>
      {kept && (
        <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "var(--aurora-accent-soft)" }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--aurora-fg1)" }}>
            {fmt(Number(kept.commits) > 0 ? tl.keptCommits : tl.keptUncommitted, {
              branch: str(kept.branch),
              files: Number(kept.file_count) || 0,
              commits: Number(kept.commits) || 0,
            })}
          </div>
          <div style={{ ...mono, fontSize: 11.5, color: "var(--aurora-fg3)", marginTop: 2, overflowWrap: "anywhere" }}>{fmt(tl.dir, { path: str(kept.path) })}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
            <span style={{ flex: 1, fontSize: 12, color: "var(--aurora-fg2)" }}>{fmt(tl.mergeHint, { cmd: merge })}</span>
            <button
              type="button"
              title={tl.copyMerge}
              onClick={() => {
                navigator.clipboard?.writeText(merge).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
              style={{ background: "none", border: 0, cursor: "pointer", color: "var(--aurora-accent)", display: "flex" }}
            >
              <Icon name={copied ? "check" : "copy"} size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A follow-up for a running Claude task; it reads it at its next step. */
export function SteerBox({ taskId }: { taskId: string }) {
  const { t } = useI18n();
  const tl = t.taskRun;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setNote(null);
    try {
      const res = await authFetch(`${getApiBase()}/api/tasks/${taskId}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: value }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (data.ok) setText("");
      else setNote(tl.steerFailed);
    } catch {
      setNote(tl.steerFailed);
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) send();
          }}
          placeholder={tl.steerHint}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            padding: "7px 10px",
            borderRadius: 8,
            border: "1px solid var(--aurora-border-strong)",
            background: "var(--aurora-surface-solid)",
            color: "var(--aurora-fg1)",
          }}
        />
        <button
          type="button"
          disabled={sending || !text.trim()}
          onClick={send}
          title={tl.steerSend}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 34,
            borderRadius: 8,
            border: "1px solid var(--aurora-accent)",
            background: "var(--aurora-accent-soft)",
            color: "var(--aurora-accent)",
            cursor: sending || !text.trim() ? "default" : "pointer",
            opacity: sending || !text.trim() ? 0.5 : 1,
          }}
        >
          <Icon name="message" size={14} />
        </button>
      </div>
      {note && <div style={{ fontSize: 12, color: "#B45309", marginTop: 4 }}>{note}</div>}
    </div>
  );
}
