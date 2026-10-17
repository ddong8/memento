import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface ToolUse {
  tool: string;
  input: Record<string, string>;
  cwd?: string;
}

/**
 * What leaves the machine for one tool call: the tool, its command or target
 * path, and the working directory. Never file contents.
 */
function summarizeToolUse(hook: Record<string, unknown>): ToolUse {
  const tool = String(hook.tool_name ?? "");
  const input = (hook.tool_input && typeof hook.tool_input === "object" ? hook.tool_input : {}) as Record<string, unknown>;
  const kept: Record<string, string> = {};
  if (tool === "Bash") {
    kept.command = String(input.command ?? "").slice(0, 2000);
  } else {
    for (const key of ["file_path", "notebook_path"]) if (input[key] != null) kept[key] = String(input[key]);
  }
  return { tool, input: kept, ...(hook.cwd != null ? { cwd: String(hook.cwd) } : {}) };
}

/**
 * Loopback endpoint Claude Code's PreToolUse hook posts each tool call to. The
 * hook is one curl command, so there's no script to install. It never slows the
 * agent: the bridge answers {} at once ("no decision") and forwards the call to
 * the server, which decides whether it's worth a push.
 */
export class HookBridge {
  private readonly secret = randomBytes(24).toString("hex");
  private server: Server | undefined;
  private port: number | undefined;

  constructor(private readonly onToolUse: (taskId: string, use: ToolUse) => void) {}

  private async ensureStarted(): Promise<number> {
    if (this.port !== undefined) return this.port;
    const server = createServer((req, res) => {
      const parts = (req.url ?? "").split("/").filter(Boolean);
      if (req.method !== "POST" || parts.length !== 3 || parts[0] !== "hook" || parts[1] !== this.secret) {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const data = JSON.parse(body) as unknown;
          if (data && typeof data === "object") this.onToolUse(decodeURIComponent(parts[2]!), summarizeToolUse(data as Record<string, unknown>));
        } catch {
          // Malformed hook input: still answer, so the agent carries on.
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.unref();
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.port;
  }

  /** The `hooks` section of Claude Code --settings that reports each tool call of `taskId`; null if the bridge can't listen. */
  async claudeHooks(taskId: string): Promise<Record<string, unknown> | null> {
    try {
      const port = await this.ensureStarted();
      const url = `http://127.0.0.1:${port}/hook/${this.secret}/${encodeURIComponent(taskId)}`;
      return {
        PreToolUse: [
          {
            matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit",
            hooks: [
              {
                type: "command",
                // Nothing needs quoting, so bash, zsh and cmd all parse it the same;
                // "|| exit 0" keeps a missing curl from surfacing as a hook error.
                command: `curl -s -m 3 -X POST -H Content-Type:application/json --data-binary @- ${url} || exit 0`,
                timeout: 5,
              },
            ],
          },
        ],
      };
    } catch {
      return null;
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
    this.port = undefined;
  }
}
