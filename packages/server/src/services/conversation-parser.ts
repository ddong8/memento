// Unified conversation parser for Claude Code, WorkBuddy, Codex, OpenClaw, Antigravity, Cursor, Hermes
// (server/server/services/conversation_parser.py).
import { createHash } from "node:crypto";

export interface NormalizedMessage {
  role: string; // "user" | "assistant" | "system" | "tool"
  content: string;
  toolName: string;
  toolInput: string;
  thinking: string;
  status: string;
  exitCode: number | null;
  error: string;
  timestamp: string;
  rawType: string;
}

export interface StoredMessage {
  messageType: string;
  role: string;
  content: string;
  metadata: Record<string, unknown>;
  timestamp: Date | null;
  key: string;
  loose: string | null;
}

export const STORED_ROLES = new Set(["user", "assistant", "tool", "system"]);

const SYSTEM_TAGS =
  "ide_opened_file|ide_selection|system-reminder|" +
  "user-prompt-submit-hook|task-notification|" +
  "command-message|command-name|skill-format|total_tokens|" +
  "local-command-stdout|local-command-stderr|local-command-caveat";
const SYSTEM_TAG_RE = new RegExp(`<(?:${SYSTEM_TAGS})[^>]*>[\\s\\S]*?<\\/(?:${SYSTEM_TAGS})>`, "g");
const SYSTEM_LINE_RE = /Read the output file to retrieve the result:\s*\/\S+\.output\b/g;

function stripSystemTags(text: string): string {
  return text.replace(SYSTEM_TAG_RE, "").replace(SYSTEM_LINE_RE, "").trim();
}

/** Python json.dumps(obj, ensure_ascii=False) format (", " and ": ") so row_key matches rows Python stored. */
function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => pyJsonDumps(v)).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${JSON.stringify(k)}: ${pyJsonDumps(v)}`);
    return `{${entries.join(", ")}}`;
  }
  return JSON.stringify(String(value));
}

function extractThinkingParts(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (rec.type === "thinking" && typeof rec.thinking === "string" && rec.thinking) {
      parts.push(rec.thinking);
    } else if (rec.type === "redacted_thinking" && typeof rec.data === "string" && rec.data) {
      parts.push(`[redacted thinking: ${rec.data.length} bytes]`);
    }
  }
  return parts.join("\n\n");
}

function extractContent(content: unknown): string {
  if (typeof content === "string") return stripSystemTags(content);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const rec = item as Record<string, unknown>;
        const t = rec.type;
        if (t === "text") {
          parts.push(typeof rec.text === "string" ? rec.text : "");
        } else if (t === "tool_use" || t === "toolCall") {
          const name = typeof rec.name === "string" && rec.name ? rec.name : "tool";
          const inp = "input" in rec ? rec.input : (rec.arguments ?? {});
          const inpStr = typeof inp === "string" ? inp : pyJsonDumps(inp);
          parts.push(`[Tool: ${name}]\n${inpStr}`);
        } else if (t === "tool_result" || t === "toolResult") {
          let result: unknown = "content" in rec ? rec.content : (rec.output ?? "");
          if (Array.isArray(result)) {
            result = result
              .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r))
              .map((r) => (typeof r.text === "string" ? r.text : ""))
              .join(" ");
          }
          parts.push(`[Result]\n${String(result ?? "")}`);
        }
      } else if (typeof item === "string") {
        parts.push(item);
      }
    }
    return stripSystemTags(parts.join("\n"));
  }
  if (content && typeof content === "object") {
    const rec = content as Record<string, unknown>;
    return typeof rec.text === "string" ? rec.text : pyJsonDumps(rec);
  }
  return String(content ?? "");
}

function extractCodexContent(contentList: unknown): string {
  if (typeof contentList === "string") return contentList;
  if (!Array.isArray(contentList)) return String(contentList ?? "");
  const parts: string[] = [];
  for (const item of contentList) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const text = (item as Record<string, unknown>).text;
      parts.push(typeof text === "string" ? text : "");
    } else if (typeof item === "string") {
      parts.push(item);
    }
  }
  return parts.join("\n");
}

/** Safe parser for Python dict/list/string/number/bool/None literals (OpenClaw repr strings, no eval). */
function parsePythonLiteral(src: string): unknown {
  let i = 0;
  const n = src.length;
  const skip = () => {
    while (i < n && (src[i] === " " || src[i] === "\t" || src[i] === "\r" || src[i] === "\n")) i++;
  };
  const parseStr = (): string => {
    const q = src[i++]!;
    let out = "";
    while (i < n) {
      const ch = src[i++]!;
      if (ch === q) return out;
      if (ch === "\\") {
        if (i >= n) throw new Error("eof");
        const esc = src[i++]!;
        if (esc === "n") out += "\n";
        else if (esc === "r") out += "\r";
        else if (esc === "t") out += "\t";
        else if (esc === "\\" || esc === "'" || esc === '"') out += esc;
        else if (esc === "u") {
          const hex = src.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("bad \\u");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else if (esc === "x") {
          const hex = src.slice(i, i + 2);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error("bad \\x");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 2;
        } else out += `\\${esc}`;
      } else {
        out += ch;
      }
    }
    throw new Error("unterminated string");
  };
  const parseVal = (depth: number): unknown => {
    if (depth > 40) throw new Error("too deep");
    skip();
    if (i >= n) throw new Error("eof");
    const ch = src[i]!;
    if (ch === "'" || ch === '"') return parseStr();
    if (ch === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      skip();
      if (src[i] === "}") {
        i++;
        return obj;
      }
      while (i < n) {
        const k = parseVal(depth + 1);
        skip();
        if (src[i] !== ":") throw new Error("expected :");
        i++;
        const v = parseVal(depth + 1);
        obj[String(k)] = v;
        skip();
        if (src[i] === ",") {
          i++;
          skip();
          if (src[i] === "}") {
            i++;
            return obj;
          }
        } else if (src[i] === "}") {
          i++;
          return obj;
        } else throw new Error("expected , or }");
      }
      throw new Error("unterminated {");
    }
    if (ch === "[" || ch === "(") {
      const close = ch === "[" ? "]" : ")";
      i++;
      const arr: unknown[] = [];
      skip();
      if (src[i] === close) {
        i++;
        return arr;
      }
      while (i < n) {
        arr.push(parseVal(depth + 1));
        skip();
        if (src[i] === ",") {
          i++;
          skip();
          if (src[i] === close) {
            i++;
            return arr;
          }
        } else if (src[i] === close) {
          i++;
          return arr;
        } else throw new Error("expected , or ]");
      }
      throw new Error("unterminated [");
    }
    if (src.startsWith("True", i)) {
      i += 4;
      return true;
    }
    if (src.startsWith("False", i)) {
      i += 5;
      return false;
    }
    if (src.startsWith("None", i)) {
      i += 4;
      return null;
    }
    const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (m) {
      i += m[0].length;
      return Number(m[0]);
    }
    throw new Error(`unexpected token at ${i}`);
  };
  const res = parseVal(0);
  skip();
  if (i !== n) throw new Error("trailing");
  return res;
}

function makeMsg(partial: Partial<NormalizedMessage> & { role: string; content: string }): NormalizedMessage {
  return {
    toolName: "",
    toolInput: "",
    thinking: "",
    status: "",
    exitCode: null,
    error: "",
    timestamp: "",
    rawType: "",
    ...partial,
  };
}

/** Parse a single JSON object (or JSON line) into a NormalizedMessage, or null to skip. */
export function parseConversationObject(obj: Record<string, unknown>, toolId: string): NormalizedMessage | null {
  const msgType = typeof obj.type === "string" ? obj.type : "";
  const rawTs = obj.timestamp;
  let timestamp = "";
  if (typeof rawTs === "number" && rawTs > 0) {
    const ms = rawTs > 1e11 ? rawTs : rawTs * 1000;
    timestamp = new Date(ms).toISOString().replace("Z", "+00:00");
  } else if (rawTs !== undefined && rawTs !== null) {
    timestamp = String(rawTs);
  }

  // --- Claude Code ---
  if (toolId === "claude_code") {
    if (obj.isMeta || obj.isCompactSummary) return null;
    if (msgType === "user" || msgType === "assistant") {
      const message = obj.message && typeof obj.message === "object" && !Array.isArray(obj.message) ? (obj.message as Record<string, unknown>) : {};
      const role = typeof message.role === "string" ? message.role : msgType;
      const rawContent = message.content ?? "";

      if (typeof rawContent === "string") {
        const content = stripSystemTags(rawContent);
        if (content.includes("<command-name>") || content.includes("<command-message>")) return null;
        if (!content.trim()) return null;
        return makeMsg({ role, content, timestamp, rawType: msgType });
      }

      if (Array.isArray(rawContent)) {
        let thinking = extractThinkingParts(rawContent);
        const textBlocks = rawContent
          .filter((b): b is Record<string, unknown> => !!b && typeof b === "object" && !Array.isArray(b) && (b as Record<string, unknown>).type === "text")
          .map((b) => (typeof b.text === "string" ? b.text : ""));
        let textContent = stripSystemTags(textBlocks.join("\n"));
        const toolUses = rawContent.filter(
          (b): b is Record<string, unknown> =>
            !!b && typeof b === "object" && !Array.isArray(b) && (b.type === "tool_use" || b.type === "toolCall"),
        );
        const toolResults = rawContent.filter(
          (b): b is Record<string, unknown> =>
            !!b && typeof b === "object" && !Array.isArray(b) && (b.type === "tool_result" || b.type === "toolResult"),
        );

        if (toolResults.length && !textContent.trim()) {
          const b = toolResults[0]!;
          let out: unknown = "content" in b ? b.content : (b.output ?? "");
          if (Array.isArray(out)) {
            out = out.map((r) => (r && typeof r === "object" && !Array.isArray(r) ? String((r as Record<string, unknown>).text ?? "") : String(r))).join("\n");
          }
          const isErr = b.is_error === true;
          const outStr = String(out ?? "");
          return makeMsg({
            role: "tool",
            content: outStr,
            status: isErr ? "failed" : "succeeded",
            exitCode: isErr ? 1 : 0,
            error: isErr ? outStr.slice(0, 400) : "",
            timestamp,
            rawType: "tool_output",
          });
        }

        if (toolUses.length) {
          const b = toolUses[0]!;
          const name = typeof b.name === "string" && b.name ? b.name : "tool";
          const inp = "input" in b ? b.input : (b.arguments ?? {});
          let toolInput: string;
          if (inp && typeof inp === "object" && !Array.isArray(inp)) {
            const rec = inp as Record<string, unknown>;
            if (name === "Bash" && "command" in rec) toolInput = String(rec.command ?? "");
            else if ("path" in rec) toolInput = String(rec.path ?? "");
            else if ("file_path" in rec) toolInput = String(rec.file_path ?? "");
            else toolInput = pyJsonDumps(rec);
          } else if (typeof inp === "string") {
            toolInput = inp;
          } else {
            toolInput = String(inp ?? "");
          }
          if (textContent.trim()) {
            return makeMsg({
              role: "assistant",
              content: textContent,
              thinking,
              toolName: name,
              toolInput,
              status: "running",
              timestamp,
              rawType: msgType,
            });
          }
          return makeMsg({
            role: "tool",
            content: `[${name}]`,
            toolName: name,
            toolInput,
            thinking,
            status: "running",
            timestamp,
            rawType: "tool_call",
          });
        }

        if (!textContent.trim() && !thinking.trim()) return null;
        if (!textContent.trim()) {
          textContent = thinking;
          thinking = "";
        }
        return makeMsg({ role, content: textContent, thinking, timestamp, rawType: msgType });
      }
    }
    if (msgType === "ai-title") return null;
    if (msgType === "system") {
      const msg = obj.message && typeof obj.message === "object" ? (obj.message as Record<string, unknown>) : {};
      const content = extractContent(msg.content ?? "");
      if (!content.trim() || content.includes("<command-name>") || content.includes("<command-message>")) return null;
      return makeMsg({ role: "system", content, timestamp, rawType: msgType });
    }
    return null;
  }

  // --- WorkBuddy ---
  if (toolId === "workbuddy") {
    if (obj.isMeta) return null;
    if (msgType === "message") {
      const nested = obj.message && typeof obj.message === "object" && !Array.isArray(obj.message) ? (obj.message as Record<string, unknown>) : {};
      const role = String(obj.role || nested.role || "user");
      const rawContent = "content" in obj ? obj.content : (nested.content ?? "");
      let text = stripSystemTags(extractCodexContent(rawContent));
      if (text) text = text.replaceAll("<user_query>", "").replaceAll("</user_query>", "").trim();
      if (!text) return null;
      if (role === "user" || role === "assistant") return makeMsg({ role, content: text, timestamp, rawType: msgType });
      return null;
    }
    if (msgType === "reasoning") {
      const rawRc = obj.rawContent ?? obj.content ?? [];
      const thinkingText = extractCodexContent(rawRc).trim();
      if (thinkingText) return makeMsg({ role: "assistant", content: "[AI 思考过程]", thinking: thinkingText, timestamp, rawType: "reasoning" });
      return null;
    }
    if (msgType === "function_call") {
      const name = String(obj.name || "tool");
      const inp = obj.arguments ?? obj.input ?? "";
      const toolInput = inp && typeof inp === "object" ? pyJsonDumps(inp) : String(inp);
      return makeMsg({ role: "tool", content: `[${name}]`, toolName: name, toolInput: toolInput.slice(0, 2000), status: "running", timestamp, rawType: "tool_call" });
    }
    if (msgType === "function_call_result") {
      const name = String(obj.name || "tool");
      const rawOut = obj.output ?? "";
      let outText: string;
      if (rawOut && typeof rawOut === "object" && !Array.isArray(rawOut)) {
        const rec = rawOut as Record<string, unknown>;
        outText = String(rec.text || pyJsonDumps(rec));
      } else if (Array.isArray(rawOut)) {
        outText = extractCodexContent(rawOut);
      } else {
        outText = String(rawOut);
      }
      let display = outText.trim();
      if (display.length > 5000) display = `${display.slice(0, 5000)}\n…(truncated)`;
      if (display) {
        const isFailed = obj.is_error === true || Boolean(obj.error);
        const statusVal = String(obj.status || (isFailed ? "failed" : "succeeded"));
        const exitCode = typeof obj.exit_code === "number" && Number.isInteger(obj.exit_code) ? obj.exit_code : null;
        return makeMsg({ role: "tool", content: display, toolName: name, status: statusVal, exitCode, error: String(obj.error || ""), timestamp, rawType: "tool_result" });
      }
      return null;
    }
    return null;
  }

  // --- Codex ---
  if (toolId === "codex") {
    if (msgType === "item.completed" || msgType === "item.started" || msgType === "item.updated") {
      const item = obj.item;
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const rec = item as Record<string, unknown>;
        const itype = String(rec.type ?? "");
        const done = msgType === "item.completed";
        if (itype === "agent_message") {
          const text = String(rec.text ?? "").trim();
          if (done && text) return makeMsg({ role: "assistant", content: text, timestamp, rawType: "agent_message" });
          return null;
        }
        if (itype === "user_message") {
          const text = String(rec.text ?? rec.message ?? rec.content ?? "").trim();
          if (text) return makeMsg({ role: "user", content: text, timestamp, rawType: "user_message" });
          return null;
        }
        if (itype === "reasoning") {
          const rtext = String(rec.text || rec.summary || extractCodexContent(rec.rawContent ?? [])).trim();
          if (rtext) return makeMsg({ role: "assistant", content: "[AI 思考过程]", thinking: rtext, timestamp, rawType: "reasoning" });
          return null;
        }
        if (itype === "command_execution") {
          const cmd = String(rec.command ?? "");
          const exitCode = typeof rec.exit_code === "number" && Number.isInteger(rec.exit_code) ? rec.exit_code : null;
          const output = String(rec.aggregated_output ?? "");
          const isFailed = exitCode !== null && exitCode !== 0;
          const status = !done ? "running" : isFailed ? "failed" : "succeeded";
          let display = output.trim() ? output.trim() : `[${cmd}]`;
          if (display.length > 5000) display = `${display.slice(0, 5000)}\n…(truncated)`;
          let errMsg = String(rec.error ?? "");
          if (!errMsg && isFailed) errMsg = `exit code ${exitCode}`;
          return makeMsg({ role: "tool", content: display, toolName: "Shell", toolInput: cmd, status, exitCode, error: errMsg, timestamp, rawType: "command_execution" });
        }
        if (itype === "file_change") {
          const changes = Array.isArray(rec.changes) ? rec.changes : [];
          const paths = changes
            .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
            .map((c) => String(c.path ?? ""))
            .filter(Boolean);
          const status = rec.status === "failed" ? "failed" : done ? "succeeded" : "running";
          return makeMsg({ role: "tool", content: paths.join(", ") || "[file_change]", toolName: "Edit", status, timestamp, rawType: "file_change" });
        }
        if (itype === "web_search") {
          const q = String(rec.query ?? "");
          return makeMsg({ role: "tool", content: `[WebSearch: ${q}]`, toolName: "WebSearch", toolInput: q, status: done ? "succeeded" : "running", timestamp, rawType: "web_search" });
        }
        if (itype === "mcp_tool_call") {
          const sName = `${rec.server ?? ""}.${rec.tool ?? ""}`.replace(/^\.+|\.+$/g, "") || "mcp";
          return makeMsg({
            role: "tool",
            content: `[${sName}]`,
            toolName: sName,
            toolInput: pyJsonDumps(rec.arguments ?? {}),
            status: rec.status === "failed" ? "failed" : done ? "succeeded" : "running",
            timestamp,
            rawType: "mcp_tool_call",
          });
        }
      }
      return null;
    }

    const payload = obj.payload && typeof obj.payload === "object" && !Array.isArray(obj.payload) ? (obj.payload as Record<string, unknown>) : {};
    if (msgType === "response_item") {
      const role = String(payload.role ?? "");
      if (role === "developer" || role === "system") return null;
      const pType = String(payload.type ?? "");
      if (pType === "reasoning") return null;
      if (pType === "message" && role === "assistant") {
        const content = extractCodexContent(payload.content ?? []).trim();
        return content ? makeMsg({ role: "assistant", content, timestamp, rawType: "message" }) : null;
      }
      if (pType === "message" && role === "user") {
        const content = extractCodexContent(payload.content ?? []);
        if (!content.trim()) return null;
        const trimmedStart = content.trimStart();
        if (trimmedStart.startsWith("<environment_context>") || trimmedStart.startsWith("<turn_aborted>") || trimmedStart.startsWith("<recommended_plugins>")) return null;
        return makeMsg({ role: "user", content: content.trim(), timestamp, rawType: "message" });
      }
      if (pType === "custom_tool_call" || pType === "function_call" || pType === "web_search_call") {
        const toolName = String(payload.name || pType);
        const rawInp = payload.input ?? payload.arguments ?? "";
        const toolInput = rawInp && typeof rawInp === "object" ? pyJsonDumps(rawInp) : String(rawInp);
        return makeMsg({ role: "tool", content: `[${toolName}]`, toolName, toolInput, status: "running", timestamp, rawType: "tool_call" });
      }
      if (pType === "custom_tool_call_output" || pType === "function_call_output") {
        const rawOut = payload.output ?? "";
        let outText: string;
        if (Array.isArray(rawOut)) outText = extractCodexContent(rawOut);
        else if (rawOut && typeof rawOut === "object") outText = pyJsonDumps(rawOut);
        else outText = String(rawOut);
        let display = outText.trim();
        if (display.length > 5000) display = `${display.slice(0, 5000)}\n…(truncated)`;
        if (display) {
          const isFailed = payload.is_error === true || Boolean(payload.error);
          const statusVal = String(payload.status || (isFailed ? "failed" : "succeeded"));
          const exitCode = typeof payload.exit_code === "number" && Number.isInteger(payload.exit_code) ? payload.exit_code : null;
          return makeMsg({ role: "tool", content: display, status: statusVal, exitCode, error: String(payload.error || ""), timestamp, rawType: "tool_result" });
        }
        return null;
      }
      return null;
    }

    if (msgType === "event_msg") {
      const eventType = String(payload.type ?? "");
      if (eventType === "task_started") return null;
      if (eventType === "user_message") {
        const text = String(payload.message ?? "").trim();
        return text ? makeMsg({ role: "user", content: text, timestamp, rawType: "user_message" }) : null;
      }
      if (eventType === "agent_message") {
        const text = String(payload.message ?? "").trim();
        return text ? makeMsg({ role: "assistant", content: text, timestamp, rawType: "agent_message" }) : null;
      }
      if (eventType === "task_complete") {
        const lastMsg = payload.last_agent_message;
        if (typeof lastMsg === "string" && lastMsg.trim()) {
          return makeMsg({ role: "assistant", content: lastMsg.trim(), timestamp, rawType: "task_complete" });
        }
        return null;
      }
      return null;
    }
    return null;
  }

  // --- OpenClaw ---
  if (toolId === "openclaw") {
    if (msgType === "message") {
      const rawMsg = obj.message ?? "";
      let msgDict: Record<string, unknown> | null = null;
      if (typeof rawMsg === "string") {
        try {
          const p = JSON.parse(rawMsg);
          if (p && typeof p === "object" && !Array.isArray(p)) msgDict = p as Record<string, unknown>;
        } catch {
          try {
            const p = parsePythonLiteral(rawMsg);
            if (p && typeof p === "object" && !Array.isArray(p)) msgDict = p as Record<string, unknown>;
          } catch {
            /* ignore */
          }
        }
      } else if (rawMsg && typeof rawMsg === "object" && !Array.isArray(rawMsg)) {
        msgDict = rawMsg as Record<string, unknown>;
      }

      if (msgDict) {
        let role = String(msgDict.role ?? "unknown");
        const rawContent = msgDict.content ?? "";
        let thinking = extractThinkingParts(rawContent);
        let content = extractContent(rawContent);
        if (content.startsWith("Conversation info")) {
          const parts = content.split("```\n");
          if (parts.length >= 2) content = parts[parts.length - 1]!.trim();
        }
        content = content.replaceAll("[[reply_to_current]] ", "");
        if (role === "toolResult") role = "tool";
        if (role === "user" || role === "assistant" || role === "tool") {
          if (!content.trim() && thinking.trim()) {
            content = thinking;
            thinking = "";
          }
          if (content.trim()) {
            return makeMsg({ role, content: content.trim(), thinking, timestamp, rawType: msgType });
          }
        }
      }
      return null;
    }
    if (msgType === "compaction") {
      const summary = String(obj.summary ?? "").trim();
      return summary ? makeMsg({ role: "system", content: summary, timestamp, rawType: msgType }) : null;
    }
    if (msgType === "session" || msgType === "model_change" || msgType === "thinking_level_change" || msgType === "custom") return null;
    if (msgType === "tool_call") {
      const name = String(obj.name ?? "tool");
      const args = obj.arguments ?? obj.data ?? "";
      return makeMsg({ role: "tool", content: `[${name}]`, toolName: name, toolInput: String(args), timestamp, rawType: msgType });
    }
    if (msgType === "tool_result") {
      const output = String(obj.data ?? obj.output ?? "");
      return makeMsg({ role: "tool", content: output, timestamp, rawType: "tool_output" });
    }
    return null;
  }

  // --- Antigravity ---
  if (toolId === "antigravity") {
    const createdTs = typeof obj.created_at === "string" && obj.created_at ? obj.created_at : timestamp;
    if (msgType === "USER_INPUT" || obj.source === "USER_EXPLICIT") {
      const rawContent = String(obj.content ?? "");
      const reqMatch = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(rawContent);
      const content = reqMatch ? reqMatch[1]!.trim() : rawContent;
      if (content.trim()) return makeMsg({ role: "user", content, timestamp: createdTs, rawType: msgType || "USER_INPUT" });
      return null;
    }
    if (msgType === "SYSTEM_MESSAGE") {
      const rawContent = String(obj.content ?? "");
      const m = /\[Message\]\s+(?:timestamp=[^\s]+\s+)?(?:sender=([^\s]+)\s+)?(?:priority=[^\s]+\s+)?content=([\s\S]*)/.exec(rawContent);
      if (m) {
        const sender = (m[1] ?? "").trim().toLowerCase();
        let body = (m[2] ?? "").trim();
        if (body.endsWith("</SYSTEM_MESSAGE>")) body = body.slice(0, -"</SYSTEM_MESSAGE>".length).trim();
        const isTaskNoise =
          sender.includes("task-") ||
          body.toLowerCase().includes("task id ") ||
          sender.includes("subagent") ||
          body.startsWith("[Notice]") ||
          body.startsWith("Task id ");
        if (!isTaskNoise && body) {
          return makeMsg({ role: "user", content: body, timestamp: createdTs, rawType: "user_message_queued" });
        }
      }
      return null;
    }
    if (msgType === "PLANNER_RESPONSE") {
      const toolCalls = obj.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length) {
        const tc = toolCalls[0] && typeof toolCalls[0] === "object" ? (toolCalls[0] as Record<string, unknown>) : {};
        const tname = String(tc.name ?? "tool");
        const targs = String(tc.args ?? "");
        return makeMsg({ role: "tool", content: `[${tname}]`, toolName: tname, toolInput: targs.slice(0, 2000), status: "running", timestamp: createdTs, rawType: "tool_call" });
      }
      const rawContent = obj.content;
      let content = rawContent ? extractContent(rawContent) : "";
      const thinking = String(obj.thinking ?? "").trim();
      if (!content.trim() && thinking) content = "[AI 思考过程]";
      if (content.trim()) return makeMsg({ role: "assistant", content, thinking, timestamp: createdTs, rawType: msgType });
      return null;
    }
    if (msgType === "GENERIC") {
      const content = String(obj.content ?? "").trim();
      if (content) {
        const errRaw = String(obj.error ?? "");
        const exitCode = typeof obj.exit_code === "number" && Number.isInteger(obj.exit_code) ? obj.exit_code : null;
        const isErr = Boolean(errRaw) || (exitCode !== null && exitCode !== 0);
        const statusRaw = String(obj.status || (isErr ? "failed" : "succeeded"));
        return makeMsg({ role: "tool", content: content.slice(0, 3000), status: statusRaw, exitCode, error: errRaw, timestamp: createdTs, rawType: "tool_output" });
      }
      return null;
    }
    if (msgType === "session_meta") return null;
    if (msgType === "user" || msgType === "assistant") {
      const message = obj.message && typeof obj.message === "object" ? (obj.message as Record<string, unknown>) : {};
      const role = String(message.role ?? msgType);
      let content = extractContent(message.content ?? "");
      const thinking = String(obj.thinking_text ?? "").trim();
      const rawType = String(obj.content_source || obj.fallback_source || msgType);
      if (rawType === "pb_thinking" && thinking) {
        return makeMsg({ role: "assistant", content: "[AI 思考过程]", thinking, timestamp, rawType });
      }
      if (!content.trim()) content = thinking;
      if (!content.trim()) return null;
      return makeMsg({ role, content, thinking, timestamp, rawType });
    }
    if (msgType === "tool") {
      const toolName = String(obj.tool_name ?? "tool");
      const toolInput = String(obj.tool_input ?? "");
      const content = String(obj.content ?? `[${toolName}]`);
      return makeMsg({ role: "tool", content, toolName, toolInput, timestamp, rawType: msgType });
    }
    if (msgType === "system") {
      const message = obj.message && typeof obj.message === "object" ? (obj.message as Record<string, unknown>) : {};
      const content = extractContent(message.content ?? "");
      if (content.trim()) {
        const rawType = String(obj.content_source || obj.fallback_source || msgType);
        return makeMsg({ role: "system", content, timestamp, rawType });
      }
      return null;
    }
    return null;
  }

  // --- Cursor ---
  if (toolId === "cursor" || (!msgType && "message" in obj && "role" in obj)) {
    const role = String(obj.role ?? "");
    const message = obj.message;
    const rawContent = message && typeof message === "object" && !Array.isArray(message) ? (message as Record<string, unknown>).content ?? "" : (message ?? "");
    const thinking = extractThinkingParts(rawContent);
    let content = extractContent(rawContent);
    if (content) content = content.replaceAll("<user_query>", "").replaceAll("</user_query>", "").trim();
    if ((role === "user" || role === "assistant") && content.trim()) {
      if (content.startsWith("[Tool:") || content.startsWith("[Result]")) return null;
      return makeMsg({ role, content, thinking, timestamp, rawType: msgType || role });
    }
    return null;
  }

  // --- Generic fallback ---
  const role = String(obj.role ?? msgType);
  const content = extractContent(obj.content ?? obj.message ?? "");
  if ((role === "user" || role === "assistant" || role === "system") && content.trim()) {
    return makeMsg({ role, content, timestamp, rawType: msgType });
  }
  return null;
}

export function parseConversationLine(rawLine: string, toolId: string): NormalizedMessage | null {
  try {
    const obj = JSON.parse(rawLine);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    return parseConversationObject(obj as Record<string, unknown>, toolId);
  } catch {
    return null;
  }
}

/** Stream-decode mixed compact JSONL and pretty-printed multi-line JSON objects (matches Python _iter_json_objects). */
export function* iterJsonObjects(rawContent: string): Generator<string> {
  if (!rawContent) return;
  const n = rawContent.length;
  let i = 0;
  while (i < n) {
    while (i < n && (rawContent[i] === " " || rawContent[i] === "\t" || rawContent[i] === "\r" || rawContent[i] === "\n")) i++;
    if (i >= n) break;
    // Fast path: most lines in JSONL are single-line compact JSON objects
    const nl = rawContent.indexOf("\n", i);
    const lineEnd = nl === -1 ? n : nl;
    const lineSlice = rawContent.slice(i, lineEnd).trim();
    if (lineSlice.startsWith("{") && lineSlice.endsWith("}")) {
      try {
        const parsed = JSON.parse(lineSlice);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          yield pyJsonDumps(parsed);
          i = lineEnd + 1;
          continue;
        }
      } catch {
        // Fall through to balanced-brace scanner (multi-line or concatenated JSON)
      }
    }
    if (rawContent[i] === "{") {
      const end = scanJsonEnd(rawContent, i);
      if (end > i) {
        const cand = rawContent.slice(i, end);
        try {
          const parsed = JSON.parse(cand);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            yield pyJsonDumps(parsed);
            i = end;
            continue;
          }
        } catch {
          /* advance to next line */
        }
      }
    }
    if (nl === -1) break;
    i = nl + 1;
  }
}

function scanJsonEnd(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < s.length; j++) {
    const ch = s[j]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
  }
  return -1;
}

function prettyLeadingJson(text: string): string {
  const s = text.trimStart();
  if (!s || (s[0] !== "{" && s[0] !== "[")) return text;
  const end = scanJsonEnd(s, 0);
  if (end <= 0) return text;
  try {
    const obj = JSON.parse(s.slice(0, end));
    const pretty = JSON.stringify(obj, null, 2);
    const rest = s.slice(end).trim();
    return rest ? `${pretty}\n\n${rest}` : pretty;
  } catch {
    return text;
  }
}

function formatHermesToolContent(contentStr: string): string {
  let outer: unknown;
  try {
    outer = JSON.parse(contentStr);
  } catch {
    return contentStr;
  }
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) return contentStr;
  const rec = outer as Record<string, unknown>;
  const output = rec.output ?? "";
  const error = rec.error;
  const exitCode = rec.exit_code;
  let pretty: string;
  if (typeof output === "string") pretty = prettyLeadingJson(output);
  else if (output && typeof output === "object") pretty = JSON.stringify(output, null, 2);
  else pretty = output === null || output === undefined ? "" : String(output);

  const parts: string[] = [];
  if (error) parts.push(`⚠️  ${error}`);
  if (pretty) parts.push(pretty);
  if (exitCode !== null && exitCode !== undefined && exitCode !== 0) parts.push(`(exit_code=${exitCode})`);
  return parts.length ? parts.join("\n\n") : contentStr;
}

function parseHermesSession(rawContent: string, offset: number, limit: number | null): NormalizedMessage[] {
  let d: unknown;
  try {
    d = JSON.parse(rawContent);
  } catch {
    return [];
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) return [];
  const doc = d as Record<string, unknown>;
  const msgs = Array.isArray(doc.messages) ? doc.messages : [];
  const timestamp = String(doc.last_updated || doc.session_start || "");

  const toolNameById = new Map<string, string>();
  for (const m of msgs) {
    if (!m || typeof m !== "object" || (m as Record<string, unknown>).role !== "assistant") continue;
    const tcs = (m as Record<string, unknown>).tool_calls;
    if (!Array.isArray(tcs)) continue;
    for (const tc of tcs) {
      if (!tc || typeof tc !== "object") continue;
      const tcr = tc as Record<string, unknown>;
      const fn = tcr.function && typeof tcr.function === "object" ? (tcr.function as Record<string, unknown>) : null;
      const name = fn?.name;
      const cid = tcr.id ?? tcr.call_id;
      if (cid && name) toolNameById.set(String(cid), String(name));
    }
  }

  const out: NormalizedMessage[] = [];
  let skipped = 0;
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const role = String(rec.role ?? "");
    const content = typeof rec.content === "string" ? rec.content : rec.content == null ? "" : String(rec.content);
    const text = content.trim();
    if (role === "system" || !text) continue;
    let norm: NormalizedMessage;
    if (role === "user" || role === "assistant") {
      norm = makeMsg({ role, content: text, timestamp });
    } else if (role === "tool") {
      const tcid = String(rec.tool_call_id ?? "");
      const toolName = toolNameById.get(tcid) ?? "tool";
      const formatted = formatHermesToolContent(text);
      const display = formatted.length <= 4000 ? formatted : `${formatted.slice(0, 4000)}\n…(truncated)`;
      let hStatus = "succeeded";
      let hExitCode: number | null = null;
      let hError = "";
      try {
        const outer = JSON.parse(text);
        if (outer && typeof outer === "object" && !Array.isArray(outer)) {
          const orec = outer as Record<string, unknown>;
          if (typeof orec.exit_code === "number" && Number.isInteger(orec.exit_code)) hExitCode = orec.exit_code;
          hError = String(orec.error ?? "");
          if (hError || (hExitCode !== null && hExitCode !== 0)) hStatus = "failed";
        }
      } catch {
        /* ignore */
      }
      norm = makeMsg({ role: "tool", content: display, toolName, status: hStatus, exitCode: hExitCode, error: hError, timestamp });
    } else {
      continue;
    }
    if (skipped < offset) {
      skipped++;
      continue;
    }
    out.push(norm);
    if (limit && out.length >= limit) break;
  }
  return out;
}

function countHermesMessages(rawContent: string): number {
  let d: unknown;
  try {
    d = JSON.parse(rawContent);
  } catch {
    return 0;
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) return 0;
  const msgs = Array.isArray((d as Record<string, unknown>).messages) ? ((d as Record<string, unknown>).messages as unknown[]) : [];
  let n = 0;
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const role = String(rec.role ?? "");
    const content = typeof rec.content === "string" ? rec.content : rec.content == null ? "" : String(rec.content);
    if (role === "system" || !content.trim() || (role !== "user" && role !== "assistant" && role !== "tool")) continue;
    n++;
  }
  return n;
}

export function parseTimestamp(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  // Add Z when no timezone suffix is present, matching Python's UTC assumption
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(" ", "T")}Z`;
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? null : new Date(t);
}

function epochSecond(raw: string | null | undefined, ts: Date | null): string {
  if (ts) return String(Math.floor(ts.getTime() / 1000));
  return (raw ?? "").slice(0, 19);
}

function md5Hex(s: string): string {
  return createHash("md5").update(s, "utf8").digest("hex");
}

export function dialogueKey(role: string, timestamp: string | null | undefined, content: string, ts?: Date | null): string {
  const d = ts === undefined ? parseTimestamp(timestamp) : ts;
  return md5Hex(`${role}:${epochSecond(timestamp, d)}:${content}`);
}

const REPLY_PREFIX = "reply:";

export function replyKey(content: string): string {
  return `${REPLY_PREFIX}${md5Hex(content)}`;
}

export class DialogueCopies {
  readonly seen: Set<string>;
  lastReply: string | null;

  constructor(seen?: Set<string>) {
    this.seen = seen ?? new Set<string>();
    this.lastReply = null;
    for (const k of this.seen) {
      if (k.startsWith(REPLY_PREFIX)) {
        this.lastReply = k;
        break;
      }
    }
  }

  repeat(role: string, rawType: string | null | undefined, timestamp: string | null | undefined, content: string, ts?: Date | null): boolean {
    const dk = dialogueKey(role, timestamp, content, ts);
    if (this.seen.has(dk)) return true;
    if (role === "assistant") {
      const rk = replyKey(content);
      if (rawType === "task_complete" && rk === this.lastReply) return true;
      this.lastReply = rk;
    }
    this.seen.add(dk);
    return false;
  }
}

export function rowKey(role: string | null | undefined, ts: Date | null, content: string | null | undefined, toolInput = ""): string {
  const sec = ts ? String(Math.floor(ts.getTime() / 1000)) : "";
  return md5Hex(`${role ?? ""}:${sec}:${content ?? ""}\x1f${toolInput || ""}`);
}

export function looseKey(role: string, ts: Date | null): string | null {
  if (!ts) return null;
  return `${role}:${Math.floor(ts.getTime() / 1000)}`;
}

export function parseConversation(rawContent: string, toolId: string, offset = 0, limit: number | null = null): NormalizedMessage[] {
  if (toolId === "hermes") return parseHermesSession(rawContent, offset, limit);
  const messages: NormalizedMessage[] = [];
  const copies = new DialogueCopies();
  let skipped = 0;
  for (const line of iterJsonObjects(rawContent)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const msg = parseConversationLine(trimmed, toolId);
    if (!msg) continue;
    if ((msg.role === "user" || msg.role === "assistant") && copies.repeat(msg.role, msg.rawType, msg.timestamp, msg.content)) {
      continue;
    }
    if (skipped < offset) {
      skipped++;
      continue;
    }
    messages.push(msg);
    if (limit && messages.length >= limit) break;
  }
  return messages;
}

export function countConversationMessages(rawContent: string, toolId: string): number {
  if (toolId === "hermes") return countHermesMessages(rawContent);
  let count = 0;
  const copies = new DialogueCopies();
  for (const line of iterJsonObjects(rawContent)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const msg = parseConversationLine(trimmed, toolId);
    if (!msg) continue;
    if ((msg.role === "user" || msg.role === "assistant") && copies.repeat(msg.role, msg.rawType, msg.timestamp, msg.content)) {
      continue;
    }
    count++;
  }
  return count;
}

export function messagesToStore(rawContent: string, toolId: string, seen?: Set<string>): StoredMessage[] {
  const copies = new DialogueCopies(seen);
  const linesSeen = new Set<string>();
  const out: StoredMessage[] = [];
  for (const line of iterJsonObjects(rawContent)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const msg = parseConversationLine(trimmed, toolId);
    if (!msg || !STORED_ROLES.has(msg.role)) continue;
    const lineKey = md5Hex(trimmed);
    if (linesSeen.has(lineKey)) continue;
    linesSeen.add(lineKey);
    const content = msg.content.replaceAll("\u0000", "");
    const ts = parseTimestamp(msg.timestamp);
    if ((msg.role === "user" || msg.role === "assistant") && copies.repeat(msg.role, msg.rawType, msg.timestamp, content, ts)) {
      continue;
    }
    const meta: Record<string, unknown> = {};
    if (msg.thinking) meta.thinking = msg.thinking.replaceAll("\u0000", "");
    if (msg.toolName) meta.tool_name = msg.toolName.replaceAll("\u0000", "");
    if (msg.toolInput) meta.tool_input = msg.toolInput.replaceAll("\u0000", "");
    const ti = typeof meta.tool_input === "string" ? meta.tool_input : "";
    out.push({
      messageType: msg.rawType || msg.role,
      role: msg.role,
      content,
      metadata: meta,
      timestamp: ts,
      key: rowKey(msg.role, ts, content, ti),
      loose: looseKey(msg.role, ts),
    });
  }
  return out;
}

export function hermesMessagesToStore(rawContent: string): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (const m of parseConversation(rawContent, "hermes")) {
    const content = (m.content || "").replaceAll("\u0000", "");
    const ts = parseTimestamp(m.timestamp);
    out.push({
      messageType: m.role,
      role: m.role,
      content,
      metadata: m.toolName ? { tool_name: m.toolName } : {},
      timestamp: ts,
      key: rowKey(m.role, ts, content),
      loose: looseKey(m.role, ts),
    });
  }
  return out;
}
