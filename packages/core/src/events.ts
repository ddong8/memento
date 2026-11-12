/** One step of a structured agent run, as reported by the device (see the daemon's agent stream). */
export type TaskToolStatus = "running" | "done" | "failed";

export type TaskEvent = { at?: string } & (
  | { kind: "tool"; id?: string; name?: string; detail?: string; status?: TaskToolStatus; output?: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "session"; session_id: string; model?: string }
  | {
      kind: "usage";
      cost_usd?: number;
      /** Everything the run's requests read, the prompt cache included */
      input_tokens?: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
      output_tokens?: number;
      duration_ms?: number;
      turns?: number;
    }
  | { kind: "error"; message: string }
  /** Claude Code summarized the context so far: auto at the compact window, or a /compact */
  | { kind: "compact"; trigger?: string; pre_tokens?: number }
  /** A follow-up the user sent to a running task: sent, too late, or not supported by that agent. */
  | { kind: "steer"; text: string; status: "sent" | "late" | "unsupported" }
  /** The background tasks (shells, subagents) still running, the whole list each time it changes; the run lasts until they end */
  | { kind: "background"; tasks: Array<{ id: string; description?: string }> }
  | {
      kind: "worktree";
      status: "created" | "kept" | "removed" | "skipped";
      branch?: string;
      path?: string;
      repo?: string;
      commits?: number;
      files?: string[];
      file_count?: number;
      reason?: string;
    }
  /**
   * The code is on another device: synced from it before the run (`syncing` → `synced`), what the
   * agent changed sent back after it (`applied` into its working tree, `conflict` → kept on `branch`,
   * `saved` as a patch only, `pending` until that device is online again, `unchanged`, `failed`).
   * The commits the agent made go back as commits: onto that device's branch (`committed: "branch"`)
   * or kept on `commit_branch`; when the agent pushed, that device pushes them (`push`).
   */
  | {
      kind: "workspace";
      status: "syncing" | "synced" | "applied" | "conflict" | "saved" | "pending" | "unchanged" | "failed";
      source?: string;
      path?: string;
      branch?: string;
      bytes?: number;
      seconds?: number;
      files?: Array<{ path: string; status?: string }>;
      patch_path?: string;
      error?: string;
      commits?: Array<{ sha: string; subject: string }>;
      committed?: "branch" | "kept";
      commit_branch?: string;
      commits_error?: string;
      push?: { status: "pushed" | "rejected" | "failed" | "skipped"; remote?: string; branch?: string; detail?: string; rebased?: number };
    }
  | {
      kind: "question";
      id?: string;
      tool?: string;
      /** Short label for the question (Claude Code's AskUserQuestion, Codex's request_user_input) */
      header?: string;
      question: string;
      options?: Array<TaskQuestionOption | string>;
      is_multi_select?: boolean;
      status?: "waiting" | "answered";
      answer?: string;
    }
);

export interface TaskQuestionOption {
  label: string;
  description?: string;
  value?: string;
}

/** A risky operation the agent performed during a task. */
export interface TaskAlert {
  label?: string;
  detail?: string;
  tool?: string;
}

/** The outcome of a device task (run_on_device). */
export interface TaskResult {
  task_id?: string;
  device_id?: string;
  device_name?: string;
  action?: string;
  status?: string;
  exit_code?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string | null;
  note?: string;
  session_id?: string | null;
  devices?: unknown[];
  alerts?: TaskAlert[];
  events?: TaskEvent[];
}

export interface AskSource {
  document_id?: string;
  title?: string;
  relative_path?: string;
  tool_id?: string;
  score?: number;
  [key: string]: unknown;
}

/** Events of one ask run, in the order the server streams them. */
export type AskStreamEvent =
  | { type: "conversation_id"; id: string; title?: string }
  | { type: "sources"; sources: AskSource[] }
  | { type: "tool_call"; id?: string; tool_call_id?: string; name: string; args?: Record<string, unknown>; device_name?: string }
  | { type: "task_progress"; task_id?: string; tool_call_id?: string; device_name?: string; status?: string }
  | { type: "task_chunk"; task_id?: string; tool_call_id?: string; device_name?: string; stream: "stdout" | "stderr"; text: string }
  | { type: "task_alert"; task_id?: string; tool_call_id?: string; device_name?: string; alert: TaskAlert }
  | { type: "task_event"; task_id?: string; tool_call_id?: string; event: TaskEvent }
  | { type: "tool_result"; task_id?: string; tool_call_id?: string; result: TaskResult }
  | { type: "thinking"; text: string }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "ping" };

/** What POST /api/ask takes. */
export interface AskRequest {
  question: string;
  conversation_id?: string;
  /** Client-generated per send; a retry with the same id attaches to the first attempt's run. */
  request_id?: string;
  history?: { role: "user" | "assistant"; content: string }[];
  device_id?: string;
  cwd?: string;
  agent_mode?: boolean;
  execution_mode?: "ai" | "claude" | "codex" | "antigravity" | "workbuddy" | "shell";
  model?: string;
  effort?: string;
  project_id?: string;
  session_id?: string;
  fork?: boolean;
  compact_mode?: boolean;
  timeout_seconds?: number;
  images?: string[];
  attachments?: Record<string, unknown>[];
  /** Run the agent in its own git worktree and branch. */
  worktree?: boolean;
  /** The device the code is on, when it isn't the one running the agent ("" clears it). */
  source_device_id?: string;
}
