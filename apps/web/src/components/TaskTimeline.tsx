"use client";

import { useState, useMemo, type CSSProperties, type ReactNode } from "react";
import { formatTokenCount, steerNote, taskRunSummary, taskToolKind, taskToolLabel, type TaskEvent, type TaskToolKind } from "@memento/core";
import type { FileDevice } from "@/lib/file-devices";
import { fmt, useI18n } from "@/lib/i18n";
import { Icon } from "./aurora/Icon";
import { QuestionPrompt } from "./QuestionPrompt";
import { useMediaInspector } from "./viewers/MediaInspectorContext";
import { detectMediaType, isLocalFilePath } from "./viewers/MediaPreview";

type IconName = Parameters<typeof Icon>[0]["name"];

const COLLAPSED = 6;
const mono: CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 };

const KIND_ICON: Record<TaskToolKind, IconName> = {
  command: "terminal",
  read: "book",
  edit: "edit",
  write: "file_text",
  list: "folder",
  search: "search",
  web: "link",
  agent: "layers",
  todo: "check",
  task: "activity",
  question: "message",
  mcp: "server",
  other: "cube",
};

export interface StepFile {
  path: string;
  /** The lines it read ("10-40"), when the agent says. */
  range: string;
  name: string;
  dir: string;
}

/**
 * The files a read / edit / write step names, from its detail: one path (Claude's file_path), several
 * ("a.ts, b.ts" from Codex) or a path with the lines read ("src/x.ts:10-40" from Antigravity). Empty
 * when the detail isn't paths (a description, or a list cut short), so it shows as plain text.
 */
export function stepFiles(detail: string): StepFile[] {
  const parts = detail.split(/,\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return [];
  const files: StepFile[] = [];
  for (const part of parts) {
    // A list cut short ("…"), or words rather than a path ("Reading the config"); a path may have spaces
    // in it ("/Users/me/My Docs/a.md") but then starts like one.
    if (part.endsWith("…") || (/\s/.test(part) && !/^(?:[/~.]|[A-Za-z]:[/\\]|file:)/.test(part))) return [];
    const m = /^(.+?):(\d+(?:-\d+)?)$/.exec(part);
    const path = m?.[1] ?? part;
    const range = m?.[2] ?? "";
    const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const name = path.slice(cut + 1);
    if (!name || (cut < 0 && !/\.[A-Za-z0-9]{1,12}$/.test(name))) return [];
    files.push({ path, range, name, dir: cut > 0 ? path.slice(0, cut) : "" });
  }
  return files;
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
  device,
}: {
  events: readonly TaskEvent[];
  running: boolean;
  taskId?: string;
  /** The device the task ran on, so a file it read or edited opens from that device. */
  device?: FileDevice;
}) {
  const { t } = useI18n();
  const tl = t.taskRun;
  const inspector = useMediaInspector();
  const [showAll, setShowAll] = useState(false);
  const [openTool, setOpenTool] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const rows = events.filter((e) => e.kind !== "usage" && e.kind !== "session");
  const kept = [...events].reverse().find((e) => e.kind === "worktree" && e.status === "kept") as (TaskEvent & Record<string, unknown>) | undefined;

  const isWaitingQuestion = (e: TaskEvent) =>
    e.kind === "question" && ((e as any).status === "waiting" || !(e as any).status);

  // Guaranteed unhide protection: any active question waiting for response is never hidden
  const visible = useMemo(() => {
    if (showAll || rows.length <= COLLAPSED) return rows;
    const recent = rows.slice(-COLLAPSED);
    const olderWaiting = rows.slice(0, rows.length - COLLAPSED).filter(isWaitingQuestion);
    if (olderWaiting.length === 0) return recent;
    return [...olderWaiting, ...recent];
  }, [showAll, rows]);

  const hidden = rows.length - visible.length;

  const plain = (icon: IconName, text: string, note: string | null, color = "var(--aurora-fg3)") => (
    <div style={{ display: "flex", gap: 8, padding: "4px 0", fontSize: 12.5, lineHeight: 1.45, minWidth: 0, maxWidth: "100%", overflow: "hidden" }}>
      <Icon name={icon} size={13} style={{ color, flexShrink: 0, marginTop: 2 }} />
      <span style={{ color: "var(--aurora-fg2)", minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {text}
        {note && <span style={{ color: "var(--aurora-fg3)" }}>{`  ${note}`}</span>}
      </span>
    </div>
  );

  // Code synced from another device before the run, and what the agent changed sent back after it
  const workspaceRow = (ev: Record<string, unknown>) => {
    const source = str(ev.source) || tl.wsSourceDevice;
    const files = Array.isArray(ev.files) ? (ev.files as Array<{ path?: string; status?: string }>).filter((f) => f && f.path) : [];
    const error = str(ev.error) || null;
    const patch = str(ev.patch_path);
    const fileList = files.length > 0 && (
      <div title={files.map((f) => `${f.status || "M"} ${f.path}`).join("\n")} style={{ ...mono, fontSize: 11.5, color: "var(--aurora-fg3)", margin: "0 0 2px 21px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {files.slice(0, 6).map((f) => f.path).join(", ")}
        {files.length > 6 && `  ${fmt(tl.wsMoreFiles, { n: files.length - 6 })}`}
      </div>
    );
    // The agent's commits and its push, done from the device the code is on
    const commits = Array.isArray(ev.commits) ? (ev.commits as Array<{ sha?: string; subject?: string }>).filter((c) => c && c.sha) : [];
    const push = ev.push && typeof ev.push === "object" ? (ev.push as Record<string, unknown>) : null;
    const commitsError = str(ev.commits_error) || null;
    const commitRows = (
      <>
        {commits.length > 0 &&
          plain(
            "code",
            ev.committed === "branch"
              ? fmt(tl.wsCommitted, { source, n: commits.length, branch: str(ev.commit_branch) || "HEAD" })
              : fmt(tl.wsCommitsKept, { source, n: commits.length, branch: str(ev.commit_branch) }),
            commits
              .slice(0, 3)
              .map((c) => `${str(c.sha).slice(0, 8)} ${str(c.subject)}`)
              .join(" · "),
            ev.committed === "branch" ? "#10B981" : "#D97706",
          )}
        {commitsError && plain("code", tl.wsCommitsNot, commitsError, "#D97706")}
        {push &&
          (push.status === "pushed"
            ? plain(
                "arrow_up",
                fmt(tl.wsPushed, { source, remote: str(push.remote) || "origin", branch: str(push.branch) }),
                Number(push.rebased) > 0 ? fmt(tl.wsPushRebased, { n: Number(push.rebased) }) : null,
                "#10B981",
              )
            : plain("arrow_up", tl.wsPushFailed, str(push.detail) || str(push.status), push.status === "skipped" ? "#D97706" : "#DC2626"))}
      </>
    );
    const body = workspaceStatus(ev, source, files, error, patch, fileList);
    return (
      <>
        {body}
        {commitRows}
      </>
    );
  };

  const workspaceStatus = (
    ev: Record<string, unknown>,
    source: string,
    files: Array<{ path?: string; status?: string }>,
    error: string | null,
    patch: string,
    fileList: ReactNode,
  ) => {
    switch (ev.status) {
      case "syncing":
        return plain("refresh", fmt(tl.wsSyncing, { source }), str(ev.path) || null, "var(--aurora-accent)");
      case "synced": {
        const bytes = Number(ev.bytes) || 0;
        const size = bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)}MB` : bytes > 0 ? `${Math.max(1, Math.round(bytes / 1024))}KB` : "";
        // Straight from the source over a direct channel (all of it, or the part before it broke off)
        const direct = Number(ev.direct_bytes) > 0 ? (Number(ev.direct_bytes) >= bytes ? tl.wsDirect : tl.wsPartlyDirect) : "";
        const note = [str(ev.branch), size, Number(ev.seconds) > 0 ? `${ev.seconds}s` : "", direct].filter(Boolean).join(" · ");
        return plain("refresh", fmt(tl.wsSynced, { source }), note || null, "#10B981");
      }
      case "applied":
        return (
          <>
            {plain("check", fmt(tl.wsApplied, { source, n: files.length }), null, "#10B981")}
            {fileList}
          </>
        );
      case "conflict":
        return (
          <>
            {plain("layers", fmt(tl.wsConflict, { source, branch: str(ev.branch) }), error, "#D97706")}
            {fileList}
          </>
        );
      case "saved":
        return (
          <>
            {plain("file_text", fmt(tl.wsSaved, { source }), patch || error, "#D97706")}
            {fileList}
          </>
        );
      case "pending":
        return plain("clock", fmt(tl.wsPending, { source }), error, "#D97706");
      case "unchanged":
        return plain("check", tl.wsUnchanged, null);
      case "failed":
        return plain("close", fmt(tl.wsFailed, { source }), error, "#DC2626");
      default:
        return null;
    }
  };

  const row = (e: TaskEvent, i: number) => {
    const ev = e as TaskEvent & Record<string, unknown>;
    switch (e.kind) {
      case "tool": {
        const id = str(ev.id) || String(i);
        const output = str(ev.output);
        const open = openTool === id && !!output;
        const status = str(ev.status);
        const rawName = str(ev.name);
        const rawDetail = str(ev.detail);

        // Parse tool name and detail if rawName or rawDetail contains "ToolName: detail"
        let toolName = rawName;
        let detail = rawDetail;
        if (rawName && rawName.includes(":") && (!rawDetail || rawDetail === rawName)) {
          const colonIdx = rawName.indexOf(":");
          if (colonIdx > 0 && colonIdx < 30) {
            toolName = rawName.slice(0, colonIdx).trim();
            detail = rawName.slice(colonIdx + 1).trim();
          }
        } else if (rawDetail && rawName && rawDetail.startsWith(`${rawName}:`)) {
          detail = rawDetail.slice(rawName.length + 1).trim();
        }

        const label = taskToolLabel(toolName || undefined);
        const showDetail = Boolean(detail && detail !== label && detail !== toolName);
        const kind = taskToolKind(toolName || rawName || undefined);
        const files = showDetail && (kind === "read" || kind === "edit" || kind === "write") ? stepFiles(detail) : [];

        return (
          <div key={id} style={{ minWidth: 0, maxWidth: "100%", overflow: "hidden" }}>
            <button
              type="button"
              // Not `disabled`: a disabled button swallows clicks on the file names inside it.
              aria-disabled={!output || undefined}
              onClick={() => output && setOpenTool(open ? null : id)}
              style={{
                display: "flex",
                width: "100%",
                maxWidth: "100%",
                minWidth: 0,
                alignItems: "center",
                gap: 8,
                padding: "4px 0",
                background: "none",
                border: 0,
                cursor: output ? "pointer" : "default",
                textAlign: "left",
                overflow: "hidden",
              }}
            >
              <Icon name={KIND_ICON[kind]} size={13} style={{ color: "var(--aurora-fg3)", flexShrink: 0 }} />
              <span
                style={{
                  fontSize: 12.5,
                  color: "var(--aurora-fg2)",
                  flexShrink: 0,
                  maxWidth: showDetail ? "36%" : "calc(100% - 46px)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {label}
              </span>
              {files.length > 0 && (
                <span title={files.map((f) => f.path).join("\n")} style={{ ...mono, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {files.map((f, n) => {
                    const openable = !!inspector && isLocalFilePath(f.path) && detectMediaType(f.path) !== "unknown";
                    const open = () => inspector?.openMediaByUrl(f.path, f.name, null, device);
                    return (
                      <span key={`${f.path}:${n}`}>
                        {n > 0 && <span style={{ color: "var(--aurora-fg4)" }}>{", "}</span>}
                        <span
                          role={openable ? "link" : undefined}
                          tabIndex={openable ? 0 : undefined}
                          onClick={
                            openable
                              ? (ev) => {
                                  ev.stopPropagation();
                                  open();
                                }
                              : undefined
                          }
                          onKeyDown={
                            openable
                              ? (ev) => {
                                  if (ev.key !== "Enter" && ev.key !== " ") return;
                                  ev.preventDefault();
                                  ev.stopPropagation();
                                  open();
                                }
                              : undefined
                          }
                          style={{
                            color: openable ? "var(--aurora-accent)" : "var(--aurora-fg1)",
                            fontWeight: 600,
                            cursor: openable ? "pointer" : undefined,
                            textDecoration: openable ? "underline" : undefined,
                            textDecorationColor: openable ? "color-mix(in srgb, var(--aurora-accent) 40%, transparent)" : undefined,
                            textUnderlineOffset: 2,
                          }}
                        >
                          {f.name}
                        </span>
                        {f.range && <span style={{ color: "var(--aurora-fg3)" }}>{`:${f.range}`}</span>}
                        {f.dir && files.length === 1 && <span style={{ color: "var(--aurora-fg4)" }}>{`  ${f.dir}`}</span>}
                      </span>
                    );
                  })}
                </span>
              )}
              {showDetail && files.length === 0 && (
                <span
                  style={{
                    ...mono,
                    flex: 1,
                    minWidth: 0,
                    color: "var(--aurora-fg1)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {detail}
                </span>
              )}
              <span style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", marginLeft: "auto", paddingLeft: 4 }}>
                {status === "failed" ? (
                  <Icon name="close" size={13} style={{ color: "#DC2626" }} />
                ) : status === "running" ? (
                  <span className={running ? "animate-pulse" : undefined} style={{ fontSize: 12, color: running ? "var(--aurora-accent)" : "var(--aurora-fg4)" }}>
                    •••
                  </span>
                ) : (
                  <Icon name="check" size={13} style={{ color: "#10B981" }} />
                )}
              </span>
            </button>
            {open && (
              <pre
                style={{
                  ...mono,
                  fontSize: 11.5,
                  margin: "4px 0 4px 21px",
                  padding: 8,
                  borderRadius: 6,
                  background: "var(--aurora-surface-solid)",
                  color: "var(--aurora-fg2)",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  maxWidth: "calc(100% - 21px)",
                  overflowX: "auto",
                }}
              >
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
      case "workspace":
        return <div key={i}>{workspaceRow(ev)}</div>;
      case "error":
        return <div key={i}>{plain("close", str(ev.message) || tl.error, null, "#DC2626")}</div>;
      case "compact": {
        const pre = Number(ev.pre_tokens);
        const text = pre > 0 ? fmt(tl.compacted, { n: formatTokenCount(pre) }) : tl.compactedPlain;
        return <div key={i}>{plain("sparkles", text, null, "#10B981")}</div>;
      }
      case "session_sync": {
        const bytes = Number(ev.bytes);
        const size = bytes > 0 ? (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`) : "";
        return <div key={i}>{plain("clock", ev.status === "fetched" ? fmt(tl.sessionFetched, { n: size }) : tl.sessionCurrent, null)}</div>;
      }
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
    <div
      style={{
        marginBottom: 10,
        padding: "10px 12px",
        borderRadius: 10,
        background: "var(--aurora-surface-mute)",
        border: "1px solid var(--aurora-border)",
        minWidth: 0,
        maxWidth: "100%",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, maxWidth: "100%", overflow: "hidden" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--aurora-fg2)", flexShrink: 0 }}>{tl.title}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--aurora-fg3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{taskRunSummary(events)}</span>
        {rows.length > COLLAPSED && (
          <button type="button" onClick={() => setShowAll((v) => !v)} style={{ background: "none", border: 0, cursor: "pointer", fontSize: 12, color: "var(--aurora-accent)", flexShrink: 0 }}>
            {showAll ? tl.recentOnly : fmt(tl.showAll, { n: rows.length })}
          </button>
        )}
      </div>
      {hidden > 0 && <div style={{ fontSize: 11.5, color: "var(--aurora-fg4)", marginTop: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fmt(tl.hiddenBefore, { n: hidden })}</div>}
      <div style={{ marginTop: 4, minWidth: 0, maxWidth: "100%", overflow: "hidden" }}>{visible.map(row)}</div>
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

