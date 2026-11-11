import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLogins, failureText, parseLoginPrompt, readStatus, type LoginAgent } from "../src/agent-login.js";

// What the CLIs printed on a headless Linux box (2026-11-11: claude 2.1.322, codex 0.167.1, agy 1.5.5)
const CLAUDE_OUT =
  "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code&state=abc\nPaste code here if prompted > ";
const CODEX_OUT =
  "\nWelcome to Codex [v\x1b[90m0.167.1\x1b[0m]\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mQ7KD-3XW9P\x1b[0m\n";
const AGY_OUT =
  "Authentication required. Please visit the URL to log in:\r\n  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=y&state=z\r\n\r\nWaiting for authentication (timeout 60s)...\r\nOr, paste the authorization code here and press Enter:\r\n";

describe("reading the login commands", () => {
  it("finds each CLI's link and Codex's one-time code", () => {
    expect(parseLoginPrompt("claude", CLAUDE_OUT).url).toBe("https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code&state=abc");
    expect(parseLoginPrompt("codex", CODEX_OUT)).toEqual({ url: "https://auth.openai.com/codex/device", user_code: "Q7KD-3XW9P" });
    expect(parseLoginPrompt("agy", AGY_OUT).url).toBe("https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=y&state=z");
    // Not yet printed in full: wait for more
    expect(parseLoginPrompt("codex", CODEX_OUT.slice(0, CODEX_OUT.indexOf("2.")))).toEqual({});
    expect(parseLoginPrompt("claude", "Opening browser to sign in…")).toEqual({});
  });

  it("explains a rejected code without echoing it", () => {
    expect(failureText('Error: authentication failed: token exchange failed: oauth2: "invalid_grant" "Bad Request"')).toContain("验证码不对");
    expect(failureText("Error: authentication timed out.")).toContain("超时");
    expect(failureText("\nsomething else broke\n")).toBe("something else broke");
  });

  it("reads each CLI's status output", () => {
    expect(readStatus("claude", 0, '{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "email": "a@b.c"\n}')).toEqual({ state: "logged_in", account: "a@b.c" });
    expect(readStatus("claude", 1, '{\n  "loggedIn": false,\n  "authMethod": "none"\n}').state).toBe("logged_out");
    expect(readStatus("codex", 0, "Logged in using ChatGPT\n")).toEqual({ state: "logged_in", account: "ChatGPT" });
    expect(readStatus("codex", 1, "Not logged in\n").state).toBe("logged_out");
    expect(readStatus("agy", 0, "Fetching available models...\nError: Please sign in to view available models.").state).toBe("logged_out");
    expect(readStatus("agy", 0, "Fetching available models...\ngemini-3-pro\ngemini-3-flash\n").state).toBe("logged_in");
  });
});

/** Stand-ins for `claude` and `codex` that log in for real: they write a file the status command reads. */
function fakeClis() {
  const dir = mkdtempSync(join(tmpdir(), "memento-login-"));
  const state = (a: string) => join(dir, `${a}.ok`);
  const claude = join(dir, "claude");
  writeFileSync(
    claude,
    `#!/bin/sh
if [ "$1 $2" = "auth status" ]; then
  if [ -f '${state("claude")}' ]; then echo '{"loggedIn": true, "email": "me@example.com"}'; else echo '{"loggedIn": false}'; exit 1; fi
  exit 0
fi
printf '%s' "${CLAUDE_OUT.replace(/"/g, '\\"')}"
read code
if [ "$code" = "good-code" ]; then touch '${state("claude")}'; echo "Login successful."; exit 0; fi
echo "Invalid code. Please make sure the full code was copied."; exit 1
`,
  );
  const codex = join(dir, "codex");
  writeFileSync(
    codex,
    `#!/bin/sh
if [ "$2" = "status" ]; then
  if [ -f '${state("codex")}' ]; then echo "Logged in using ChatGPT"; exit 0; fi
  echo "Not logged in"; exit 1
fi
echo "1. Open this link in your browser and sign in to your account"
echo "   https://auth.openai.com/codex/device"
echo "2. Enter this one-time code (expires in 15 minutes)"
echo "   Q7KD-3XW9P"
sleep 0.4
touch '${state("codex")}'
echo "Successfully logged in"
`,
  );
  chmodSync(claude, 0o755);
  chmodSync(codex, 0o755);
  const exe = async (a: LoginAgent) => (a === "claude" ? claude : a === "codex" ? codex : undefined);
  return { exe, state };
}

describe.skipIf(process.platform === "win32")("signing in from the page", () => {
  it("Claude Code: link out, code back, logged in", async () => {
    const { exe, state } = fakeClis();
    const done: string[] = [];
    const logins = new AgentLogins((a) => done.push(a), exe);
    expect((await logins.status("claude")).state).toBe("logged_out");
    const waiting = await logins.start("claude");
    expect(waiting).toMatchObject({ state: "waiting", needs_code: true });
    expect(waiting.url).toContain("https://claude.com/cai/oauth/authorize");
    // A second click while the link is out hands back the same link, not a new login
    expect((await logins.start("claude")).url).toBe(waiting.url);
    const res = await logins.submit("claude", "  good-code \n");
    expect(res).toEqual({ agent: "claude", state: "logged_in", account: "me@example.com" });
    expect(existsSync(state("claude"))).toBe(true);
    expect(done).toEqual(["claude"]);
    // Already signed in: no new login
    expect((await logins.start("claude")).state).toBe("logged_in");
  });

  it("Claude Code: a wrong code says so and the next start gives a fresh link", async () => {
    const { exe } = fakeClis();
    const logins = new AgentLogins(() => {}, exe);
    await logins.start("claude");
    const res = await logins.submit("claude", "typo");
    expect(res.state).toBe("failed");
    expect(res.detail).toContain("验证码不对");
    expect((await logins.submit("claude", "good-code")).detail).toContain("重新点「登录」");
    expect((await logins.start("claude")).state).toBe("waiting");
    logins.stopAll();
  });

  it("Codex: device code out, approval noticed by polling", async () => {
    const { exe } = fakeClis();
    const done: string[] = [];
    const logins = new AgentLogins((a) => done.push(a), exe);
    const waiting = await logins.start("codex");
    expect(waiting).toMatchObject({ state: "waiting", url: "https://auth.openai.com/codex/device", user_code: "Q7KD-3XW9P", needs_code: false });
    expect((await logins.poll("codex")).state).toBe("waiting");
    await new Promise((r) => setTimeout(r, 900));
    expect(await logins.poll("codex")).toEqual({ agent: "codex", state: "logged_in", account: "ChatGPT" });
    expect(done).toEqual(["codex"]);
  });

  it("a CLI that isn't installed", async () => {
    const logins = new AgentLogins(() => {}, async () => undefined);
    expect(await logins.start("agy")).toEqual({ agent: "agy", state: "missing" });
    expect((await logins.statusAll()).map((s) => s.state)).toEqual(["missing", "missing", "missing"]);
  });
});
