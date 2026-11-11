/**
 * Signing agent CLIs in from the web page, for machines nobody sits at (a Linux executor reached over
 * ssh). The daemon runs each CLI's own login, hands the page the link (and Codex's device code); the
 * user opens it in their own browser and, for Claude Code and Antigravity, pastes the code back.
 *
 * - Claude Code: `claude auth login` prints the link and reads the pasted code from stdin.
 * - Codex: `codex login --device-auth` prints a link and a one-time code, then waits (15 min) for the
 *   user to approve it; nothing to paste.
 * - Antigravity (Google's agy): no login command. `agy -p` asks for sign-in when it has none, but only
 *   when stdin isn't a pipe left open (it reads the prompt from it first), so it runs under `script` for
 *   a terminal. It waits 60 seconds for the code, then gives up.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";

import { officialAgyCli } from "./antigravity.js";
import { executionEnvironment, findExecutable } from "./exec-env.js";

export const LOGIN_AGENTS = ["claude", "codex", "agy"] as const;
export type LoginAgent = (typeof LOGIN_AGENTS)[number];

export interface LoginState {
  agent: LoginAgent;
  /** missing: CLI not installed · unsupported: sign in another way on this OS · waiting: link is out */
  state: "logged_in" | "logged_out" | "waiting" | "failed" | "missing" | "unsupported";
  url?: string;
  /** Codex's one-time code, to type on its page */
  user_code?: string;
  /** The page shows a box for the code the sign-in page gives */
  needs_code?: boolean;
  /** When the waiting CLI gives up (ms since epoch) */
  expires_at?: number;
  account?: string;
  detail?: string;
}

const LINK_WAIT_MS = 20_000;
const SUBMIT_WAIT_MS = 45_000;
const LIFETIME_MS: Record<LoginAgent, number> = { claude: 10 * 60_000, codex: 15 * 60_000, agy: 60_000 };

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
export const plainText = (s: string) => s.replace(ANSI, "").replace(/\r/g, "");

/** The sign-in link (and Codex's code) in what the login command printed so far. */
export function parseLoginPrompt(agent: LoginAgent, text: string): { url?: string; user_code?: string } {
  const t = plainText(text);
  if (agent === "codex") {
    const url = t.match(/https:\/\/auth\.openai\.com\/\S+/)?.[0];
    const after = t.slice(t.search(/one-time code/i) >= 0 ? t.search(/one-time code/i) : 0);
    const user_code = after.match(/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/)?.[0];
    return url && user_code ? { url, user_code } : {};
  }
  const re = agent === "claude" ? /https:\/\/(?:claude\.com|claude\.ai|console\.anthropic\.com)\/\S*oauth\S+/ : /https:\/\/accounts\.google\.com\/\S+/;
  const url = t.match(re)?.[0];
  return url ? { url } : {};
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeout = 20_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? Number((err as { code: number }).code) : 1) : 0;
      resolve({ code, out: plainText(`${stdout}\n${stderr}`) });
    }).stdin?.end();
  });
}

/** What `codex login status` and `claude auth status` say, and whether `agy models` gets past sign-in. */
export function readStatus(agent: LoginAgent, code: number, out: string): Pick<LoginState, "state" | "account" | "detail"> {
  if (agent === "claude") {
    try {
      const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as { loggedIn?: boolean; email?: string; account?: { email?: string } };
      return j.loggedIn ? { state: "logged_in", account: j.email || j.account?.email || undefined } : { state: "logged_out" };
    } catch {
      return { state: "logged_out", detail: out.trim().slice(-200) || undefined };
    }
  }
  if (agent === "codex") return code === 0 && /logged in/i.test(out) && !/not logged in/i.test(out) ? { state: "logged_in", account: out.match(/Logged in using (.+)/i)?.[1]?.trim() } : { state: "logged_out" };
  return code === 0 && !/sign in|authenticat/i.test(out) ? { state: "logged_in" } : { state: "logged_out" };
}

interface Session {
  proc: ChildProcess;
  out: string;
  state: LoginState;
  exited: boolean;
  timer: NodeJS.Timeout;
  waiters: Array<() => void>;
}

/** What to tell the user when the CLI turned the pasted code down. */
export function failureText(out: string): string {
  if (/Invalid code|invalid_grant/.test(out)) return "验证码不对或已过期：重新点「登录」拿新链接，复制完整的验证码再贴";
  if (/timed out/.test(out)) return "等验证码超时了：重新点「登录」拿新链接";
  return out.trim().split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" ").slice(0, 300) || "登录没有成功";
}

function agentExecutable(agent: LoginAgent, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (agent === "claude") return findExecutable(["claude"], env);
  if (agent === "codex") return findExecutable(["codex"], env);
  return officialAgyCli(undefined, env);
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export class AgentLogins {
  private sessions = new Map<LoginAgent, Session>();

  constructor(
    private readonly onLoggedIn: (agent: LoginAgent) => void = () => {},
    private readonly executable: (agent: LoginAgent, env: NodeJS.ProcessEnv) => Promise<string | undefined> = agentExecutable,
  ) {}

  async status(agent: LoginAgent): Promise<LoginState> {
    const live = this.sessions.get(agent);
    if (live && !live.exited) return live.state;
    return this.checkDone(agent);
  }

  async statusAll(): Promise<LoginState[]> {
    return Promise.all(LOGIN_AGENTS.map((a) => this.status(a)));
  }

  async start(agent: LoginAgent): Promise<LoginState> {
    const live = this.sessions.get(agent);
    if (live && !live.exited && live.state.state === "waiting") return live.state;
    const current = await this.status(agent);
    if (current.state === "logged_in" || current.state === "missing") return current;
    if (agent === "agy" && process.platform !== "linux") {
      return { agent, state: "unsupported", detail: "在这台电脑上打开 Antigravity 应用登录即可" };
    }
    const env = await executionEnvironment();
    const exe = (await this.executable(agent, env))!;
    let file = exe;
    let args = agent === "claude" ? ["auth", "login", "--claudeai"] : ["login", "--device-auth"];
    if (agent === "agy") {
      file = (await findExecutable(["script"], env)) ?? "";
      if (!file) return { agent, state: "failed", detail: "缺少 script 命令（util-linux），装上后再试" };
      args = ["-qfec", `${shq(exe)} -p ${shq("reply with: ok")}`, "/dev/null"];
    }
    const proc = spawn(file, args, { env: { ...env, BROWSER: "/bin/false", NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    const s: Session = {
      proc,
      out: "",
      exited: false,
      state: { agent, state: "waiting", needs_code: agent !== "codex", expires_at: Date.now() + LIFETIME_MS[agent] },
      timer: setTimeout(() => this.stop(agent), LIFETIME_MS[agent] + 5_000),
      waiters: [],
    };
    const wake = () => s.waiters.splice(0).forEach((w) => w());
    const onData = (b: Buffer) => {
      s.out = (s.out + b.toString("utf8")).slice(-64_000);
      wake();
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (e) => {
      s.out += `\n${e.message}`;
      s.exited = true;
      wake();
    });
    proc.on("exit", () => {
      s.exited = true;
      clearTimeout(s.timer);
      wake();
    });
    this.sessions.get(agent)?.proc.kill();
    this.sessions.set(agent, s);

    const deadline = Date.now() + LINK_WAIT_MS;
    while (!s.exited && Date.now() < deadline) {
      const got = parseLoginPrompt(agent, s.out);
      if (got.url) {
        s.state = { ...s.state, ...got };
        return s.state;
      }
      await this.next(s, deadline - Date.now());
    }
    this.stop(agent);
    return { agent, state: "failed", detail: this.tail(s) || "登录命令没有给出链接" };
  }

  /** The code the sign-in page showed, for Claude Code and Antigravity. */
  async submit(agent: LoginAgent, code: string): Promise<LoginState> {
    const s = this.sessions.get(agent);
    if (!s || s.exited) return { agent, state: "failed", detail: "登录已超时，重新点「登录」获取新链接" };
    const before = s.out.length;
    s.proc.stdin?.write(`${code.trim()}\n`);
    const deadline = Date.now() + SUBMIT_WAIT_MS;
    let lastCheck = 0;
    while (Date.now() < deadline) {
      const fresh = plainText(s.out.slice(before));
      // Case-sensitive: agy also logs "ERROR: logging before google.Init" noise that isn't a failure
      if (/Invalid code|invalid_grant|authentication failed|timed out|Error: /.test(fresh) && !/success/i.test(fresh)) {
        this.stop(agent);
        return { agent, state: "failed", detail: failureText(fresh.split(code.trim()).join("")) };
      }
      // agy goes on to run its prompt once signed in, and Claude Code exits: either way the status says so
      if (s.exited || Date.now() - lastCheck > 3_000) {
        lastCheck = Date.now();
        const st = await this.checkDone(agent);
        if (st.state === "logged_in" || s.exited) {
          this.stop(agent);
          if (st.state === "logged_in") this.onLoggedIn(agent);
          return st.state === "logged_in" ? st : { agent, state: "failed", detail: failureText(plainText(s.out.slice(before)).split(code.trim()).join("")) };
        }
      }
      await this.next(s, Math.min(1_000, deadline - Date.now()));
    }
    return { ...s.state, detail: "还在等登录完成" };
  }

  /** For Codex: whether the user approved the code yet. */
  async poll(agent: LoginAgent): Promise<LoginState> {
    const s = this.sessions.get(agent);
    if (!s) return this.status(agent);
    if (!s.exited) return s.state;
    this.sessions.delete(agent);
    const st = await this.checkDone(agent);
    if (st.state === "logged_in") this.onLoggedIn(agent);
    return st.state === "logged_in" ? st : { agent, state: "failed", detail: this.tail(s) || "登录没有完成" };
  }

  stop(agent: LoginAgent): void {
    const s = this.sessions.get(agent);
    if (!s) return;
    clearTimeout(s.timer);
    if (!s.exited) s.proc.kill();
    this.sessions.delete(agent);
  }

  stopAll(): void {
    for (const a of [...this.sessions.keys()]) this.stop(a);
  }

  private async checkDone(agent: LoginAgent): Promise<LoginState> {
    const env = await executionEnvironment();
    const exe = await this.executable(agent, env);
    if (!exe) return { agent, state: "missing" };
    const args = agent === "claude" ? ["auth", "status"] : agent === "codex" ? ["login", "status"] : ["models"];
    const r = await run(exe, args, env);
    return { agent, ...readStatus(agent, r.code, r.out) };
  }

  private tail(s: Session): string {
    return plainText(s.out)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("http"))
      .slice(-3)
      .join(" ")
      .slice(0, 300);
  }

  private next(s: Session, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, Math.max(0, ms));
      s.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
