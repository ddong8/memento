"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type GitDiffFile,
  type GitDiffLine,
  type GitDiffResponse,
  type GitDeliverResponse,
} from "@/lib/api-client";
import { Icon } from "@/components/aurora/Icon";
import { Btn } from "@/components/aurora/primitives";
import {
  formatApiError,
  formatInlineReviewPrompt,
  type InlineDiffComment,
  type OpenGitDiffEventDetail,
} from "@/lib/ask/git-review";
import { showInAppToast } from "@/lib/native-notify";

const STATUS_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  A: { label: "新增", color: "#059669", bg: "rgba(16, 185, 129, 0.14)" },
  M: { label: "修改", color: "#D97706", bg: "rgba(217, 119, 6, 0.14)" },
  D: { label: "删除", color: "#DC2626", bg: "rgba(220, 38, 38, 0.14)" },
  R: { label: "重命名", color: "#2563EB", bg: "rgba(37, 99, 235, 0.14)" },
};

const COMMIT_PREFIXES = ["feat:", "fix:", "refactor:", "chore:", "docs:"];

interface GitDiffDrawerProps {
  open: boolean;
  onClose: () => void;
  deviceId: string;
  deviceName?: string;
  cwd: string;
  initialScope?: OpenGitDiffEventDetail | null;
  onSendReviewComments: (prompt: string) => void;
  isZh: boolean;
}

export function GitDiffDrawer({
  open,
  onClose,
  deviceId,
  deviceName,
  cwd,
  initialScope,
  onSendReviewComments,
  isZh,
}: GitDiffDrawerProps) {
  const [activeTab, setActiveTab] = useState<"diff" | "deliver">("diff");
  const [baseRef, setBaseRef] = useState<string>("");
  const [targetRef, setTargetRef] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffData, setDiffData] = useState<GitDiffResponse | null>(null);
  const [selectedPath, setSelectedPath] = useState<string>("");

  // Inline review comments
  const [comments, setComments] = useState<InlineDiffComment[]>([]);
  const [draftAnchor, setDraftAnchor] = useState<{
    path: string;
    line: number;
    side: "new" | "old";
    lineText: string;
  } | null>(null);
  const [draftText, setDraftText] = useState("");

  // Safe checkpoint restore confirmation
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // One-click Commit / Push / PR state
  const [selectedDeliverFiles, setSelectedDeliverFiles] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState("");
  const [doPush, setDoPush] = useState(false);
  const [doCreatePr, setDoCreatePr] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prBase, setPrBase] = useState("");
  const [delivering, setDelivering] = useState(false);
  const [deliverResult, setDeliverResult] = useState<GitDeliverResponse | null>(null);
  const [copiedSha, setCopiedSha] = useState(false);

  const effectiveCwd = (initialScope?.repoRoot || cwd || "").trim();

  const fetchDiff = useCallback(
    async (bRef: string, tRef: string) => {
      if (!deviceId || !effectiveCwd) {
        setError(isZh ? "请先在下方选择具体设备和项目目录后再查看代码 Diff" : "Select a device and project folder first");
        setDiffData(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await api.getGitDiff({
          device_id: deviceId,
          cwd: effectiveCwd,
          ...(bRef ? { base_ref: bRef } : {}),
          ...(tRef ? { target_ref: tRef } : {}),
        });
        setDiffData(res);
        const files = res.files || [];
        setSelectedPath((prev) => (prev && files.some((f) => f.path === prev) ? prev : files[0]?.path || ""));
        setSelectedDeliverFiles(new Set(files.map((f) => f.path)));
      } catch (e: unknown) {
        setError(formatApiError(e, isZh ? "获取 Git Diff 失败" : "Failed to fetch Git diff"));
        setDiffData(null);
      } finally {
        setLoading(false);
      }
    },
    [deviceId, effectiveCwd, isZh],
  );

  // Reset scope when drawer opens
  useEffect(() => {
    if (!open) return;
    const initBase = initialScope?.baseRef || "";
    const initTarget = initialScope?.targetRef || "";
    setBaseRef(initBase);
    setTargetRef(initTarget);
    setActiveTab("diff");
    setConfirmRestore(initialScope?.mode === "restore" && Boolean(initBase));
    setDeliverResult(null);
    setDraftAnchor(null);
    setDraftText("");
    void fetchDiff(initBase, initTarget);
  }, [open, initialScope, fetchDiff]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const files = useMemo(() => diffData?.files || [], [diffData]);
  const activeFile: GitDiffFile | undefined = useMemo(
    () => files.find((f) => f.path === selectedPath) || files[0],
    [files, selectedPath],
  );

  const commentCountByFile = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of comments) {
      map.set(c.path, (map.get(c.path) || 0) + 1);
    }
    return map;
  }, [comments]);

  const isCheckpointScope = Boolean(
    baseRef && targetRef && baseRef.startsWith("refs/memento/checkpoints/"),
  );

  const handleScopeChange = (val: string) => {
    setConfirmRestore(false);
    setDraftAnchor(null);
    if (!val) {
      setBaseRef("");
      setTargetRef("");
      void fetchDiff("", "");
      return;
    }
    if (val.startsWith("cp:")) {
      const id = val.slice(3);
      const cp = (diffData?.checkpoints || []).find((c) => c.id === id);
      if (cp) {
        setBaseRef(cp.before_ref);
        setTargetRef(cp.after_ref);
        void fetchDiff(cp.before_ref, cp.after_ref);
      }
      return;
    }
    if (val.startsWith("commit:")) {
      const sha = val.slice(7);
      const commit = (diffData?.recent_commits || []).find((c) => c.sha === sha);
      if (commit) {
        setBaseRef(commit.parent_sha || "");
        setTargetRef(commit.sha);
        void fetchDiff(commit.parent_sha || "", commit.sha);
      }
    }
  };

  const handleLineClick = (filePath: string, line: GitDiffLine) => {
    const lineNum = line.new_line ?? line.old_line;
    if (!lineNum) return;
    const side: "new" | "old" = line.new_line != null ? "new" : "old";
    setDraftAnchor({ path: filePath, line: lineNum, side, lineText: line.content });
    setDraftText("");
  };

  const handleSaveComment = () => {
    if (!draftAnchor || !draftText.trim()) return;
    const item: InlineDiffComment = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      path: draftAnchor.path,
      line: draftAnchor.line,
      side: draftAnchor.side,
      lineText: draftAnchor.lineText,
      comment: draftText.trim(),
    };
    setComments((prev) => [...prev, item]);
    setDraftAnchor(null);
    setDraftText("");
  };

  const handleDeleteComment = (id: string) => {
    setComments((prev) => prev.filter((c) => c.id !== id));
  };

  const handleSendAllComments = () => {
    const prompt = formatInlineReviewPrompt(comments, {
      branch: diffData?.branch,
      baseRef,
      targetRef,
      isZh,
    });
    if (!prompt) return;
    onSendReviewComments(prompt);
    setComments([]);
    onClose();
  };

  const handleRestoreCheckpoint = async () => {
    if (!isCheckpointScope || !baseRef || restoring) return;
    setRestoring(true);
    try {
      const res = await api.restoreGitCheckpoint({
        device_id: deviceId,
        cwd: effectiveCwd,
        target_ref: baseRef,
      });
      setConfirmRestore(false);
      showInAppToast(
        isZh ? "已安全回滚到该回合之前" : "Checkpoint restored",
        isZh
          ? `恢复 ${res.files_restored ?? 0} 个文件、清理 ${res.files_removed ?? 0} 个新增文件（已留安全备份）`
          : `Restored ${res.files_restored ?? 0} file(s), removed ${res.files_removed ?? 0} new file(s)`,
      );
      setBaseRef("");
      setTargetRef("");
      await fetchDiff("", "");
    } catch (e: unknown) {
      showInAppToast(isZh ? "回滚失败" : "Restore failed", formatApiError(e, isZh ? "回滚检查点失败" : "Restore failed"));
    } finally {
      setRestoring(false);
    }
  };

  const handleDeliver = async () => {
    if (!commitMessage.trim() || delivering) return;
    setDelivering(true);
    setDeliverResult(null);
    try {
      const chosenFiles =
        selectedDeliverFiles.size > 0 && selectedDeliverFiles.size < files.length
          ? Array.from(selectedDeliverFiles)
          : undefined;
      const res = await api.deliverGitChanges({
        device_id: deviceId,
        cwd: effectiveCwd,
        message: commitMessage.trim(),
        files: chosenFiles,
        push: doPush || doCreatePr,
        create_pr: doCreatePr,
        ...(doCreatePr && prTitle.trim() ? { pr_title: prTitle.trim() } : {}),
        ...(doCreatePr && prBody.trim() ? { pr_body: prBody.trim() } : {}),
        ...(doCreatePr && prBase.trim() ? { pr_base: prBase.trim() } : {}),
      });
      setDeliverResult(res);
      if (res.ok) {
        showInAppToast(isZh ? "Git 交付完成" : "Git delivery succeeded", res.summary || "");
        setCommitMessage("");
        await fetchDiff("", "");
      } else {
        showInAppToast(isZh ? "部分步骤未完成" : "Delivery incomplete", res.error || res.pr_error || "");
      }
    } catch (e: unknown) {
      const msg = formatApiError(e, isZh ? "Git 交付失败" : "Delivery failed");
      setDeliverResult({ ok: false, error: msg });
      showInAppToast(isZh ? "交付失败" : "Delivery failed", msg);
    } finally {
      setDelivering(false);
    }
  };

  if (!open) return null;

  const checkpoints = diffData?.checkpoints || [];
  const recentCommits = diffData?.recent_commits || [];
  const latestCommit = recentCommits[0];

  const selectedScopeValue = (() => {
    if (isCheckpointScope) {
      const cp = checkpoints.find((c) => c.before_ref === baseRef);
      return cp ? `cp:${cp.id}` : "";
    }
    if (targetRef && targetRef !== "WORKING_TREE") {
      const cm = recentCommits.find((c) => c.sha === targetRef);
      return cm ? `commit:${cm.sha}` : "";
    }
    return "";
  })();

  return (
    <div className="fixed inset-0 z-50 flex justify-end overflow-hidden" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/45 backdrop-blur-[2px]"
        onClick={onClose}
      />

      {/* Responsive Slide-Over Panel */}
      <div
        className="relative z-10 w-full max-w-[1060px] h-full flex flex-col border-l border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] shadow-2xl overflow-hidden"
        style={{ maxWidth: "min(1060px, 100vw)" }}
      >
        {/* Top Bar (data-window-controls keeps clear of Windows frameless titlebar buttons; safe-area-inset-top clears iOS notch) */}
        <div
          data-window-controls
          className="px-3 sm:px-5 pb-2.5 min-h-12 border-b border-[var(--aurora-border)] flex flex-wrap items-center justify-between gap-2 shrink-0 bg-[var(--aurora-surface-solid)] app-region-drag"
          style={{ paddingTop: "max(0.625rem, env(safe-area-inset-top, 0px))" }}
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
              style={{
                background: "var(--aurora-accent-soft)",
                border: "1px solid color-mix(in srgb, var(--aurora-accent) 30%, transparent)",
              }}
            >
              <Icon name="code" size={14} style={{ color: "var(--aurora-accent)" }} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="text-[14px] font-semibold text-[var(--aurora-fg1)] truncate">
                  {isZh ? "代码审阅与 Git 交付" : "Diff Review & Git Delivery"}
                </h2>
                {diffData?.branch && (
                  <span
                    className="text-[11px] font-mono px-2 py-0.5 rounded-full shrink-0"
                    style={{
                      background: "var(--aurora-chip)",
                      border: "1px solid var(--aurora-border)",
                      color: "var(--aurora-fg2)",
                    }}
                  >
                    {diffData.branch}
                  </span>
                )}
              </div>
              <div className="text-[11px] text-[var(--aurora-fg3)] truncate font-mono">
                {[deviceName, diffData?.repo_root || effectiveCwd].filter(Boolean).join(" · ")}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0 app-region-no-drag">
            {/* Segmented Tab Switcher */}
            <div
              className="inline-flex items-center p-0.5 rounded-lg border border-[var(--aurora-border)]"
              style={{ background: "var(--aurora-surface-mute)" }}
            >
              <button
                type="button"
                onClick={() => setActiveTab("diff")}
                className="px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors cursor-pointer"
                style={{
                  background: activeTab === "diff" ? "var(--aurora-surface-solid)" : "transparent",
                  color: activeTab === "diff" ? "var(--aurora-fg1)" : "var(--aurora-fg3)",
                  border: "none",
                }}
              >
                {isZh ? "逐行 Diff" : "Diff"}
                {files.length > 0 && (
                  <span className="ml-1 text-[10.5px] tabular-nums opacity-80">{files.length}</span>
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTab("deliver");
                  if (isCheckpointScope || (targetRef && targetRef !== "WORKING_TREE")) {
                    setBaseRef("");
                    setTargetRef("");
                    void fetchDiff("", "");
                  }
                }}
                className="px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors cursor-pointer"
                style={{
                  background: activeTab === "deliver" ? "var(--aurora-surface-solid)" : "transparent",
                  color: activeTab === "deliver" ? "var(--aurora-fg1)" : "var(--aurora-fg3)",
                  border: "none",
                }}
              >
                {isZh ? "提交 / PR" : "Commit / PR"}
              </button>
            </div>

            <Btn
              variant="glass"
              size="sm"
              icon="refresh"
              onClick={() => void fetchDiff(baseRef, targetRef)}
              disabled={loading}
              aria-label={isZh ? "刷新 Diff" : "Refresh"}
            />
            <Btn
              variant="glass"
              size="sm"
              icon="close"
              onClick={onClose}
              aria-label={isZh ? "关闭" : "Close"}
            />
          </div>
        </div>

        {/* Scope & Stats Sub-bar */}
        <div
          className="px-3 sm:px-5 py-2 border-b border-[var(--aurora-border)] flex flex-wrap items-center justify-between gap-2 shrink-0 text-[12px]"
          style={{ background: "var(--aurora-surface-mute)" }}
        >
          <div className="flex items-center gap-2 min-w-0 flex-1 flex-wrap">
            <Icon name="clock" size={13} style={{ color: "var(--aurora-fg3)", flexShrink: 0 }} />
            <select
              value={selectedScopeValue}
              onChange={(e) => handleScopeChange(e.target.value)}
              disabled={loading || activeTab === "deliver"}
              className="text-[12px] font-medium rounded-lg px-2 py-1 border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] text-[var(--aurora-fg1)] outline-none w-full sm:w-auto max-w-full min-w-0 truncate"
            >
              <option value="">
                {isZh ? "当前工作区全部改动（HEAD → 工作区）" : "Working Tree (HEAD → Working Tree)"}
              </option>
              {checkpoints.length > 0 && (
                <optgroup label={isZh ? "回合检查点（支持回滚）" : "Turn Checkpoints (Revertible)"}>
                  {checkpoints.map((cp, idx) => (
                    <option key={cp.id} value={`cp:${cp.id}`}>
                      {isZh
                        ? `回合检查点 #${idx + 1} · ${cp.id.slice(0, 14)}${cp.created_at ? ` (${cp.created_at.slice(5, 16).replace("T", " ")})` : ""}`
                        : `Checkpoint #${idx + 1} · ${cp.id.slice(0, 14)}`}
                    </option>
                  ))}
                </optgroup>
              )}
              {recentCommits.length > 0 && (
                <optgroup label={isZh ? "最近提交记录" : "Recent Commits"}>
                  {recentCommits.map((cm) => (
                    <option key={cm.sha} value={`commit:${cm.sha}`}>
                      {`${cm.short_sha} · ${cm.subject.length > 44 ? `${cm.subject.slice(0, 44)}…` : cm.subject}`}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>

            {isCheckpointScope && activeTab === "diff" && (
              <button
                type="button"
                onClick={() => setConfirmRestore((v) => !v)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11.5px] font-semibold shrink-0 cursor-pointer"
                style={{
                  background: "rgba(217, 119, 6, 0.12)",
                  border: "1px solid rgba(217, 119, 6, 0.35)",
                  color: "#D97706",
                }}
              >
                <Icon name="refresh" size={11.5} />
                <span>{isZh ? "回滚到此回合前" : "Revert Turn"}</span>
              </button>
            )}

            {diffData?.legacy_fallback && (
              <span
                className="text-[11px] px-2 py-0.5 rounded-full shrink-0"
                style={{
                  background: "var(--aurora-chip)",
                  border: "1px solid var(--aurora-border)",
                  color: "var(--aurora-fg3)",
                }}
              >
                {isZh
                  ? `兼容模式（设备 ${diffData.client_version || "旧版"}，升级后开启回合检查点）`
                  : `Compat mode (device ${diffData.client_version || "older"})`}
              </span>
            )}
          </div>

          {diffData?.ok && (
            <div className="flex items-center gap-2.5 text-[11.5px] font-mono shrink-0">
              <span className="text-[var(--aurora-fg3)]">
                {diffData.total_files ?? files.length} {isZh ? "个文件" : "files"}
              </span>
              <span style={{ color: "#10B981", fontWeight: 600 }}>+{diffData.total_additions ?? 0}</span>
              <span style={{ color: "#EF4444", fontWeight: 600 }}>-{diffData.total_deletions ?? 0}</span>
            </div>
          )}
        </div>

        {/* Safe Checkpoint Restore Inline Confirm Bar */}
        {confirmRestore && isCheckpointScope && (
          <div
            className="px-3 sm:px-5 py-2.5 border-b flex flex-wrap items-center justify-between gap-2 shrink-0 text-[12px]"
            style={{
              background: "rgba(217, 119, 6, 0.08)",
              borderColor: "rgba(217, 119, 6, 0.3)",
            }}
          >
            <div className="flex items-center gap-2 text-[var(--aurora-fg1)] min-w-0 flex-1">
              <Icon name="alert" size={14} style={{ color: "#D97706", flexShrink: 0 }} />
              <span className="leading-snug">
                {isZh
                  ? "确认将工作区恢复到此回合执行前的快照？不会改动当前分支与 HEAD，且会自动创建防误操作备份快照。"
                  : "Restore the working tree to before this turn? HEAD and branch stay untouched, and a safety backup ref is created first."}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Btn variant="glass" size="sm" onClick={() => setConfirmRestore(false)} disabled={restoring}>
                {isZh ? "取消" : "Cancel"}
              </Btn>
              <button
                type="button"
                onClick={() => void handleRestoreCheckpoint()}
                disabled={restoring}
                className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white cursor-pointer disabled:opacity-60"
                style={{ background: "#D97706", border: "none" }}
              >
                {restoring ? (isZh ? "回滚中..." : "Restoring...") : isZh ? "确认回滚" : "Confirm Revert"}
              </button>
            </div>
          </div>
        )}

        {/* Body */}
        {loading && !diffData ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-[var(--aurora-fg3)] text-[13px] p-6">
            <Icon name="refresh" size={18} className="animate-spin" style={{ color: "var(--aurora-accent)" }} />
            <span>{isZh ? "正在从设备拉取 Git Diff..." : "Fetching Git diff from device..."}</span>
          </div>
        ) : error ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <Icon name="alert" size={22} style={{ color: "#EF4444" }} />
            <div className="text-[13px] text-[var(--aurora-fg1)] max-w-md">{error}</div>
            <Btn variant="glass" size="sm" icon="refresh" onClick={() => void fetchDiff(baseRef, targetRef)}>
              {isZh ? "重试" : "Retry"}
            </Btn>
          </div>
        ) : activeTab === "diff" ? (
          files.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
              <Icon name="check" size={22} style={{ color: "#10B981" }} />
              <div className="text-[14px] font-semibold text-[var(--aurora-fg1)]">
                {selectedScopeValue
                  ? isZh
                    ? "该范围无文件差异"
                    : "No file changes in this scope"
                  : isZh
                    ? "工作区干净，暂无未提交改动"
                    : "Working tree is clean"}
              </div>
              <div className="text-[12px] text-[var(--aurora-fg3)] max-w-md leading-relaxed">
                {isZh
                  ? "智能体修改代码后会自动在此呈现逐行差异；也可以直接审阅最近一次提交，或在上方下拉框切换任意历史提交 / 回合检查点。"
                  : "Uncommitted agent edits appear here automatically; you can also review the latest commit or pick any commit/checkpoint above."}
              </div>
              {!selectedScopeValue && latestCommit && (
                <Btn
                  variant="primary"
                  size="sm"
                  icon="code"
                  onClick={() => handleScopeChange(`commit:${latestCommit.sha}`)}
                >
                  {isZh
                    ? `查看最近提交 ${latestCommit.short_sha} · ${latestCommit.subject.length > 32 ? `${latestCommit.subject.slice(0, 32)}…` : latestCommit.subject}`
                    : `Review latest commit ${latestCommit.short_sha}`}
                </Btn>
              )}
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
              {/* Mobile horizontal file strip */}
              <div className="md:hidden px-3 py-2 border-b border-[var(--aurora-border)] flex items-center gap-1.5 overflow-x-auto shrink-0">
                {files.map((f) => {
                  const active = f.path === activeFile?.path;
                  const cCount = commentCountByFile.get(f.path) || 0;
                  const shortName = f.path.split("/").pop() || f.path;
                  return (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => setSelectedPath(f.path)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11.5px] font-mono shrink-0 cursor-pointer"
                      style={{
                        background: active ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                        border: `1px solid ${active ? "var(--aurora-accent)" : "var(--aurora-border)"}`,
                        color: active ? "var(--aurora-accent)" : "var(--aurora-fg2)",
                      }}
                    >
                      <span className="max-w-[160px] truncate">{shortName}</span>
                      {cCount > 0 && (
                        <span
                          className="px-1 rounded-full text-[10px] font-bold"
                          style={{ background: "var(--aurora-accent)", color: "#fff" }}
                        >
                          {cCount}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Desktop file list sidebar */}
              <aside className="hidden md:flex flex-col w-64 shrink-0 border-r border-[var(--aurora-border)] overflow-y-auto bg-[var(--aurora-surface-mute)]/50">
                <div className="px-3 py-2 text-[11px] font-semibold text-[var(--aurora-fg3)] border-b border-[var(--aurora-border)]">
                  {isZh ? `变更文件（${files.length}）` : `Changed Files (${files.length})`}
                </div>
                <div className="p-1.5 flex flex-col gap-0.5">
                  {files.map((f) => {
                    const active = f.path === activeFile?.path;
                    const st = STATUS_BADGE[f.status] || STATUS_BADGE.M!;
                    const cCount = commentCountByFile.get(f.path) || 0;
                    const parts = f.path.split("/");
                    const baseName = parts.pop() || f.path;
                    const dirName = parts.join("/");
                    return (
                      <button
                        key={f.path}
                        type="button"
                        onClick={() => setSelectedPath(f.path)}
                        className="w-full text-left px-2.5 py-2 rounded-lg transition-colors cursor-pointer flex flex-col gap-0.5"
                        style={{
                          background: active ? "var(--aurora-accent-soft)" : "transparent",
                          border: active
                            ? "1px solid color-mix(in srgb, var(--aurora-accent) 32%, transparent)"
                            : "1px solid transparent",
                        }}
                      >
                        <div className="flex items-center justify-between gap-1.5 min-w-0">
                          <span
                            className="text-[12px] font-mono font-medium truncate"
                            style={{ color: active ? "var(--aurora-accent)" : "var(--aurora-fg1)" }}
                          >
                            {baseName}
                          </span>
                          <span
                            className="text-[10px] font-semibold px-1.5 py-0.2 rounded shrink-0"
                            style={{ background: st.bg, color: st.color }}
                          >
                            {f.status}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-1 text-[10.5px] font-mono">
                          <span className="text-[var(--aurora-fg4)] truncate">{dirName || "."}</span>
                          <span className="flex items-center gap-1.5 shrink-0">
                            {cCount > 0 && (
                              <span
                                className="px-1 rounded text-[10px] font-bold"
                                style={{ background: "var(--aurora-accent)", color: "#fff" }}
                              >
                                {cCount}
                              </span>
                            )}
                            {f.additions > 0 && <span style={{ color: "#10B981" }}>+{f.additions}</span>}
                            {f.deletions > 0 && <span style={{ color: "#EF4444" }}>-{f.deletions}</span>}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </aside>

              {/* Main Unified Diff Viewer */}
              <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden flex flex-col">
                {activeFile && (
                  <>
                    <div className="px-3 sm:px-4 py-2 border-b border-[var(--aurora-border)] flex flex-wrap items-center justify-between gap-2 bg-[var(--aurora-surface-solid)] sticky top-0 z-10">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <Icon name="file_text" size={13} style={{ color: "var(--aurora-fg3)", flexShrink: 0 }} />
                        <span className="text-[12px] font-mono font-semibold text-[var(--aurora-fg1)] truncate">
                          {activeFile.old_path ? `${activeFile.old_path} → ${activeFile.path}` : activeFile.path}
                        </span>
                      </div>
                      <span className="text-[11px] text-[var(--aurora-fg3)] shrink-0">
                        {isZh ? "点击任意代码行添加行内审阅批注" : "Click any line to add an inline review comment"}
                      </span>
                    </div>

                    {activeFile.binary ? (
                      <div className="p-6 text-[12.5px] text-[var(--aurora-fg3)] text-center">
                        {isZh ? "二进制文件，不支持文本逐行对比。" : "Binary file — line diff unavailable."}
                      </div>
                    ) : activeFile.hunks.length === 0 ? (
                      <div className="p-6 text-[12.5px] text-[var(--aurora-fg3)] text-center">
                        {activeFile.truncated
                          ? isZh
                            ? "文件过大已省略内容展示。"
                            : "File too large to render inline."
                          : isZh
                            ? "空文件或仅权限变更。"
                            : "Empty file or mode-only change."}
                      </div>
                    ) : (
                      <div
                        className="font-mono text-[12px] leading-[1.55]"
                        style={{ paddingBottom: "calc(4.5rem + var(--memento-tabbar-inset, 0px) + env(safe-area-inset-bottom, 0px))" }}
                      >
                        {activeFile.hunks.map((hunk, hIdx) => (
                          <div key={`${activeFile.path}-${hIdx}`} className="border-b border-[var(--aurora-border)]">
                            <div
                              className="px-3 py-1 text-[11px] text-[var(--aurora-fg3)] border-b border-[var(--aurora-border)]/60 overflow-x-auto overscroll-x-contain whitespace-nowrap"
                              style={{ background: "var(--aurora-surface-mute)" }}
                            >
                              {hunk.header}
                            </div>
                            <div className="overflow-x-auto overscroll-x-contain">
                              <div className="min-w-full w-max">
                                {hunk.lines.map((line, lIdx) => {
                                  const anchorLine = line.new_line ?? line.old_line;
                                  const side: "new" | "old" = line.new_line != null ? "new" : "old";
                                  const isDraftTarget =
                                    draftAnchor &&
                                    draftAnchor.path === activeFile.path &&
                                    draftAnchor.line === anchorLine &&
                                    draftAnchor.side === side;
                                  const lineComments = comments.filter(
                                    (c) => c.path === activeFile.path && c.line === anchorLine && c.side === side,
                                  );
                                  const rowBg =
                                    line.type === "add"
                                      ? "rgba(16, 185, 129, 0.11)"
                                      : line.type === "del"
                                        ? "rgba(239, 68, 68, 0.11)"
                                        : "transparent";
                                  const signColor =
                                    line.type === "add"
                                      ? "#10B981"
                                      : line.type === "del"
                                        ? "#EF4444"
                                        : "var(--aurora-fg4)";
                                  return (
                                    <div key={lIdx}>
                                      <div
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => handleLineClick(activeFile.path, line)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            handleLineClick(activeFile.path, line);
                                          }
                                        }}
                                        className="flex items-stretch hover:brightness-95 dark:hover:brightness-110 cursor-pointer group"
                                        style={{ background: rowBg }}
                                      >
                                        <span className="w-8 sm:w-10 px-1 sm:px-1.5 text-right select-none text-[11px] text-[var(--aurora-fg4)] shrink-0 border-r border-[var(--aurora-border)]/40 tabular-nums">
                                          {line.old_line ?? ""}
                                        </span>
                                        <span className="w-8 sm:w-10 px-1 sm:px-1.5 text-right select-none text-[11px] text-[var(--aurora-fg4)] shrink-0 border-r border-[var(--aurora-border)]/40 tabular-nums">
                                          {line.new_line ?? ""}
                                        </span>
                                        <span
                                          className="w-5 text-center select-none font-bold shrink-0"
                                          style={{ color: signColor }}
                                        >
                                          {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
                                        </span>
                                        <span className="flex-1 pr-3 whitespace-pre text-[var(--aurora-fg1)]">
                                          {line.content}
                                        </span>
                                        <span className="px-2 opacity-0 group-hover:opacity-100 text-[10.5px] text-[var(--aurora-accent)] select-none shrink-0 flex items-center">
                                          <Icon name="plus" size={11} />
                                        </span>
                                      </div>

                                      {/* Anchored Existing Comments */}
                                      {lineComments.map((c) => (
                                        <div
                                          key={c.id}
                                          className="mx-3 my-1.5 p-2.5 rounded-lg border flex items-start justify-between gap-2 font-sans text-[12px]"
                                          style={{
                                            background: "var(--aurora-accent-soft)",
                                            borderColor: "color-mix(in srgb, var(--aurora-accent) 35%, transparent)",
                                          }}
                                        >
                                          <div className="min-w-0 flex-1">
                                            <div className="text-[11px] font-mono text-[var(--aurora-accent)] font-semibold mb-0.5">
                                              {c.path}:{c.line}
                                            </div>
                                            <div className="text-[var(--aurora-fg1)] whitespace-pre-wrap break-words">
                                              {c.comment}
                                            </div>
                                          </div>
                                          <button
                                            type="button"
                                            onClick={() => handleDeleteComment(c.id)}
                                            aria-label={isZh ? "删除批注" : "Delete comment"}
                                            className="p-1 rounded hover:bg-black/10 text-[var(--aurora-fg3)] cursor-pointer shrink-0"
                                            style={{ border: "none", background: "transparent" }}
                                          >
                                            <Icon name="trash" size={12} />
                                          </button>
                                        </div>
                                      ))}

                                      {/* Inline Comment Input */}
                                      {isDraftTarget && (
                                        <div
                                          className="mx-3 my-2 p-2.5 rounded-xl border border-[var(--aurora-accent)] bg-[var(--aurora-surface-solid)] font-sans shadow-sm"
                                          onClick={(e) => e.stopPropagation()}
                                        >
                                          <div className="text-[11px] font-mono text-[var(--aurora-accent)] font-semibold mb-1.5">
                                            {isZh
                                              ? `批注 ${draftAnchor.path}:${draftAnchor.line}`
                                              : `Comment on ${draftAnchor.path}:${draftAnchor.line}`}
                                          </div>
                                          <textarea
                                            value={draftText}
                                            onChange={(e) => setDraftText(e.target.value)}
                                            onKeyDown={(e) => {
                                              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                                                e.preventDefault();
                                                handleSaveComment();
                                              }
                                            }}
                                            rows={2}
                                            autoFocus
                                            placeholder={
                                              isZh
                                                ? "写下希望智能体修改的问题或建议（⌘/Ctrl + Enter 保存）"
                                                : "Write review feedback for the agent (Cmd/Ctrl+Enter to save)"
                                            }
                                            className="w-full rounded-lg border border-[var(--aurora-border)] bg-[var(--aurora-surface-mute)] px-2.5 py-1.5 text-[12.5px] text-[var(--aurora-fg1)] outline-none focus:border-[var(--aurora-accent)] resize-y"
                                          />
                                          <div className="mt-2 flex items-center justify-end gap-1.5">
                                            <Btn
                                              variant="glass"
                                              size="sm"
                                              onClick={() => {
                                                setDraftAnchor(null);
                                                setDraftText("");
                                              }}
                                            >
                                              {isZh ? "取消" : "Cancel"}
                                            </Btn>
                                            <Btn
                                              variant="primary"
                                              size="sm"
                                              onClick={handleSaveComment}
                                              disabled={!draftText.trim()}
                                            >
                                              {isZh ? "添加批注" : "Add Comment"}
                                            </Btn>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        ) : (
          /* Tab 2: One-Click Commit / Push / Create PR */
          <div
            className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6"
            style={{ paddingBottom: "calc(2rem + var(--memento-tabbar-inset, 0px) + env(safe-area-inset-bottom, 0px))" }}
          >
            <div className="max-w-2xl mx-auto flex flex-col gap-4">
              {/* File Checklist */}
              <div className="rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-mute)]/50 overflow-hidden">
                <div className="px-3.5 py-2.5 border-b border-[var(--aurora-border)] flex items-center justify-between gap-2">
                  <span className="text-[12.5px] font-semibold text-[var(--aurora-fg1)]">
                    {isZh
                      ? `待提交文件（已选 ${selectedDeliverFiles.size}/${files.length}）`
                      : `Files to Stage (${selectedDeliverFiles.size}/${files.length})`}
                  </span>
                  {files.length > 0 && (
                    <div className="flex items-center gap-2 text-[11.5px]">
                      <button
                        type="button"
                        onClick={() => setSelectedDeliverFiles(new Set(files.map((f) => f.path)))}
                        className="text-[var(--aurora-accent)] cursor-pointer"
                        style={{ border: "none", background: "transparent" }}
                      >
                        {isZh ? "全选" : "All"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedDeliverFiles(new Set())}
                        className="text-[var(--aurora-fg3)] cursor-pointer"
                        style={{ border: "none", background: "transparent" }}
                      >
                        {isZh ? "清空" : "None"}
                      </button>
                    </div>
                  )}
                </div>
                {files.length === 0 ? (
                  <div className="px-3.5 py-4 text-[12px] text-[var(--aurora-fg3)]">
                    {isZh
                      ? "工作区暂无未提交文件；若已有本地提交，可直接勾选下方推送或创建 PR。"
                      : "No uncommitted files; you can still push existing commits or open a PR below."}
                  </div>
                ) : (
                  <div className="max-h-48 overflow-y-auto divide-y divide-[var(--aurora-border)]/50">
                    {files.map((f) => {
                      const checked = selectedDeliverFiles.has(f.path);
                      const st = STATUS_BADGE[f.status] || STATUS_BADGE.M!;
                      return (
                        <label
                          key={f.path}
                          className="px-3.5 py-2 flex items-center gap-2.5 cursor-pointer hover:bg-[var(--aurora-chip)]/50"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setSelectedDeliverFiles((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(f.path);
                                else next.delete(f.path);
                                return next;
                              });
                            }}
                          />
                          <span
                            className="text-[10px] font-semibold px-1.5 py-0.2 rounded shrink-0"
                            style={{ background: st.bg, color: st.color }}
                          >
                            {f.status}
                          </span>
                          <span className="text-[12px] font-mono text-[var(--aurora-fg1)] truncate flex-1">
                            {f.path}
                          </span>
                          <span className="text-[11px] font-mono shrink-0 flex items-center gap-1">
                            <span style={{ color: "#10B981" }}>+{f.additions}</span>
                            <span style={{ color: "#EF4444" }}>-{f.deletions}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Commit Message */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <label className="text-[12.5px] font-semibold text-[var(--aurora-fg1)]">
                    {isZh ? "提交信息（Commit Message）" : "Commit Message"}
                  </label>
                  <div className="flex items-center gap-1 flex-wrap">
                    {COMMIT_PREFIXES.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() =>
                          setCommitMessage((prev) =>
                            prev.startsWith(p) ? prev : `${p} ${prev.replace(/^[a-z]+:\s*/i, "")}`,
                          )
                        }
                        className="px-2 py-0.5 rounded-md text-[11px] font-mono text-[var(--aurora-fg2)] border border-[var(--aurora-border)] bg-[var(--aurora-chip)] hover:border-[var(--aurora-accent)] cursor-pointer"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
                <textarea
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  rows={3}
                  placeholder={isZh ? "例如：feat: 完善行内代码审阅与一键回滚" : "e.g. feat: add inline diff review"}
                  className="w-full rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-mute)] px-3 py-2 text-[13px] text-[var(--aurora-fg1)] outline-none focus:border-[var(--aurora-accent)]"
                />
              </div>

              {/* Push & PR Toggles */}
              <div className="rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-mute)]/50 p-3.5 flex flex-col gap-3">
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <div>
                    <div className="text-[12.5px] font-semibold text-[var(--aurora-fg1)]">
                      {isZh ? "提交后自动推送到远端分支" : "Push to remote after commit"}
                    </div>
                    <div className="text-[11.5px] text-[var(--aurora-fg3)]">
                      {isZh
                        ? `执行 git push -u origin ${diffData?.branch || "当前分支"}`
                        : `Runs git push -u origin ${diffData?.branch || "current branch"}`}
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={doPush || doCreatePr}
                    disabled={doCreatePr}
                    onChange={(e) => setDoPush(e.target.checked)}
                    className="w-4 h-4 accent-[var(--aurora-accent)]"
                  />
                </label>

                <div className="border-t border-[var(--aurora-border)]/70" />

                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <div>
                    <div className="text-[12.5px] font-semibold text-[var(--aurora-fg1)]">
                      {isZh ? "一键创建 GitHub Pull Request" : "Create GitHub Pull Request"}
                    </div>
                    <div className="text-[11.5px] text-[var(--aurora-fg3)]">
                      {isZh
                        ? "自动推送并调用目标设备上的 gh pr create"
                        : "Pushes branch and invokes gh pr create on the device"}
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={doCreatePr}
                    onChange={(e) => {
                      setDoCreatePr(e.target.checked);
                      if (e.target.checked) setDoPush(true);
                    }}
                    className="w-4 h-4 accent-[var(--aurora-accent)]"
                  />
                </label>

                {doCreatePr && (
                  <div className="pt-2 border-t border-[var(--aurora-border)]/70 flex flex-col gap-2.5">
                    <input
                      type="text"
                      value={prTitle}
                      onChange={(e) => setPrTitle(e.target.value)}
                      placeholder={isZh ? "PR 标题（留空默认取提交信息第一行）" : "PR title (defaults to first line of commit message)"}
                      className="w-full rounded-lg border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] px-3 py-1.5 text-[12.5px] text-[var(--aurora-fg1)] outline-none focus:border-[var(--aurora-accent)]"
                    />
                    <input
                      type="text"
                      value={prBase}
                      onChange={(e) => setPrBase(e.target.value)}
                      placeholder={isZh ? "目标基础分支（可选，例如 main）" : "Base branch (optional, e.g. main)"}
                      className="w-full rounded-lg border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] px-3 py-1.5 text-[12.5px] text-[var(--aurora-fg1)] outline-none focus:border-[var(--aurora-accent)]"
                    />
                    <textarea
                      value={prBody}
                      onChange={(e) => setPrBody(e.target.value)}
                      rows={3}
                      placeholder={isZh ? "PR 描述（可选）" : "PR description (optional)"}
                      className="w-full rounded-lg border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] px-3 py-1.5 text-[12.5px] text-[var(--aurora-fg1)] outline-none focus:border-[var(--aurora-accent)]"
                    />
                  </div>
                )}
              </div>

              {/* Action Button */}
              <div className="flex items-center justify-end gap-2">
                <Btn
                  variant="primary"
                  size="md"
                  icon="rocket"
                  disabled={!commitMessage.trim() || delivering}
                  onClick={() => void handleDeliver()}
                >
                  {delivering
                    ? isZh
                      ? "执行中..."
                      : "Running..."
                    : doCreatePr
                      ? isZh
                        ? "提交、推送并创建 PR"
                        : "Commit, Push & Create PR"
                      : doPush
                        ? isZh
                          ? "提交并推送"
                          : "Commit & Push"
                        : isZh
                          ? "立即提交"
                          : "Commit Changes"}
                </Btn>
              </div>

              {/* Delivery Result */}
              {deliverResult && (
                <div
                  className="rounded-xl p-3.5 border flex flex-col gap-2 text-[12.5px]"
                  style={{
                    background: deliverResult.ok ? "rgba(16, 185, 129, 0.08)" : "rgba(239, 68, 68, 0.08)",
                    borderColor: deliverResult.ok ? "rgba(16, 185, 129, 0.35)" : "rgba(239, 68, 68, 0.35)",
                  }}
                >
                  <div className="flex items-center gap-2 font-semibold text-[var(--aurora-fg1)]">
                    <Icon
                      name={deliverResult.ok ? "check" : "alert"}
                      size={14}
                      style={{ color: deliverResult.ok ? "#10B981" : "#EF4444" }}
                    />
                    <span>{deliverResult.summary || (deliverResult.ok ? (isZh ? "执行成功" : "Success") : (isZh ? "执行失败" : "Failed"))}</span>
                  </div>
                  {deliverResult.commit_sha && (
                    <div className="flex items-center gap-2 text-[12px] font-mono text-[var(--aurora-fg2)]">
                      <span>Commit: {deliverResult.commit_sha.slice(0, 10)}</span>
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard?.writeText(deliverResult.commit_sha || "");
                          setCopiedSha(true);
                          setTimeout(() => setCopiedSha(false), 1500);
                        }}
                        className="text-[var(--aurora-accent)] cursor-pointer inline-flex items-center"
                        style={{ border: "none", background: "transparent" }}
                      >
                        <Icon name={copiedSha ? "check" : "copy"} size={12} />
                      </button>
                    </div>
                  )}
                  {deliverResult.pr_url && (
                    <a
                      href={deliverResult.pr_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--aurora-accent)] underline break-all"
                    >
                      <Icon name="external_link" size={12.5} />
                      <span>{deliverResult.pr_url}</span>
                    </a>
                  )}
                  {(deliverResult.error || deliverResult.pr_error) && (
                    <div className="text-[12px] text-[#EF4444] whitespace-pre-wrap break-words">
                      {deliverResult.error || deliverResult.pr_error}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Sticky Inline Review Footer (clears native mobile floating TabBar & iOS home indicator) */}
        {activeTab === "diff" && comments.length > 0 && (
          <div
            className="px-3 sm:px-5 pt-2.5 border-t border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] flex flex-wrap items-center justify-between gap-2 shrink-0"
            style={{ paddingBottom: "calc(max(0.625rem, env(safe-area-inset-bottom, 0px)) + var(--memento-tabbar-inset, 0px))" }}
          >
            <div className="flex items-center gap-2 text-[12.5px] text-[var(--aurora-fg1)]">
              <span
                className="w-5 h-5 rounded-full inline-flex items-center justify-center text-[11px] font-bold text-white"
                style={{ background: "var(--aurora-accent)" }}
              >
                {comments.length}
              </span>
              <span className="font-medium">
                {isZh ? `已添加 ${comments.length} 条逐行审阅批注` : `${comments.length} inline comment(s) ready`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Btn variant="glass" size="sm" onClick={() => setComments([])}>
                {isZh ? "清空" : "Clear"}
              </Btn>
              <Btn variant="primary" size="sm" icon="arrow_right" onClick={handleSendAllComments}>
                {isZh ? `发送 ${comments.length} 条批注给智能体修改` : `Send ${comments.length} comment(s) to Agent`}
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
