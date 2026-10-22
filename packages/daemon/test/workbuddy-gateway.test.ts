import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  cancelWorkbuddySession,
  ensureWorkbuddyGateway,
  findWorkbuddyLiteCli,
  parseGatewayBanner,
  workbuddyBundledNode,
  workbuddyGatewayFile,
} from "../src/workbuddy.js";

const RUNNER = fileURLToPath(new URL("../assets/workbuddy_cli.mjs", import.meta.url));
const isWin = process.platform === "win32";

const temps: string[] = [];
const pids: number[] = [];
const servers: Server[] = [];
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memento-wb-"));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // gone
    }
  }
  for (const s of servers.splice(0)) s.close();
  for (const d of temps.splice(0)) await rm(d, { recursive: true, force: true });
});

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });

describe("WorkBuddy ≥ 5.8 discovery", () => {
  it("reads the CLI's coloured --serve banner", () => {
    const banner =
      "  \x1b[38;2;40;184;148mCodeBuddy Code\x1b[39m \x1b[38;2;102;102;102mHTTP Server\x1b[39m\n\n" +
      "  \x1b[38;2;102;102;102mEndpoint\x1b[39m    http://127.0.0.1:54321\n" +
      "  \x1b[38;2;102;102;102mWeb UI\x1b[39m      http://127.0.0.1:54321/?password=abc\n\n" +
      "  \x1b[38;2;102;102;102mPassword\x1b[39m    s3cr3t-Pass_word\n";
    expect(parseGatewayBanner(banner)).toEqual({ endpoint: "http://127.0.0.1:54321", password: "s3cr3t-Pass_word" });
    expect(parseGatewayBanner("starting...")).toBeNull();
  });

  it("finds WorkBuddy's own Node runtime and its bundled CLI", async () => {
    const home = await tempHome();
    const versions = join(home, ".workbuddy", "binaries", "node", "versions");
    const nodeDir = isWin ? join(versions, "22.22.2-6") : join(versions, "22.22.2-6", "bin");
    await mkdir(nodeDir, { recursive: true });
    await writeFile(join(nodeDir, isWin ? "node.exe" : "node"), "");
    await writeFile(join(versions, "current"), "22.22.2-6\n");
    expect(workbuddyBundledNode(home)).toBe(join(nodeDir, isWin ? "node.exe" : "node"));

    const entry = join(home, "codebuddy-lite-wb.mjs");
    await writeFile(entry, "");
    expect(findWorkbuddyLiteCli(home, { MEMENTO_WORKBUDDY_CLI_ENTRY: entry }, process.platform)).toEqual({
      node: join(nodeDir, isWin ? "node.exe" : "node"),
      entry,
    });
    expect(findWorkbuddyLiteCli(home, {}, "linux")).toBeNull();
  });
});

describe("memento's WorkBuddy gateway", () => {
  it("starts the bundled CLI once, records how to reach it, and reuses it", async () => {
    const home = await tempHome();
    // Stands in for `codebuddy-lite-wb.mjs --serve`: same banner, same password check.
    const fake = join(home, "fake-cli.mjs");
    await writeFile(
      fake,
      `import { createServer } from "node:http";
const pw = "pw-" + process.pid;
if (process.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE !== "1") process.exit(3);
const server = createServer((req, res) => {
  if (req.headers.authorization !== "Bearer " + pw) { res.statusCode = 401; return res.end(); }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ data: { status: "ok" } }));
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  console.log("  \\x1b[2mEndpoint\\x1b[0m    http://127.0.0.1:" + port);
  console.log("  \\x1b[2mPassword\\x1b[0m    " + pw);
});
`,
    );
    const cli = { node: process.execPath, entry: fake };
    const gw = await ensureWorkbuddyGateway(home, { cli, timeoutMs: 15_000 });
    expect(gw).not.toBeNull();
    pids.push(gw!.pid);
    expect(gw!.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(gw!.password).toBe(`pw-${gw!.pid}`);

    const saved = JSON.parse(await readFile(workbuddyGatewayFile(home), "utf8"));
    expect(saved).toMatchObject({ endpoint: gw!.endpoint, password: gw!.password, pid: gw!.pid });
    if (!isWin) expect((await stat(workbuddyGatewayFile(home))).mode & 0o777).toBe(0o600);

    const again = await ensureWorkbuddyGateway(home, { cli, timeoutMs: 15_000 });
    expect(again?.pid).toBe(gw!.pid);
  });

  it("returns null when WorkBuddy predates 5.8", async () => {
    expect(await ensureWorkbuddyGateway(await tempHome(), { cli: null })).toBeNull();
  });
});

describe("workbuddy_cli.mjs on memento's gateway", () => {
  it("prints the sign-in link, waits for the login, then runs the prompt", async () => {
    const home = await tempHome();
    const password = "gateway-password";
    let signedIn = false;
    const seen: string[] = [];
    const server = createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${password}` || req.headers["x-codebuddy-request"] !== "1") {
        res.statusCode = 401;
        return res.end();
      }
      const url = req.url ?? "";
      if (url === "/api/v1/acp/connect") return res.end(JSON.stringify({ connectionId: "c1" }));
      if (url === "/api/v1/auth/account/login") {
        setTimeout(() => (signedIn = true), 500); // the user scans the code on their phone
        return res.end(JSON.stringify({ data: { success: true, authUrl: "https://www.workbuddy.cn/login?platform=workbuddy&state=s" } }));
      }
      if (url === "/api/v1/auth/account/status") return res.end(JSON.stringify({ data: { authenticated: signedIn } }));
      if (url === "/api/v1/acp") {
        const msg = JSON.parse(await body(req));
        seen.push(msg.method);
        res.setHeader("Content-Type", "text/event-stream");
        const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        if (msg.method === "session/new") {
          send(
            signedIn
              ? { jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1" } }
              : { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Authentication required", data: { category: "auth" } } },
          );
        } else if (msg.method === "session/prompt") {
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好，我在" } } },
          });
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        } else {
          send({ jsonrpc: "2.0", id: msg.id, result: {} });
        }
        return res.end();
      }
      res.statusCode = 404;
      res.end();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    await mkdir(join(home, ".memento"), { recursive: true });
    await writeFile(
      join(home, ".memento", "workbuddy-gateway.json"),
      JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, password, pid: process.pid, startedAt: Date.now() }),
    );

    const child = spawn(process.execPath, [RUNNER, "-p", "在吗"], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const code = await new Promise<number | null>((r) => child.on("close", r));

    expect(stderr).toContain("session id: sess-1");
    expect(code).toBe(0);
    expect(stdout).toContain("https://www.workbuddy.cn/login?platform=workbuddy&state=s");
    expect(stdout).toContain("WorkBuddy 已登录");
    expect(stdout).toContain("你好，我在");
    expect(seen.filter((m) => m === "session/new")).toHaveLength(2);
  }, 30_000);

  // The gateway outlives the runner, so stopping a task must stop its session there too.
  it.skipIf(isWin)("cancels the session on the gateway when the task is stopped", async () => {
    const home = await tempHome();
    const password = "pw";
    let cancelled: unknown = null;
    let release: (() => void) | null = null;
    const server = createServer(async (req, res) => {
      const url = req.url ?? "";
      if (url === "/api/v1/acp/connect") return res.end(JSON.stringify({ connectionId: "c1" }));
      const msg = JSON.parse(await body(req));
      if (msg.method === "session/cancel") {
        cancelled = msg.params;
        release?.();
        return res.end();
      }
      res.setHeader("Content-Type", "text/event-stream");
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (msg.method === "session/new") return res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-9" } })}\n\n`);
      if (msg.method === "session/prompt") {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "sess-9", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } } },
        });
        release = () => res.end(); // a long task, until it is cancelled
        return;
      }
      res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })}\n\n`);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    await mkdir(join(home, ".memento"), { recursive: true });
    await writeFile(join(home, ".memento", "workbuddy-gateway.json"), JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, password, pid: process.pid }));

    const child = spawn(process.execPath, [RUNNER, "-p", "long job"], { cwd: home, env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    const closed = new Promise<number | null>((r) => child.on("close", r));
    while (!stdout.includes("working")) await new Promise((r) => setTimeout(r, 50));
    child.kill("SIGTERM");

    expect(await closed).toBe(130);
    expect(cancelled).toEqual({ sessionId: "sess-9" });
  }, 30_000);

  it("cancels session directly via cancelWorkbuddySession", async () => {
    const home = await tempHome();
    const password = "pw";
    let cancelled: unknown = null;
    const server = createServer(async (req, res) => {
      const url = req.url ?? "";
      if (url === "/api/v1/health") return res.end("ok");
      if (url === "/api/v1/acp/connect") return res.end(JSON.stringify({ connectionId: "conn-cancel" }));
      const b = await body(req);
      if (!b) return res.end();
      const msg = JSON.parse(b);
      if (msg.method === "session/cancel") {
        cancelled = msg.params;
        return res.end(JSON.stringify({ ok: true }));
      }
      res.end("{}");
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    await mkdir(join(home, ".memento"), { recursive: true });
    await writeFile(join(home, ".memento", "workbuddy-gateway.json"), JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, password, pid: process.pid }));

    const ok = await cancelWorkbuddySession("sess-direct-cancel", home);
    expect(ok).toBe(true);
    expect(cancelled).toEqual({ sessionId: "sess-direct-cancel" });
  });
});
