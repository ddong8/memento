"use client";

// Pull requests of the repository the conversation works in, read through the gh CLI signed in on the device:
// list with CI state, then one PR's description, checks, changed lines and comments, with merge (rebase by
// default: the user keeps history linear), "watch CI" (pushes the outcome to the phone) and open on GitHub.
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/aurora/Icon";
import { api, type PullRequestChecks, type PullRequestDetail, type PullRequestSummary } from "@/lib/api-client";
import { formatApiError } from "@/lib/ask/git-review";
import { showInAppToast } from "@/lib/native-notify";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";

type PrState = "open" | "merged" | "closed";

const CHECK_STYLE: Record<PullRequestChecks["state"], { color: string; zh: string; en: string }> = {
  success: { color: "#10B981", zh: "检查通过", en: "Checks passed" },
  failure: { color: "#EF4444", zh: "检查失败", en: "Checks failed" },
  pending: { color: "#D97706", zh: "检查中", en: "Checks running" },
  none: { color: "var(--aurora-fg4)", zh: "无检查", en: "No checks" },
};

export function ChecksBadge({ checks, isZh }: { checks: PullRequestChecks; isZh: boolean }) {
  const st = CHECK_STYLE[checks.state];
  const count = checks.state === "failure" ? checks.failed : checks.state === "pending" ? checks.pending : checks.passed;
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-semibold whitespace-nowrap"
      style={{ color: st.color, background: `color-mix(in srgb, ${st.color} 12%, transparent)` }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 99, background: st.color, flexShrink: 0 }} />
      {isZh ? st.zh : st.en}
      {checks.total > 0 && <span className="tabular-nums opacity-80">{count}/{checks.total}</span>}
    </span>
  );
}

/** `gh pr diff` output with added / removed lines coloured. */
function PatchView({ diff }: { diff: string }) {
  if (!diff.trim()) return null;
  return (
    <pre className="text-[11.5px] leading-[1.55] font-mono overflow-x-auto rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-mute)] p-0 m-0">
      {diff.split("\n").map((line, i) => {
        const tone = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")
          ? { color: "var(--aurora-fg1)", background: "var(--aurora-chip)", fontWeight: 600 }
          : line.startsWith("@@")
            ? { color: "var(--aurora-accent)", background: "transparent" }
            : line.startsWith("+")
              ? { color: "var(--aurora-fg1)", background: "rgba(16,185,129,0.12)" }
              : line.startsWith("-")
                ? { color: "var(--aurora-fg1)", background: "rgba(239,68,68,0.12)" }
                : { color: "var(--aurora-fg2)", background: "transparent" };
        return (
          <div key={i} className="px-3 whitespace-pre" style={tone}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

export function PullRequestsPanel({ deviceId, cwd, isZh }: { deviceId: string; cwd: string; isZh: boolean }) {
  const [state, setState] = useState<PrState>("open");
  const [prs, setPrs] = useState<PullRequestSummary[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<PullRequestDetail | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const [busy, setBusy] = useState<"" | "merge" | "watch">("");

  const load = useCallback(async () => {
    if (!deviceId || !cwd) return;
    setLoading(true);
    setError("");
    try {
      const res = await api.listPullRequests({ device_id: deviceId, cwd, state });
      setPrs(res.prs);
    } catch (e) {
      setError(formatApiError(e, isZh ? "读取 PR 失败" : "Failed to load pull requests"));
      setPrs(null);
    } finally {
      setLoading(false);
    }
  }, [cwd, deviceId, isZh, state]);

  useEffect(() => {
    void load();
  }, [load]);

  const openPr = async (n: number) => {
    setOpening(n);
    try {
      setOpen(await api.getPullRequest({ device_id: deviceId, cwd, number: n }));
    } catch (e) {
      showInAppToast(isZh ? "打不开这个 PR" : "Couldn't open the PR", formatApiError(e, ""));
    } finally {
      setOpening(null);
    }
  };

  const merge = async (method: "rebase" | "squash") => {
    if (!open) return;
    setBusy("merge");
    try {
      await api.mergePullRequest({ device_id: deviceId, cwd, number: open.number, method });
      showInAppToast(isZh ? "已合并" : "Merged", `#${open.number} ${open.title}`);
      setOpen(null);
      void load();
    } catch (e) {
      showInAppToast(isZh ? "合并失败" : "Merge failed", formatApiError(e, ""));
    } finally {
      setBusy("");
    }
  };

  const watch = async () => {
    if (!open) return;
    setBusy("watch");
    try {
      await api.watchPullRequestChecks({ device_id: deviceId, cwd, number: open.number });
      showInAppToast(isZh ? "盯着了" : "Watching", isZh ? "检查跑完会推送到手机" : "You'll get a push when the checks finish");
    } catch (e) {
      showInAppToast(isZh ? "没盯上" : "Couldn't watch", formatApiError(e, ""));
    } finally {
      setBusy("");
    }
  };

  if (open) {
    const canMerge = open.state === "OPEN" && !open.isDraft;
    return (
      <div className="flex flex-col gap-3 p-3 sm:p-4 min-w-0" data-testid="pr-detail">
        <button
          type="button"
          onClick={() => setOpen(null)}
          className="self-start inline-flex items-center gap-1 text-[12px] text-[var(--aurora-fg2)] hover:text-[var(--aurora-accent)] cursor-pointer"
        >
          <Icon name="arrow_left" size={13} />
          {isZh ? "返回 PR 列表" : "All pull requests"}
        </button>
        <div className="flex flex-col gap-1.5 min-w-0">
          <div className="text-[15px] font-semibold text-[var(--aurora-fg1)] leading-snug break-words">
            <span className="text-[var(--aurora-fg3)] font-normal mr-1.5">#{open.number}</span>
            {open.title}
          </div>
          <div className="flex items-center gap-2 flex-wrap text-[11.5px] text-[var(--aurora-fg3)]">
            <span>{open.author}</span>
            <span className="font-mono truncate max-w-full">{open.headRefName} → {open.baseRefName}</span>
            {typeof open.additions === "number" && (
              <span className="tabular-nums">
                <span style={{ color: "#10B981" }}>+{open.additions}</span> <span style={{ color: "#EF4444" }}>-{open.deletions}</span>
              </span>
            )}
            <ChecksBadge checks={open.checks} isZh={isZh} />
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {canMerge && (
            <>
              <button
                type="button"
                disabled={busy !== ""}
                onClick={() => void merge("rebase")}
                className="px-3 py-1.5 rounded-lg text-[12.5px] font-semibold text-white bg-[var(--aurora-accent)] disabled:opacity-60 cursor-pointer"
                title={isZh ? "变基合并，保持历史线性" : "Rebase and merge (linear history)"}
              >
                {busy === "merge" ? (isZh ? "合并中…" : "Merging…") : isZh ? "变基合并" : "Rebase & merge"}
              </button>
              <button
                type="button"
                disabled={busy !== ""}
                onClick={() => void merge("squash")}
                className="px-3 py-1.5 rounded-lg text-[12.5px] font-medium text-[var(--aurora-fg1)] border border-[var(--aurora-border)] bg-[var(--aurora-chip)] disabled:opacity-60 cursor-pointer"
              >
                {isZh ? "压成一个提交合并" : "Squash & merge"}
              </button>
            </>
          )}
          {open.checks.state === "pending" && (
            <button
              type="button"
              disabled={busy !== ""}
              onClick={() => void watch()}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12.5px] font-medium text-[var(--aurora-accent)] border border-[var(--aurora-accent)]/40 bg-[var(--aurora-accent-soft)] disabled:opacity-60 cursor-pointer"
            >
              <Icon name="eye" size={13} />
              {isZh ? "盯 CI，跑完推送" : "Watch CI"}
            </button>
          )}
          <a
            href={open.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12.5px] text-[var(--aurora-fg2)] border border-[var(--aurora-border)] hover:text-[var(--aurora-accent)]"
          >
            <Icon name="external_link" size={12} />
            GitHub
          </a>
        </div>

        {open.check_runs.length > 0 && (
          <div className="rounded-xl border border-[var(--aurora-border)] divide-y divide-[var(--aurora-border)]">
            {open.check_runs.map((c, i) => {
              const done = !c.status || c.status.toUpperCase() === "COMPLETED";
              const ok = ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion.toUpperCase());
              const color = !done ? "#D97706" : ok ? "#10B981" : "#EF4444";
              return (
                <a key={i} href={c.url || undefined} target="_blank" rel="noreferrer" className="flex items-center gap-2 px-3 py-2 text-[12px] text-[var(--aurora-fg2)] min-w-0">
                  <span style={{ width: 7, height: 7, borderRadius: 99, background: color, flexShrink: 0 }} />
                  <span className="truncate flex-1 min-w-0">{c.name}</span>
                  <span className="text-[11px] shrink-0" style={{ color }}>
                    {!done ? (isZh ? "进行中" : "running") : ok ? (isZh ? "通过" : "passed") : isZh ? "失败" : "failed"}
                  </span>
                </a>
              );
            })}
          </div>
        )}

        {open.body?.trim() && (
          <div className="prose prose-sm max-w-none rounded-xl border border-[var(--aurora-border)] p-3 text-[13px]">
            <MarkdownViewer content={open.body} compactText={true} />
          </div>
        )}

        <PatchView diff={open.diff} />
        {open.diff_truncated && <div className="text-[11.5px] text-[var(--aurora-fg3)]">{isZh ? "改动太大，只显示了前一部分，完整内容在 GitHub 上看" : "Diff truncated; see GitHub for the rest"}</div>}

        {(open.comments || []).length > 0 && (
          <div className="flex flex-col gap-2">
            {(open.comments || []).map((c, i) => (
              <div key={i} className="rounded-xl border border-[var(--aurora-border)] p-3 text-[12.5px]">
                <div className="text-[11.5px] font-semibold text-[var(--aurora-fg2)] mb-1">{c.author?.login || ""}</div>
                <MarkdownViewer content={c.body || ""} compactText={true} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3 sm:p-4 min-w-0" data-testid="pr-list">
      <div className="flex items-center gap-1">
        {(["open", "merged", "closed"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setState(s)}
            className="px-2.5 py-1 rounded-md text-[12px] font-medium cursor-pointer"
            style={{
              background: state === s ? "var(--aurora-accent-soft)" : "transparent",
              color: state === s ? "var(--aurora-accent)" : "var(--aurora-fg3)",
            }}
          >
            {isZh ? { open: "进行中", merged: "已合并", closed: "已关闭" }[s] : s}
          </button>
        ))}
        <button type="button" onClick={() => void load()} className="ml-auto p-1 text-[var(--aurora-fg3)] hover:text-[var(--aurora-accent)] cursor-pointer" title={isZh ? "刷新" : "Refresh"}>
          <Icon name="refresh" size={14} />
        </button>
      </div>

      {loading && !prs && <div className="text-[12.5px] text-[var(--aurora-fg3)] py-6 text-center">{isZh ? "正在从设备读取…" : "Loading from the device…"}</div>}
      {error && <div className="text-[12.5px] text-[#EF4444] rounded-xl border border-[#EF4444]/30 bg-[#EF4444]/5 p-3 break-words">{error}</div>}
      {prs && prs.length === 0 && !error && (
        <div className="text-[12.5px] text-[var(--aurora-fg3)] py-6 text-center">{isZh ? "没有 PR" : "No pull requests"}</div>
      )}

      {prs && prs.length > 0 && (
        <div className="rounded-xl border border-[var(--aurora-border)] divide-y divide-[var(--aurora-border)] overflow-hidden">
          {prs.map((pr) => (
            <button
              key={pr.number}
              type="button"
              onClick={() => void openPr(pr.number)}
              className="w-full text-left px-3 py-2.5 hover:bg-[var(--aurora-chip)] cursor-pointer flex flex-col gap-1 min-w-0"
              style={{ opacity: opening != null && opening !== pr.number ? 0.6 : 1 }}
            >
              <div className="flex items-start gap-2 min-w-0">
                <span className="text-[12px] text-[var(--aurora-fg3)] tabular-nums shrink-0 pt-px">#{pr.number}</span>
                <span className="text-[13px] font-medium text-[var(--aurora-fg1)] leading-snug break-words flex-1 min-w-0">
                  {pr.isDraft && <span className="text-[11px] text-[var(--aurora-fg3)] mr-1">{isZh ? "[草稿]" : "[Draft]"}</span>}
                  {pr.title}
                </span>
                {opening === pr.number && <span className="text-[11px] text-[var(--aurora-fg3)] shrink-0">{isZh ? "打开中…" : "Opening…"}</span>}
              </div>
              <div className="flex items-center gap-2 flex-wrap text-[11px] text-[var(--aurora-fg3)] pl-7">
                <span>{pr.author}</span>
                <span className="font-mono truncate max-w-[180px]">{pr.headRefName}</span>
                <ChecksBadge checks={pr.checks} isZh={isZh} />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
