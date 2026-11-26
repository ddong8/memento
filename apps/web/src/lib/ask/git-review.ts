/**
 * Shared helpers & event contracts for inline Git Diff Review, Turn Checkpoints,
 * and explicit Cross-Agent Handoff inside /ask.
 */

export const GIT_DIFF_OPEN_EVENT = "memento_open_git_diff";

export interface OpenGitDiffEventDetail {
  repoRoot?: string;
  baseRef?: string;
  targetRef?: string;
  checkpointId?: string;
  branch?: string;
  mode?: "diff" | "restore";
  /** Tab to open on (keyboard: ⌘J opens the terminal) */
  tab?: "diff" | "deliver" | "pr" | "terminal";
}

export interface InlineDiffComment {
  id: string;
  path: string;
  line: number;
  side: "new" | "old";
  lineText: string;
  comment: string;
}

export interface HandoffModeOption {
  id: "claude" | "codex" | "antigravity" | "workbuddy" | "ai";
  label: string;
  enLabel: string;
  brandId?: "claude_code" | "codex" | "antigravity" | "workbuddy";
  accent: string;
  descZh: string;
  descEn: string;
}

export const HANDOFF_MODE_OPTIONS: HandoffModeOption[] = [
  {
    id: "claude",
    label: "Claude Code",
    enLabel: "Claude Code",
    brandId: "claude_code",
    accent: "#D97757",
    descZh: "深度重构、架构分析与长链路修改",
    descEn: "Deep refactoring & architecture work",
  },
  {
    id: "codex",
    label: "Codex",
    enLabel: "Codex",
    brandId: "codex",
    accent: "#10A37F",
    descZh: "精准补丁、严格 Code Review 与单测验证",
    descEn: "Targeted patches, review & tests",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    enLabel: "Antigravity",
    brandId: "antigravity",
    accent: "#3186FF",
    descZh: "多模态推理、全栈实现与端到端排查",
    descEn: "Full-stack implementation & debugging",
  },
  {
    id: "workbuddy",
    label: "WorkBuddy",
    enLabel: "WorkBuddy",
    brandId: "workbuddy",
    accent: "#0EC7A8",
    descZh: "桌面协同与工具链路执行",
    descEn: "Desktop & workflow automation",
  },
  {
    id: "ai",
    label: "AI 编排",
    enLabel: "AI Orchestrator",
    accent: "#6366F1",
    descZh: "跨设备调度与全量记忆工具编排",
    descEn: "Cross-device & memory orchestration",
  },
];

export function handoffModeLabel(mode: string | undefined, isZh = true): string {
  const hit = HANDOFF_MODE_OPTIONS.find((m) => m.id === (mode || "").toLowerCase());
  if (hit) return isZh ? hit.label : hit.enLabel;
  return mode || (isZh ? "AI 编排" : "AI");
}

export function dispatchOpenGitDiff(detail: OpenGitDiffEventDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OpenGitDiffEventDetail>(GIT_DIFF_OPEN_EVENT, { detail }));
}

/**
 * Unwraps FastAPI error strings like `API 504: {"detail":"..."}` into clean human-readable text.
 */
export function formatApiError(err: unknown, fallback = "请求失败，请稍后重试"): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const match = /^API\s+\d+:\s*([\s\S]+)$/.exec(trimmed);
  const body = match ? match[1]!.trim() : trimmed;
  if (body.startsWith("{")) {
    try {
      const parsed = JSON.parse(body) as { detail?: unknown; error?: unknown; message?: unknown };
      const msg = parsed.detail ?? parsed.error ?? parsed.message;
      if (typeof msg === "string" && msg.trim()) return msg.trim();
      if (Array.isArray(msg) && msg.length > 0) {
        const first = msg[0] as { msg?: unknown };
        if (typeof first?.msg === "string" && first.msg.trim()) return first.msg.trim();
      }
    } catch {
      // fall through to cleaned string
    }
  }
  return body || fallback;
}

/**
 * Formats anchored inline diff review comments (`file:line`) into a clean,
 * structured prompt that any coding agent can apply directly.
 */
export function formatInlineReviewPrompt(
  comments: readonly InlineDiffComment[],
  opts?: { branch?: string; baseRef?: string; targetRef?: string; isZh?: boolean },
): string {
  const valid = comments.filter((c) => c.path.trim() && c.comment.trim());
  if (valid.length === 0) return "";
  const isZh = opts?.isZh ?? true;
  const scope =
    opts?.baseRef && opts?.targetRef && opts.targetRef !== "WORKING_TREE"
      ? `${opts.baseRef} -> ${opts.targetRef}`
      : opts?.branch
        ? `分支 ${opts.branch} 当前工作区`
        : "当前工作区";

  const lines: string[] = isZh
    ? [
        `请根据以下 ${valid.length} 条逐行代码审阅意见直接修改代码（范围：${scope}）：`,
        "",
      ]
    : [
        `Please update the code according to the following ${valid.length} inline diff review comments (scope: ${scope}):`,
        "",
      ];

  valid.forEach((c, idx) => {
    const sideTag = c.side === "old" ? (isZh ? "旧行" : "old line") : (isZh ? "行" : "line");
    const snippet = c.lineText.trim().slice(0, 140);
    lines.push(`${idx + 1}) ${c.path}:${c.line}（${sideTag}）`);
    if (snippet) {
      lines.push(`   代码片段：\`${snippet.replace(/`/g, "'")}\``);
    }
    lines.push(`   ${isZh ? "修改意见" : "Comment"}：${c.comment.trim()}`);
  });

  lines.push("");
  lines.push(
    isZh
      ? "改完后请简述每条意见的修改位置并跑相关检查确认无误。"
      : "After applying all changes, briefly summarize each edit and run relevant checks.",
  );
  return lines.join("\n");
}
