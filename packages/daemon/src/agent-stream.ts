/**
 * Turns an agent CLI's JSONL stream into a few event kinds the server and the
 * task card understand:
 *
 *   {kind: session, session_id, model?}
 *   {kind: text, text}                              what the agent says along the way
 *   {kind: tool, id, name, detail, status, output?} status: running | done | failed
 *   {kind: usage, cost_usd?, input_tokens?, output_tokens?, duration_ms?, turns?}
 *   {kind: error, message}
 *
 * Claude Code: `claude -p --output-format stream-json --verbose`.
 * Codex: `codex exec --json`.
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

export abstract class AgentStreamParser {
  sessionId: string | undefined;
  /** Error text reported inside the stream (not on stderr), for retry decisions. */
  errors = "";
  /** Whether the agent spawned background tasks or processes that are still actively running. */
  isStillRunning = false;
  /** Active background task or process IDs detected in the stream. */
  activeBackgroundTasks = new Set<string>();

  /** The agent's final answer, once known. */
  abstract get finalText(): string | undefined;

  /**
   * Events from one stdout line; empty for lines that carry nothing to show.
   * Returns null when the line isn't JSON, so the caller can pass it through.
   */
  abstract feed(line: string): AgentEvent[] | null;

  static forBinary(binary: string): AgentStreamParser | null {
    const b = binary.toLowerCase();
    if (b.includes("claude")) return new ClaudeStreamParser();
    if (b.includes("codex")) return new CodexStreamParser();
    return null;
  }

  protected addError(message: string): void {
    this.errors += `${message}\n`;
  }
}

export class ClaudeStreamParser extends AgentStreamParser {
  private result: string | undefined;
  private readonly texts: string[] = [];
  /** Set by the result event: user messages still waiting to be read. Zero means the run is done and stdin can be closed. */
  queuedTurns: number | undefined;
  finished = false;

  get finalText(): string | undefined {
    return this.result ?? (this.texts.length ? this.texts.join("\n\n") : undefined);
  }

  feed(line: string): AgentEvent[] | null {
    const d = decode(line);
    if (!d) return null;
    const events: AgentEvent[] = [];
    switch (d.type) {
      case "system":
        if (d.subtype === "init" && d.session_id != null) {
          this.sessionId = String(d.session_id);
          events.push({ kind: "session", session_id: this.sessionId, ...(d.model != null ? { model: d.model } : {}) });
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
            } else if (block.type === "tool_use") {
              const name = str(block.name) ?? "tool";
              const input = isObject(block.input) ? block.input : {};
              if (name === "Bash" && input.run_in_background === true) {
                this.isStillRunning = true;
              }
              events.push({
                kind: "tool",
                id: str(block.id),
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
            const bgMatch =
              /Command running in background with ID:\s*([^\s\n\r]+)/i.exec(resText) ??
              /Task running in background with ID:\s*([^\s\n\r]+)/i.exec(resText);
            if (bgMatch && bgMatch[1]) {
              this.activeBackgroundTasks.add(bgMatch[1]);
              this.isStillRunning = true;
            }
            events.push({
              kind: "tool",
              id: str(block.tool_use_id),
              status: block.is_error === true ? "failed" : "done",
              output: clip(resText, 400),
            });
          }
        }
        break;
      }
      case "result": {
        this.finished = true;
        this.queuedTurns = num(d.queued_turn_count) ?? 0;
        if (d.session_id != null) this.sessionId = String(d.session_id);
        if (typeof d.result === "string") this.result = d.result;
        if (this.activeBackgroundTasks.size > 0) {
          this.isStillRunning = true;
        }
        if (d.is_error === true) {
          const message = String(d.result ?? d.subtype ?? "error");
          this.addError(message);
          events.push({ kind: "error", message: clip(message, 400) });
        }
        const usage = isObject(d.usage) ? d.usage : {};
        const input = num(usage.input_tokens);
        events.push({
          kind: "usage",
          ...(num(d.total_cost_usd) !== undefined ? { cost_usd: d.total_cost_usd } : {}),
          ...(input !== undefined
            ? { input_tokens: input + (num(usage.cache_read_input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0) }
            : {}),
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
    default:
      detail = pick(["description", "command", "file_path", "path", "query", "url", "pattern", "prompt"]);
  }
  return clip(firstLine(detail ?? ""), 200);
}

export class CodexStreamParser extends AgentStreamParser {
  private lastMessage: string | undefined;

  get finalText(): string | undefined {
    return this.lastMessage;
  }

  feed(line: string): AgentEvent[] | null {
    const d = decode(line);
    if (!d) return null;
    const events: AgentEvent[] = [];
    const item = isObject(d.item) ? d.item : undefined;
    switch (d.type) {
      case "thread.started":
        this.sessionId = str(d.thread_id);
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
              this.lastMessage = String(item.text);
              events.push({ kind: "text", text: this.lastMessage });
            }
            break;
          case "command_execution": {
            const exit = num(item.exit_code);
            const cmd = str(item.command) ?? "";
            const outText = str(item.aggregated_output) ?? "";
            if (/\b(?:nohup|screen|tmux|daemon)\b|&\s*$/i.test(cmd) || /(?:started in background|running in background)/i.test(outText)) {
              this.isStillRunning = true;
            }
            events.push({
              kind: "tool",
              id: str(item.id),
              name: "Shell",
              detail: clip(firstLine(codexCommand(cmd)), 200),
              status: running(exit !== undefined && exit !== 0),
              ...(done ? { output: clip(outText, 400) } : {}),
            });
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
          case "mcp_tool_call":
            events.push({
              kind: "tool",
              id: str(item.id),
              name: [item.server, item.tool].filter((x) => x != null).join("."),
              detail: "",
              status: running(item.status === "failed"),
            });
            break;
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
        const message = String((isObject(d.error) ? d.error.message : undefined) ?? d.message ?? "error");
        this.addError(message);
        events.push({ kind: "error", message: clip(message, 400) });
        break;
      }
    }
    return events;
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
 */
export class AgentEventLog {
  private readonly rows: AgentEvent[] = [];
  private readonly toolIndex = new Map<string, number>();

  constructor(private readonly limit = 400) {}

  get events(): readonly AgentEvent[] {
    return this.rows;
  }

  /** Adds or merges the event; returns the merged row (what to send live). */
  add(event: AgentEvent): AgentEvent {
    const id = event.kind === "tool" && event.id != null ? String(event.id) : undefined;
    const at = id !== undefined ? this.toolIndex.get(id) : undefined;
    if (at !== undefined) {
      const merged = { ...this.rows[at]!, ...event };
      this.rows[at] = merged;
      return merged;
    }
    const row = { ...event, at: new Date().toISOString() };
    if (this.rows.length < this.limit) {
      if (id !== undefined) this.toolIndex.set(id, this.rows.length);
      this.rows.push(row);
    }
    return row;
  }
}
