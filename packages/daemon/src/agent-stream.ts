/**
 * Turns an agent CLI's JSONL stream into a few event kinds the server and the
 * task card understand:
 *
 *   {kind: session, session_id, model?}
 *   {kind: text, text}                              what the agent says along the way
 *   {kind: tool, id, name, detail, status, output?} status: running | done | failed
 *   {kind: usage, cost_usd?, input_tokens?, cache_read_tokens?, cache_write_tokens?, output_tokens?, duration_ms?, turns?}
 *   {kind: compact, trigger?, pre_tokens?}          Claude Code summarized the context so far
 *   {kind: error, message}
 *
 *   {kind: question, id, tool, header?, question, options, is_multi_select, status: waiting | answered, answer?}
 *
 * Claude Code: `claude -p --output-format stream-json --verbose --permission-prompt-tool stdio`.
 * Codex: `codex exec --json`, or assets/codex_app.mjs, which prints the same lines.
 * Google's Antigravity CLI: `agy -p --output-format stream-json` (AgyCliStreamParser).
 */
export type AgentEvent = Record<string, unknown> & { kind: string };

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (v == null ? undefined : String(v));

function decode(line: string): Json | null {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

/** Most of a tool's output a step keeps: the head plus the tail, where errors and summaries end up. */
export const TOOL_OUTPUT_HEAD = 1200;
export const TOOL_OUTPUT_TAIL = 600;

export function clipOutput(text: string, head = TOOL_OUTPUT_HEAD, tail = TOOL_OUTPUT_TAIL): string {
  const t = text.trim();
  if (t.length <= head + tail + 40) return t;
  const lines = t.slice(head, t.length - tail).split("\n").length - 1;
  return `${t.slice(0, head)}\n… 省略 ${t.length - head - tail} 字${lines > 0 ? `（${lines} 行）` : ""} …\n${t.slice(-tail)}`;
}

/** Keys that say what a tool call is about, in the order they're worth showing. */
const DETAIL_KEYS = [
  "file_path", "notebook_path", "path", "filePath", "file", "target_file", "TargetFile", "AbsolutePath", "Path",
  "command", "cmd", "CommandLine", "url", "Url", "query", "Query", "q", "pattern", "Pattern",
  "description", "task_id", "taskId", "bash_id", "shell_id", "skill", "name", "title", "subject", "prompt", "message",
];

/**
 * A one-line summary of any tool's arguments: the first telling key, else the first short string,
 * else a few key=value pairs. For tools nothing knows by name (MCP and the like).
 */
export function toolArgsDetail(input: Json): string {
  for (const k of DETAIL_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return clip(firstLine(v), 200);
    if (typeof v === "number") return String(v);
  }
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.trim() && v.length <= 200) return clip(firstLine(v), 200);
  }
  const pairs = Object.entries(input)
    .filter(([, v]) => v != null && v !== "" && typeof v !== "object")
    .slice(0, 3)
    .map(([k, v]) => `${k}=${String(v)}`);
  return clip(firstLine(pairs.join(" ")), 200);
}

export abstract class AgentStreamParser {
  sessionId: string | undefined;
  /** Error text reported inside the stream (not on stderr), for retry decisions. */
  errors = "";
  /** Whether the agent spawned background tasks or processes that are still actively running. */
  isStillRunning = false;
  /** Active background task or process IDs detected in the stream. */
  activeBackgroundTasks = new Set<string>();
  /**
   * The stream reports every background task's end, so isStillRunning is the whole answer and the
   * agent's own words ("left it running in the background") mustn't override it (detectStillRunning).
   */
  tracksBackgroundTasks = false;
  /** The model the run uses, as the agent names it when it starts (its default when none was asked for). */
  model = "";

  /** The agent's final answer, once known. */
  abstract get finalText(): string | undefined;

  /**
   * Events from one stdout line; empty for lines that carry nothing to show.
   * Returns null when the line isn't JSON, so the caller can pass it through.
   */
  abstract feed(line: string): AgentEvent[] | null;

  static forBinary(binary: string): AgentStreamParser {
    const b = binary.toLowerCase();
    if (b.includes("claude")) return new ClaudeStreamParser();
    if (b.includes("codex")) return new CodexStreamParser();
    return new UniversalStreamParser();
  }

  protected addError(message: string): void {
    this.errors += `${message}\n`;
  }
}

/** An AskUserQuestion call Claude Code is holding open until the user answers (over its stdio control channel). */
interface PendingAsk {
  requestId: string;
  input: Json;
  questions: Json[];
  answers: Record<string, string>;
}

const allowTool = (requestId: string, updatedInput: Json): Json => ({
  type: "control_response",
  response: { subtype: "success", request_id: requestId, response: { behavior: "allow", updatedInput } },
});

/** Background task states Claude Code reports once a task is over (task_notification / task_updated). */
const TASK_ENDED = new Set(["completed", "failed", "stopped", "killed", "cancelled"]);

export class ClaudeStreamParser extends AgentStreamParser {
  override tracksBackgroundTasks = true;
  private result: string | undefined;
  private readonly texts: string[] = [];
  private readonly asks: PendingAsk[] = [];
  private replies: Json[] = [];
  /** Set by the result event: user messages still waiting to be read. Zero means the run is done and stdin can be closed. */
  queuedTurns: number | undefined;
  finished = false;
  /** The last result was an error (a quota hit, an API error): nothing more comes from this run. */
  resultFailed = false;
  /** The limit that turned a request down (rate_limit_event with status "rejected"): which one, and when it resets (epoch s). */
  rejectedLimit: { type?: string; resetsAt?: number } | undefined;

  get finalText(): string | undefined {
    const combinedTexts = this.texts.map((t) => t.trim()).filter(Boolean).join("\n\n").trim();
    const res = this.result?.trim();
    if (!combinedTexts) return res || undefined;
    if (!res) return combinedTexts;
    if (combinedTexts.includes(res)) return combinedTexts;
    return `${combinedTexts}\n\n${res}`;
  }

  private readonly endedTasks = new Set<string>();
  private readonly taskDescriptions = new Map<string, string>();

  /** What's still running in the background, for the page to say what the run waits on. */
  private backgroundEvent(): AgentEvent {
    return {
      kind: "background",
      tasks: [...this.activeBackgroundTasks].map((id) => {
        const description = this.taskDescriptions.get(id);
        return description ? { id, description } : { id };
      }),
    };
  }

  private startTask(id: string, description: string | undefined): AgentEvent | null {
    if (this.endedTasks.has(id) || this.activeBackgroundTasks.has(id)) return null;
    this.activeBackgroundTasks.add(id);
    if (description) this.taskDescriptions.set(id, clip(description, 160));
    return this.backgroundEvent();
  }

  private endTask(id: string): AgentEvent | null {
    this.endedTasks.add(id);
    if (!this.activeBackgroundTasks.delete(id)) return null;
    // Ended after the answer (it waited on the task): nothing is left running any more
    if (this.finished) this.isStillRunning = this.activeBackgroundTasks.size > 0;
    return this.backgroundEvent();
  }

  /** Control responses for the CLI's stdin, in order; each is handed out once. */
  takeReplies(): Json[] {
    const r = this.replies;
    this.replies = [];
    return r;
  }

  /**
   * The user's answer to one of the questions Claude asked (the oldest open one when no id is given).
   * Returns the events to show, or null when no question is waiting. Once every question of a call has
   * its answer, the reply to the CLI is queued for takeReplies().
   */
  answer(questionId: string | undefined, text: string): AgentEvent[] | null {
    for (const ask of this.asks) {
      // Claude reads the answers keyed by question text
      const key = (i: number) => str(ask.questions[i]!.question) ?? String(i);
      const index = ask.questions.findIndex((_, i) => (!questionId || `${ask.requestId}:${i}` === questionId) && ask.answers[key(i)] === undefined);
      if (index < 0) continue;
      ask.answers[key(index)] = text;
      const events: AgentEvent[] = [{ kind: "question", id: `${ask.requestId}:${index}`, status: "answered", answer: clip(text, 200) }];
      if (Object.keys(ask.answers).length >= ask.questions.length) {
        this.asks.splice(this.asks.indexOf(ask), 1);
        this.replies.push(allowTool(ask.requestId, { ...ask.input, answers: ask.answers }));
      }
      return events;
    }
    return null;
  }

  feed(line: string): AgentEvent[] | null {
    const d = decode(line);
    if (!d) return null;
    const events: AgentEvent[] = [];
    switch (d.type) {
      case "system":
        if (d.subtype === "init" && d.session_id != null) {
          this.sessionId = String(d.session_id);
          if (typeof d.model === "string") this.model = d.model;
          events.push({ kind: "session", session_id: this.sessionId, ...(d.model != null ? { model: d.model } : {}) });
        } else if (d.subtype === "task_started" && d.task_id != null) {
          // Background shells, subagents and the like; each one's end comes as task_notification
          // (or task_updated). A task still open when the agent exits is left running.
          const started = this.startTask(String(d.task_id), str(d.description));
          if (started) events.push(started);
        } else if (d.subtype === "task_notification" && d.task_id != null) {
          const ended = this.endTask(String(d.task_id));
          if (ended) events.push(ended);
        } else if (d.subtype === "task_updated" && d.task_id != null) {
          const patch = isObject(d.patch) ? d.patch : {};
          if (TASK_ENDED.has(String(patch.status ?? "")) || patch.end_time != null) {
            const ended = this.endTask(String(d.task_id));
            if (ended) events.push(ended);
          }
        } else if (d.subtype === "compact_boundary") {
          // Claude Code summarized the conversation so far (auto at the compact window, or /compact)
          const meta = isObject(d.compact_metadata) ? d.compact_metadata : {};
          events.push({
            kind: "compact",
            ...(str(meta.trigger) ? { trigger: str(meta.trigger) } : {}),
            ...(num(meta.pre_tokens) !== undefined ? { pre_tokens: meta.pre_tokens } : {}),
          });
        }
        break;
      case "assistant": {
        const content = isObject(d.message) ? d.message.content : undefined;
        if (Array.isArray(content)) {
          for (const block of content.filter(isObject)) {
            if (block.type === "text" && String(block.text ?? "").trim()) {
              const text = String(block.text);
              this.texts.push(text);
              events.push({ kind: "text", text });
            } else if (block.type === "thinking" && String(block.thinking ?? "").trim()) {
              const thinking = String(block.thinking);
              events.push({ kind: "thinking", text: thinking });
            } else if (block.type === "tool_use") {
              const name = str(block.name) ?? "tool";
              const input = isObject(block.input) ? block.input : {};
              const blockId = str(block.id);
              events.push({
                kind: "tool",
                id: blockId,
                name,
                detail: claudeToolDetail(name, input),
                status: "running",
              });
            }
          }
        }
        break;
      }
      case "user": {
        const content = isObject(d.message) ? d.message.content : undefined;
        if (Array.isArray(content)) {
          for (const block of content.filter(isObject)) {
            if (block.type !== "tool_result") continue;
            const resText = toolResultText(block.content);
            const toolUseId = str(block.tool_use_id);
            const bgMatch =
              // "…with ID: b1x2. Output is being written to …": the id stops before the period
              /Command running in background with ID:\s*([\w-]+)/i.exec(resText) ??
              /Task running in background with ID:\s*([\w-]+)/i.exec(resText);
            // CLIs without task events; with them it's the same id, already counted
            const bgStarted = bgMatch?.[1] ? this.startTask(bgMatch[1], undefined) : null;
            if (bgStarted) events.push(bgStarted);
            events.push({
              kind: "tool",
              id: toolUseId,
              status: block.is_error === true ? "failed" : "done",
              output: clipOutput(resText),
            });
          }
        }
        break;
      }
      case "control_request": {
        // Tools that need the user: AskUserQuestion (answers go back in updatedInput.answers), and any
        // other tool the permission mode leaves to a prompt, which memento's flags would have allowed.
        const req = isObject(d.request) ? d.request : {};
        const requestId = str(d.request_id);
        if (req.subtype !== "can_use_tool" || !requestId) break;
        const input = isObject(req.input) ? req.input : {};
        const questions = req.tool_name === "AskUserQuestion" && Array.isArray(input.questions) ? input.questions.filter(isObject) : [];
        if (!questions.length) {
          this.replies.push(allowTool(requestId, input));
          break;
        }
        this.asks.push({ requestId, input, questions, answers: {} });
        questions.forEach((q, i) => {
          const options = Array.isArray(q.options) ? q.options.filter(isObject) : [];
          events.push({
            kind: "question",
            id: `${requestId}:${i}`,
            tool: "AskUserQuestion",
            ...(q.header != null ? { header: String(q.header) } : {}),
            question: str(q.question) ?? "请选择或确认下一步操作",
            options: options.map((o) => ({ label: String(o.label ?? ""), ...(o.description != null ? { description: String(o.description) } : {}) })),
            is_multi_select: q.multiSelect === true,
            status: "waiting",
          });
        });
        break;
      }
      case "control_cancel_request": {
        const requestId = str(d.request_id);
        const at = this.asks.findIndex((a) => a.requestId === requestId);
        if (at >= 0) {
          const [ask] = this.asks.splice(at, 1);
          ask!.questions.forEach((_, i) => events.push({ kind: "question", id: `${requestId}:${i}`, status: "answered", answer: "（已取消）" }));
        }
        break;
      }
      case "rate_limit_event": {
        const info = isObject(d.rate_limit_info) ? d.rate_limit_info : {};
        if (info.status === "rejected") this.rejectedLimit = { type: str(info.rateLimitType), resetsAt: num(info.resetsAt) };
        break;
      }
      case "result": {
        this.finished = true;
        this.resultFailed = d.is_error === true;
        this.queuedTurns = num(d.queued_turn_count) ?? 0;
        if (d.session_id != null) this.sessionId = String(d.session_id);
        if (typeof d.result === "string") this.result = d.result;
        this.isStillRunning = this.activeBackgroundTasks.size > 0;
        if (d.is_error === true) {
          const message = String(d.result ?? d.subtype ?? "error");
          this.addError(message);
          events.push({ kind: "error", message: clip(message, 400) });
        }
        const usage = isObject(d.usage) ? d.usage : {};
        const input = num(usage.input_tokens);
        const cacheRead = num(usage.cache_read_input_tokens);
        const cacheWrite = num(usage.cache_creation_input_tokens);
        events.push({
          kind: "usage",
          ...(num(d.total_cost_usd) !== undefined ? { cost_usd: d.total_cost_usd } : {}),
          // input_tokens: everything the run's requests read, the cache included; the cache parts separately
          ...(input !== undefined ? { input_tokens: input + (cacheRead ?? 0) + (cacheWrite ?? 0) } : {}),
          ...(cacheRead !== undefined ? { cache_read_tokens: cacheRead } : {}),
          ...(cacheWrite !== undefined ? { cache_write_tokens: cacheWrite } : {}),
          ...(num(usage.output_tokens) !== undefined ? { output_tokens: usage.output_tokens } : {}),
          ...(num(d.duration_ms) !== undefined ? { duration_ms: d.duration_ms } : {}),
          ...(num(d.num_turns) !== undefined ? { turns: d.num_turns } : {}),
        });
        break;
      }
    }
    return events;
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(isObject)
      .filter((b) => b.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("\n");
  }
  return "";
}

/** A one-line description of what a Claude Code tool call does. */
export function claudeToolDetail(name: string, input: Json): string {
  const pick = (keys: string[]) => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    return undefined;
  };
  let detail: string | undefined;
  switch (name) {
    case "Bash":
    case "BashOutput":
      detail = pick(["command", "bash_id"]);
      break;
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      detail = pick(["file_path", "notebook_path"]);
      break;
    case "Grep":
      detail = [pick(["pattern"]), pick(["path"])].filter((x): x is string => !!x).join("  ");
      break;
    case "Glob":
      detail = pick(["pattern"]);
      break;
    case "WebFetch":
      detail = pick(["url"]);
      break;
    case "WebSearch":
      detail = pick(["query"]);
      break;
    case "Task":
    case "Agent":
      detail = pick(["description", "prompt"]);
      break;
    case "TodoWrite":
      detail = Array.isArray(input.todos) ? `${input.todos.length} 项待办` : undefined;
      break;
    case "TaskStop":
    case "TaskOutput":
    case "KillShell":
      detail = pick(["task_id", "shell_id", "bash_id"]);
      break;
    case "ToolSearch":
      detail = pick(["query"]);
      break;
    case "Skill":
      detail = [pick(["skill"]), pick(["args"])].filter((x): x is string => !!x).join("  ");
      break;
    case "AskUserQuestion": {
      const q = Array.isArray(input.questions) ? input.questions.find(isObject) : undefined;
      detail = q ? str(q.question) : undefined;
      break;
    }
    case "Monitor":
      detail = pick(["description", "command"]);
      break;
    default:
      detail = undefined;
  }
  if (!detail) detail = toolArgsDetail(input);
  return clip(firstLine(detail ?? ""), 200);
}

/**
 * Codex passes the API's error body on as the message: `{"type":"error","status":400,"error":{"message":"The
 * 'gpt-6-astra' model is not supported …"}}`. The message inside is what to show.
 */
export function codexErrorText(message: string): string {
  const raw = message.trim();
  if (!raw.startsWith("{")) return message;
  try {
    const body = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown };
    const inner = body?.error?.message ?? body?.message;
    return typeof inner === "string" && inner.trim() ? inner.trim() : message;
  } catch {
    return message;
  }
}

export class CodexStreamParser extends AgentStreamParser {
  private lastError = "";
  private messages: string[] = [];

  get finalText(): string | undefined {
    return this.messages.join("\n\n").trim() || undefined;
  }

  feed(line: string): AgentEvent[] | null {
    const d = decode(line);
    if (!d) return null;
    if (d.type === "memento_event" && isObject(d.event)) return [d.event as AgentEvent];
    const events: AgentEvent[] = [];
    const item = isObject(d.item) ? d.item : undefined;
    switch (d.type) {
      case "thread.started":
        this.sessionId = str(d.thread_id);
        this.model = str(d.model) ?? "";
        if (this.sessionId) events.push({ kind: "session", session_id: this.sessionId });
        break;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        if (!item) break;
        const done = d.type === "item.completed";
        const running = (failed: boolean) => (!done ? "running" : failed ? "failed" : "done");
        switch (item.type) {
          case "agent_message":
            if (done && String(item.text ?? "").trim()) {
              const msg = String(item.text).trim();
              this.messages.push(msg);
              events.push({ kind: "text", text: msg });
            }
            break;
          case "reasoning": {
            const rText = str(item.text) || str(item.summary) || (Array.isArray(item.rawContent) ? item.rawContent.map((c) => isObject(c) ? str(c.text) : "").join("") : "");
            if (rText && rText.trim()) {
              events.push({ kind: "thinking", text: rText.trim() });
            }
            break;
          }
          case "command_execution": {
            const exit = num(item.exit_code);
            const cmd = str(item.command) ?? "";
            const outText = str(item.aggregated_output) ?? "";
            if (/\b(?:nohup|screen|tmux|daemon)\b|&\s*$/i.test(cmd) || /(?:started in background|running in background)/i.test(outText)) {
              this.isStillRunning = true;
            }
            const toolId = str(item.id);
            events.push({
              kind: "tool",
              id: toolId,
              name: "Shell",
              detail: clip(firstLine(codexCommand(cmd)), 200),
              status: running(exit !== undefined && exit !== 0),
              ...(done ? { output: clipOutput(outText) } : {}),
            });

            // Interactive confirmation prompt detection in shell output
            const ynMatch = /(?:^|\s)(?:\[y\/n\]|\[y\/N\]|\[Y\/n\]|\(y\/n\)|\(Y\/N\)|是否继续\?|确认执行\?)/i.exec(outText);
            if (!done && ynMatch) {
              const lastLine = outText.trim().split("\n").pop()?.trim() ?? outText;
              events.push({
                kind: "question",
                id: `cmd_q_${toolId ?? Date.now()}`,
                tool: "confirm",
                question: clip(lastLine, 200),
                options: ["y", "n"],
                is_multi_select: false,
                status: "waiting",
              });
            } else if (done && ynMatch && toolId) {
              events.push({
                kind: "question",
                id: `cmd_q_${toolId}`,
                status: "answered",
              });
            }
            break;
          }
          case "file_change": {
            const changes = Array.isArray(item.changes) ? item.changes.filter(isObject) : [];
            events.push({
              kind: "tool",
              id: str(item.id),
              name: "Edit",
              detail: clip(
                changes
                  .map((c) => str(c.path) ?? "")
                  .filter(Boolean)
                  .join(", "),
                200,
              ),
              status: running(item.status === "failed"),
            });
            break;
          }
          case "mcp_tool_call": {
            const toolName = str(item.tool) ?? "";
            const serverName = str(item.server) ?? "";
            const fullName = [serverName, toolName].filter(Boolean).join(".");
            const args = isObject(item.arguments)
              ? item.arguments
              : isObject(item.input)
              ? item.input
              : typeof item.arguments === "string"
              ? decode(item.arguments) ?? {}
              : {};
            const isQuestion =
              /^(?:ask_question|AskFollowupQuestion|request_user_input|confirm|prompt)$/i.test(toolName) ||
              /question|confirm/i.test(toolName);

            events.push({
              kind: "tool",
              id: str(item.id),
              name: fullName || "tool",
              detail: isQuestion ? clip(str(args.question) || str(args.prompt) || "", 200) : toolArgsDetail(args),
              status: running(item.status === "failed"),
              ...(done && item.result != null ? { output: clipOutput(mcpResultText(item.result)) } : {}),
            });

            if (isQuestion) {
              const qId = str(item.id) ?? `mcp_q_${Date.now()}`;
              if (!done) {
                const qText = str(args.question) || str(args.prompt) || str(args.message) || "请选择或确认下一步操作";
                const qOptions = Array.isArray(args.options) ? args.options : undefined;
                events.push({
                  kind: "question",
                  id: qId,
                  tool: toolName,
                  question: qText,
                  options: qOptions,
                  is_multi_select: Boolean(args.is_multi_select || args.multiple),
                  status: "waiting",
                });
              } else {
                events.push({
                  kind: "question",
                  id: qId,
                  status: "answered",
                  answer: clip(str(item.result) ?? "", 200),
                });
              }
            }
            break;
          }
          case "web_search":
            events.push({
              kind: "tool",
              id: str(item.id),
              name: "WebSearch",
              detail: clip(str(item.query) ?? "", 200),
              status: done ? "done" : "running",
            });
            break;
          case "error":
            if (done) {
              const message = str(item.message) ?? "error";
              this.addError(message);
              events.push({ kind: "error", message: clip(message, 400) });
            }
            break;
        }
        break;
      }
      case "turn.completed": {
        const usage = isObject(d.usage) ? d.usage : {};
        events.push({
          kind: "usage",
          ...(num(usage.input_tokens) !== undefined ? { input_tokens: usage.input_tokens } : {}),
          ...(num(usage.output_tokens) !== undefined ? { output_tokens: usage.output_tokens } : {}),
        });
        break;
      }
      case "turn.failed":
      case "error": {
        const message = codexErrorText(String((isObject(d.error) ? d.error.message : undefined) ?? d.message ?? "error"));
        // Codex sends the same failure as an error and then as turn.failed
        if (message === this.lastError) break;
        this.lastError = message;
        this.addError(message);
        events.push({ kind: "error", message: clip(message, 400) });
        break;
      }
    }
    return events;
  }
}

export class UniversalStreamParser extends AgentStreamParser {
  private lastText = "";
  private plainTexts: string[] = [];
  private lastToolId: string | null = null;
  private toolSeq = 0;

  get finalText(): string | undefined {
    const fromEvents = this.lastText.trim();
    const fromPlain = this.plainTexts.map((t) => t.trim()).filter(Boolean).join("\n\n").trim();
    if (fromEvents && fromPlain) {
      if (fromPlain.includes(fromEvents)) return fromPlain;
      if (fromEvents.includes(fromPlain)) return fromEvents;
      return `${fromPlain}\n\n${fromEvents}`;
    }
    return fromEvents || fromPlain || undefined;
  }

  feed(line: string): AgentEvent[] | null {
    const raw = line.trim();
    if (!raw) {
      this.plainTexts.push("");
      return null;
    }

    const sidMatch =
      /session[ _-]id:\s*([^\s\n\r]+)/i.exec(raw) ??
      /conversation[ _-]id:\s*([^\s\n\r]+)/i.exec(raw) ??
      /thread[ _-]id:\s*([^\s\n\r]+)/i.exec(raw);
    if (sidMatch && sidMatch[1]) {
      this.sessionId = sidMatch[1].trim();
    }

    // 1. Explicit memento structured event line: {"type":"memento_event","event":{...}}
    if (raw.startsWith("{") && raw.endsWith("}")) {
      try {
        const d = JSON.parse(raw) as Json;
        if (isObject(d)) {
          let consumed = false;
          const cid = typeof d.conversation_id === "string" ? d.conversation_id : typeof d.session_id === "string" ? d.session_id : undefined;
          if (cid) {
            this.sessionId = cid.trim();
            consumed = true;
          }
          if (d.type === "memento_event" && isObject(d.event)) {
            const ev = d.event as AgentEvent;
            if (ev.kind === "text" && typeof ev.text === "string") {
              this.lastText += (this.lastText ? "\n\n" : "") + ev.text;
            }
            return [ev];
          }
          if (d.kind === "question" || d.kind === "tool" || d.kind === "steer" || d.kind === "text" || d.kind === "thinking") {
            const ev = d as AgentEvent;
            if (ev.kind === "text" && typeof ev.text === "string") {
              this.lastText += (this.lastText ? "\n\n" : "") + ev.text;
            }
            return [ev];
          }
          if (consumed) return null;
        }
      } catch {
        // Not a JSON event, proceed
      }
    }

    // 2. Action badge pattern emitted by agy_cli / workbuddy: ⚡ [action]
    const toolMatch = /^⚡\s*\[(.*?)\]$/.exec(raw);
    if (toolMatch && toolMatch[1]) {
      const label = toolMatch[1].trim();
      const events: AgentEvent[] = [];
      if (this.lastToolId) {
        events.push({
          kind: "tool",
          id: this.lastToolId,
          status: "done",
        });
      }
      this.lastToolId = `tool_${++this.toolSeq}`;

      let toolName = label;
      let toolDetail = label;
      const colonIdx = label.indexOf(":");
      if (colonIdx > 0 && colonIdx < 30) {
        toolName = label.slice(0, colonIdx).trim();
        toolDetail = label.slice(colonIdx + 1).trim();
        // "Read: Read README.md": the title repeats the tool's name
        if (toolDetail.toLowerCase().startsWith(`${toolName.toLowerCase()} `)) toolDetail = toolDetail.slice(toolName.length + 1).trim();
      }

      events.push({
        kind: "tool",
        id: this.lastToolId,
        name: toolName,
        detail: toolDetail,
        status: "running",
      });
      return events;
    }

    // 3. Question badge: ❓ [question text]
    const qBadge = /^❓\s*\[(.*?)\]$/.exec(raw);
    if (qBadge && qBadge[1]) {
      const qText = qBadge[1].trim();
      return [
        {
          kind: "question",
          id: `q_${++this.toolSeq}`,
          tool: "prompt",
          question: qText,
          status: "waiting",
        },
      ];
    }

    // 4. Interactive CLI confirmation prompt in stdout line: e.g. [y/N], (y/n)
    const ynMatch = /(?:^|\s)(?:\[y\/n\]|\[y\/N\]|\[Y\/n\]|\(y\/n\)|\(Y\/N\)|是否继续\?|确认执行\?)/i.exec(raw);
    if (ynMatch) {
      return [
        {
          kind: "question",
          id: `cli_q_${++this.toolSeq}`,
          tool: "confirm",
          question: raw,
          options: ["y", "n"],
          is_multi_select: false,
          status: "waiting",
        },
      ];
    }

    if (!/^(?:⚡|⏳|⏹️|❓|(?:session|conversation|thread)[ _-]id:)/i.test(raw)) {
      this.plainTexts.push(line);
    }
    return null;
  }
}

/** What an Antigravity tool call works on (the file, the command, the query), for its row in the timeline. */
export function agyToolDetail(name: string, a: Json): string {
  const first = (...keys: string[]): string => {
    for (const k of keys) {
      const v = a[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
    return "";
  };
  const join2 = (x: string, y: string, sep = "  ") => [x, y].filter(Boolean).join(sep);
  let d = "";
  switch (name) {
    case "run_command":
      d = first("CommandLine", "Command");
      break;
    case "command_status":
      d = first("CommandId");
      break;
    case "read_file":
    case "view_file":
    case "view_file_outline":
    case "view_code_item": {
      d = first("Path", "AbsolutePath", "File", "TargetFile");
      const from = first("StartLine");
      const to = first("EndLine");
      if (d && from) d += to ? `:${from}-${to}` : `:${from}`;
      break;
    }
    case "edit_file":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "write_file":
    case "write_to_file":
      d = first("Path", "TargetFile", "AbsolutePath", "File");
      break;
    case "list_dir":
      d = first("DirectoryPath", "Path");
      break;
    case "grep_search":
    case "codebase_search":
      d = join2(first("Query", "Pattern"), first("SearchPath", "SearchDirectory", "Path"));
      break;
    case "find_by_name":
      d = join2(first("Pattern"), first("SearchDirectory", "SearchPath"));
      break;
    case "search_web":
      d = first("query", "Query");
      break;
    case "read_url_content":
    case "view_content_chunk":
      d = first("Url", "url", "DocumentId");
      break;
    case "manage_task":
      d = join2(first("Action"), first("TaskId"), " ");
      break;
    case "schedule": {
      const secs = first("DurationSeconds");
      d = join2(secs ? `${secs}s 后` : "", first("Prompt"), "：");
      break;
    }
    case "invoke_subagent":
      d = join2(first("Role", "TypeName"), first("Prompt"), "：");
      break;
    case "send_message":
      d = join2(first("Recipient"), first("Message"), "：");
      break;
    case "manage_subagents":
      d = first("toolSummary", "Action");
      break;
  }
  if (!d) d = first("toolSummary", "toolAction");
  if (!d) d = toolArgsDetail(a);
  return Array.from(d.split("\n")[0]!.replace(/^["']+|["']+$/g, "")).slice(0, 200).join("");
}

/** A tool step's result as the timeline shows it: without the timestamps and the reminder Antigravity adds for the model. */
export function agyToolOutput(content: string): string {
  return clipOutput(
    content
      .replace(/^(?:Created At|Completed At):[^\n]*\n/gm, "")
      .replace(/\s*If relevant, proactively run terminal commands to execute this code for the USER\. Don't ask for permission\./g, ""),
  );
}

/**
 * Google's own Antigravity CLI in print mode: `agy -p … --output-format stream-json`, used where the
 * Antigravity app isn't running (a server without a desktop). Events, per
 * https://antigravity.google/docs/cli/headless:
 *   {"event":"init","conversation_id":…}
 *   {"event":"step_update","step_update":{step_index, state: ACTIVE|DONE, step_type: agent_response|tool|…,
 *     text_delta?, tool_name?, tool_info?: {name, parameters, output, error?: {type, message}}, subagent_info?}}
 *   {"event":"result","result":{conversation_id, status: SUCCESS|ERROR|…, response, error?, duration_seconds, num_turns, usage}}
 */
export class AgyCliStreamParser extends AgentStreamParser {
  private messages: string[] = [];
  /** agent_response text so far, by step. */
  private deltas = new Map<number, string>();
  private response = "";

  get finalText(): string | undefined {
    return this.response.trim() || this.messages.join("\n\n").trim() || undefined;
  }

  private session(id: unknown): AgentEvent[] {
    const sid = str(id)?.trim();
    if (!sid || sid === this.sessionId) return [];
    this.sessionId = sid;
    return [{ kind: "session", session_id: sid }];
  }

  feed(line: string): AgentEvent[] | null {
    const d = decode(line);
    if (!d || typeof d.event !== "string") return null;
    const events: AgentEvent[] = [];
    if (d.event === "init") {
      if (isObject(d.init)) this.model = str(d.init.model)?.trim() ?? "";
      return this.session(d.conversation_id);
    }
    if (d.event === "step_update" && isObject(d.step_update)) {
      const u = d.step_update;
      events.push(...this.session(u.conversation_id));
      const index = num(u.step_index) ?? -1;
      const done = u.state === "DONE";
      if (u.step_type === "agent_response") {
        const text = (this.deltas.get(index) ?? "") + (str(u.text_delta) ?? "");
        this.deltas.set(index, text);
        if (done) {
          this.deltas.delete(index);
          if (text.trim()) {
            this.messages.push(text.trim());
            events.push({ kind: "text", text: text.trim() });
          }
        }
      } else if (u.step_type === "tool" || isObject(u.tool_info)) {
        const info = isObject(u.tool_info) ? u.tool_info : {};
        const name = str(info.name) || str(u.tool_name) || "tool";
        const failure = isObject(info.error) ? str(info.error.message) || str(info.error.type) || "failed" : undefined;
        const output = [str(info.output) ?? "", failure ?? ""].filter((t) => t.trim()).join("\n");
        events.push({
          kind: "tool",
          id: `agy_step_${index}`,
          name,
          detail: agyToolDetail(name, isObject(info.parameters) ? info.parameters : {}),
          status: !done ? "running" : failure ? "failed" : "done",
          ...(done && output ? { output: agyToolOutput(output) } : {}),
        });
      } else if (isObject(u.subagent_info)) {
        const roles = (Array.isArray(u.subagent_info.subagents) ? u.subagent_info.subagents : [])
          .filter(isObject)
          .map((a) => str(a.role) || str(a.type_name) || "")
          .filter(Boolean);
        events.push({ kind: "tool", id: `agy_step_${index}`, name: "invoke_subagent", detail: clip(roles.join("、"), 200), status: done ? "done" : "running" });
      }
      return events;
    }
    if (d.event === "result" && isObject(d.result)) {
      const r = d.result;
      events.push(...this.session(r.conversation_id));
      const response = str(r.response)?.trim();
      if (response) this.response = response;
      const error = str(r.error)?.trim();
      if (r.status !== "SUCCESS" && error) {
        this.addError(error);
        events.push({ kind: "error", message: clip(error, 2000) });
      }
      const usage = isObject(r.usage) ? r.usage : {};
      const seconds = num(r.duration_seconds);
      // input_tokens already counts the cache reads (input + output = total in the docs' examples), as for Claude
      const counts: Record<string, number | undefined> = {
        input_tokens: num(usage.input_tokens),
        cache_read_tokens: num(usage.cache_read_tokens),
        output_tokens: num(usage.output_tokens),
        duration_ms: seconds !== undefined ? Math.round(seconds * 1000) : undefined,
        turns: num(r.num_turns),
      };
      events.push({ kind: "usage", ...Object.fromEntries(Object.entries(counts).filter(([, v]) => v !== undefined)) });
      return events;
    }
    return events;
  }
}

/** An MCP call's result as text: Codex hands it over as {content: [{type: "text", text}]} or a plain string. */
function mcpResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (isObject(result)) {
    const text = toolResultText(result.content);
    if (text) return text;
    if (isObject(result.Ok)) return mcpResultText(result.Ok);
    if (result.Err != null) return String(result.Err);
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/** "/bin/zsh -lc 'printf hi > a.txt'" -> "printf hi > a.txt". */
export function codexCommand(raw: string): string {
  let cmd = raw.trim().replace(/^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+/, "");
  if (cmd.length >= 2 && ((cmd.startsWith("'") && cmd.endsWith("'")) || (cmd.startsWith('"') && cmd.endsWith('"')))) {
    cmd = cmd.slice(1, -1);
  }
  return cmd;
}

/**
 * Tool events arrive as "running" and then again as "done"; the timeline keeps
 * one row per tool, updated in place. Other events are appended.
 *
 * A long run keeps its latest steps: once the log is full the oldest finished tool rows make room
 * (the beginning of a run is the least useful part to lose the end for), and once the outputs add up
 * to more than outputBudget characters the oldest ones are cut down to their first lines.
 */
export class AgentEventLog {
  private rows: AgentEvent[] = [];
  private readonly toolIndex = new Map<string, number>();
  private readonly questionIndex = new Map<string, number>();
  private outputChars = 0;
  /** Rows let go to make room. */
  dropped = 0;

  constructor(
    private readonly limit = 800,
    private readonly outputBudget = 400_000,
  ) {}

  get events(): readonly AgentEvent[] {
    return this.rows;
  }

  /** Adds or merges the event; returns the merged row (what to send live). */
  add(event: AgentEvent): AgentEvent {
    const isTool = event.kind === "tool" && event.id != null;
    const isQuestion = event.kind === "question" && event.id != null;
    const id = isTool || isQuestion ? String(event.id) : undefined;
    const at = isTool
      ? this.toolIndex.get(id!)
      : isQuestion
      ? this.questionIndex.get(id!)
      : undefined;

    if (at !== undefined) {
      const before = this.rows[at]!;
      const merged = { ...before, ...event };
      this.rows[at] = merged;
      this.outputChars += outputLength(merged) - outputLength(before);
      this.trimOutputs();
      return merged;
    }
    const row = { ...event, at: new Date().toISOString() };
    if (this.rows.length >= this.limit && !this.makeRoom()) return row;
    if (isTool) this.toolIndex.set(id!, this.rows.length);
    if (isQuestion) this.questionIndex.set(id!, this.rows.length);
    this.rows.push(row);
    this.outputChars += outputLength(row);
    this.trimOutputs();
    return row;
  }

  /** Lets go of the oldest finished tool rows (a tenth of the log); false when there's none to let go. */
  private makeRoom(): boolean {
    const want = Math.max(1, Math.floor(this.limit / 10));
    const drop = new Set<number>();
    for (let i = 0; i < this.rows.length && drop.size < want; i++) {
      const r = this.rows[i]!;
      if (r.kind === "tool" && r.status !== "running") drop.add(i);
    }
    if (!drop.size) return false;
    for (const i of drop) this.outputChars -= outputLength(this.rows[i]!);
    this.rows = this.rows.filter((_, i) => !drop.has(i));
    this.dropped += drop.size;
    this.toolIndex.clear();
    this.questionIndex.clear();
    this.rows.forEach((r, i) => {
      if (r.id == null) return;
      if (r.kind === "tool") this.toolIndex.set(String(r.id), i);
      else if (r.kind === "question") this.questionIndex.set(String(r.id), i);
    });
    return true;
  }

  private trimOutputs(): void {
    for (let i = 0; i < this.rows.length && this.outputChars > this.outputBudget; i++) {
      const r = this.rows[i]!;
      const len = outputLength(r);
      if (r.status === "running" || len <= 300) continue;
      const short = clipOutput(String(r.output), 200, 100);
      this.rows[i] = { ...r, output: short };
      this.outputChars -= len - short.length;
    }
  }
}

const outputLength = (row: AgentEvent) => (typeof row.output === "string" ? row.output.length : 0);
