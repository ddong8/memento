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
  WORKBUDDY_GATEWAY_AUTH_ID,
  workbuddyBundledNode,
  workbuddyCliKeepsOwnLogin,
  workbuddyGatewayEnv,
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

/** What the real 5.8.3 bundle contains that lets the gateway keep its login in a file of its own. */
const OWN_LOGIN_CODE = [
  'credentialsInMemory(){return"1"===process.env.CODEBUDDY_CREDENTIALS_IN_MEMORY}',
  "async getAuthSavePath(){let t=this.productManager.configuration.getValue()?.authentication?.id;}",
  "function readEnvProductAuthId(){for(let t of Oc){}}",
  'let Oc=["ACC_PRODUCT_CONFIG_V3","ACC_PRODUCT_CONFIG_V2"];',
  'return"ACC_PRODUCT_CONFIG"===i&&delete n.authentication;',
].join("\n");

/**
 * Stands in for `codebuddy-lite-wb.mjs --serve`: same banner, same password check, the account status route.
 * It writes the environment it got to `env-<pid>.json`; `signed-in` next to it makes it report a login.
 */
async function fakeCli(home: string, options: { ownLogin?: boolean } = {}): Promise<string> {
  const fake = join(home, "fake-cli.mjs");
  await writeFile(
    fake,
    `import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const pw = "pw-" + process.pid;
if (process.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE !== "1") process.exit(3);
writeFileSync(join(here, "env-" + process.pid + ".json"), JSON.stringify({
  inMemory: process.env.CODEBUDDY_CREDENTIALS_IN_MEMORY ?? null,
  productConfig: process.env.ACC_PRODUCT_CONFIG_V3 ?? null,
}));
const server = createServer((req, res) => {
  if (req.headers.authorization !== "Bearer " + pw) { res.statusCode = 401; return res.end(); }
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/v1/auth/account/status") {
    return res.end(JSON.stringify({ data: { authenticated: existsSync(join(here, "signed-in")) } }));
  }
  res.end(JSON.stringify({ data: { status: "ok" } }));
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  console.log("  \\x1b[2mEndpoint\\x1b[0m    http://127.0.0.1:" + port);
  console.log("  \\x1b[2mPassword\\x1b[0m    " + pw);
});
${options.ownLogin === false ? "" : `/*\n${OWN_LOGIN_CODE}\n*/`}
`,
  );
  return fake;
}

const envOf = async (home: string, pid: number) =>
  JSON.parse(await readFile(join(home, `env-${pid}.json`), "utf8")) as { inMemory: string | null; productConfig: string | null };

/** A gateway started the way 1.0.72 to 1.0.79 did: login in memory, recorded as such. */
async function memoryGateway(home: string, fake: string): Promise<{ pid: number; exited: Promise<unknown> }> {
  const child = spawn(process.execPath, [fake, "--serve", "--host", "127.0.0.1"], {
    env: { ...process.env, CODEBUDDY_CREDENTIALS_IN_MEMORY: "1", CODEBUDDY_FORCE_LITE_WB_BUNDLE: "1" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  pids.push(child.pid!);
  let banner = "";
  await new Promise<void>((resolve) =>
    child.stdout!.on("data", (c) => {
      banner += String(c);
      if (parseGatewayBanner(banner)) resolve();
    }),
  );
  await mkdir(join(home, ".memento"), { recursive: true });
  await writeFile(
    workbuddyGatewayFile(home),
    JSON.stringify({ ...parseGatewayBanner(banner)!, pid: child.pid!, startedAt: Date.now(), entry: fake, credentials: "memory" }),
  );
  return { pid: child.pid!, exited: new Promise((r) => child.once("exit", r)) };
}

describe("memento's WorkBuddy gateway", () => {
  it("starts the bundled CLI once, records how to reach it, and reuses it", async () => {
    const home = await tempHome();
    const fake = await fakeCli(home);
    const cli = { node: process.execPath, entry: fake };
    const gw = await ensureWorkbuddyGateway(home, { cli, timeoutMs: 15_000 });
    expect(gw).not.toBeNull();
    pids.push(gw!.pid);
    expect(gw!.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(gw!.password).toBe(`pw-${gw!.pid}`);

    const saved = JSON.parse(await readFile(workbuddyGatewayFile(home), "utf8"));
    expect(saved).toMatchObject({ endpoint: gw!.endpoint, password: gw!.password, pid: gw!.pid, credentials: "own-file" });
    if (!isWin) expect((await stat(workbuddyGatewayFile(home))).mode & 0o777).toBe(0o600);
    // The login goes to auth/memento-gateway.info, not the desktop's file, and not just into memory.
    expect(await envOf(home, gw!.pid)).toEqual({
      inMemory: null,
      productConfig: JSON.stringify({ authentication: { id: WORKBUDDY_GATEWAY_AUTH_ID } }),
    });

    const again = await ensureWorkbuddyGateway(home, { cli, timeoutMs: 15_000 });
    expect(again?.pid).toBe(gw!.pid);
  });

  it("keeps the login in memory on a CLI that can't name its own credential file", async () => {
    const home = await tempHome();
    const fake = await fakeCli(home, { ownLogin: false });
    const gw = await ensureWorkbuddyGateway(home, { cli: { node: process.execPath, entry: fake }, timeoutMs: 15_000 });
    pids.push(gw!.pid);
    expect(gw).toMatchObject({ credentials: "memory" });
    expect(await envOf(home, gw!.pid)).toEqual({ inMemory: "1", productConfig: null });
  });

  it("moves a memory gateway to its own file only when nobody is signed in and no task is on it", async () => {
    const home = await tempHome();
    const fake = await fakeCli(home);
    const cli = { node: process.execPath, entry: fake };
    const old = await memoryGateway(home, fake);

    // Signed in: replacing it would cost the user a login, so it stays until it exits.
    await writeFile(join(home, "signed-in"), "");
    expect((await ensureWorkbuddyGateway(home, { cli, timeoutMs: 15_000 }))?.pid).toBe(old.pid);
    await rm(join(home, "signed-in"));
    // Another task is on it (maybe waiting for that very login).
    expect((await ensureWorkbuddyGateway(home, { cli, timeoutMs: 15_000, busy: true }))?.pid).toBe(old.pid);

    const gw = await ensureWorkbuddyGateway(home, { cli, timeoutMs: 15_000 });
    pids.push(gw!.pid);
    expect(gw!.pid).not.toBe(old.pid);
    expect(gw).toMatchObject({ credentials: "own-file" });
    await old.exited;
  }, 30_000);

  it("replaces a gateway from 1.0.71, which saved the login into the desktop's credential file", async () => {
    const home = await tempHome();
    const fake = await fakeCli(home);
    const cli = { node: process.execPath, entry: fake };
    const legacy = await memoryGateway(home, fake);
    const { credentials: _, entry: __, ...old } = JSON.parse(await readFile(workbuddyGatewayFile(home), "utf8"));
    await writeFile(workbuddyGatewayFile(home), JSON.stringify(old));
    // Even while signed in and with other tasks on it: every login it saves signs the desktop app out.
    await writeFile(join(home, "signed-in"), "");

    const gw = await ensureWorkbuddyGateway(home, { cli, timeoutMs: 15_000, busy: true });
    pids.push(gw!.pid);
    expect(gw!.pid).not.toBe(legacy.pid);
    expect(gw).toMatchObject({ credentials: "own-file", entry: fake });
    await legacy.exited;
  }, 20_000);

  it.skipIf(isWin)("leaves alone a process that reused a dead gateway's pid", async () => {
    const home = await tempHome();
    const fake = await fakeCli(home);
    const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    pids.push(other.pid!);
    await mkdir(join(home, ".memento"), { recursive: true });
    await writeFile(
      workbuddyGatewayFile(home),
      JSON.stringify({ endpoint: "http://127.0.0.1:9", password: "x", pid: other.pid, startedAt: 0, entry: fake, credentials: "memory" }),
    );

    const gw = await ensureWorkbuddyGateway(home, { cli: { node: process.execPath, entry: fake }, timeoutMs: 15_000 });
    pids.push(gw!.pid);
    expect(gw!.pid).not.toBe(other.pid);
    expect(() => process.kill(other.pid!, 0)).not.toThrow();
  });

  it("returns null when WorkBuddy predates 5.8", async () => {
    expect(await ensureWorkbuddyGateway(await tempHome(), { cli: null })).toBeNull();
  });

  it("keeps the login in memory when memento inherited WorkBuddy's product config", async () => {
    const home = await tempHome();
    const fake = await fakeCli(home);
    expect(await workbuddyCliKeepsOwnLogin(fake, {})).toBe(true);
    // The CLI would take the id from these before the one memento sets.
    expect(await workbuddyCliKeepsOwnLogin(fake, { ACC_PRODUCT_CONFIG_PATH: join(home, "spill.json") })).toBe(false);
    expect(await workbuddyCliKeepsOwnLogin(fake, { ACC_PRODUCT_CONFIG_V3: "{}" })).toBe(false);
    expect(await workbuddyCliKeepsOwnLogin(join(home, "missing.mjs"), {})).toBe(false);
  });

  it("never passes the in-memory switch on when the login has its own file", () => {
    const env = workbuddyGatewayEnv("/cfg", "own-file", { PATH: "/bin", CODEBUDDY_CREDENTIALS_IN_MEMORY: "1" });
    expect(env).toEqual({
      PATH: "/bin",
      CODEBUDDY_CONFIG_DIR: "/cfg",
      CODEBUDDY_FORCE_LITE_WB_BUNDLE: "1",
      SERVER__HOST: "127.0.0.1",
      ACC_PRODUCT_CONFIG_V3: '{"authentication":{"id":"memento-gateway"}}',
    });
    expect(workbuddyGatewayEnv("/cfg", "memory", { PATH: "/bin" })).toMatchObject({ CODEBUDDY_CREDENTIALS_IN_MEMORY: "1" });
    expect(workbuddyGatewayEnv("/cfg", "memory", { PATH: "/bin" }).ACC_PRODUCT_CONFIG_V3).toBeUndefined();
  });

  // Catches a WorkBuddy update that changes how the CLI names its credential file (machines with WorkBuddy only).
  const installed = findWorkbuddyLiteCli();
  it.skipIf(!installed)("recognises the installed WorkBuddy CLI", async () => {
    expect(await workbuddyCliKeepsOwnLogin(installed!.entry, {})).toBe(true);
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
      JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, password, pid: process.pid, startedAt: Date.now(), credentials: "own-file" }),
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
    expect(stdout).toContain("之后 Memento 或电脑重启都不用再登录");
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

  it.skipIf(isWin)("shows WorkBuddy's AskUserQuestion and returns the answers through resolveInterruption", async () => {
    const home = await tempHome();
    let resolved: Record<string, unknown> | null = null;
    let finish: (() => void) | null = null;
    const server = createServer(async (req, res) => {
      const url = req.url ?? "";
      if (url === "/api/v1/acp/connect") return res.end(JSON.stringify({ connectionId: "c1" }));
      const msg = JSON.parse(await body(req));
      res.setHeader("Content-Type", "text/event-stream");
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (msg.method === "session/new") return res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } })}\n\n`);
      if (msg.method === "_codebuddy.ai/resolveInterruption") {
        resolved = msg.params;
        res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { resolved: true, queued: false } })}\n\n`);
        finish?.();
        return;
      }
      if (msg.method === "session/prompt") {
        // As WorkBuddy does: the question is a permission request inside the prompt's stream
        send({
          jsonrpc: "2.0",
          id: 77,
          method: "session/request_permission",
          params: {
            sessionId: "s1",
            options: [{ kind: "allow", name: "Yes", optionId: "allow_once" }],
            toolCall: {
              toolCallId: "tc1",
              _meta: { "codebuddy.ai/toolName": "AskUserQuestion" },
              rawInput: { questions: [{ question: "选哪个颜色？", header: "颜色", options: [{ label: "红" }, { label: "蓝" }], multiSelect: false }] },
            },
          },
        });
        finish = () => {
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你选了蓝" } } } });
          res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } })}\n\n`);
        };
        return;
      }
      res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })}\n\n`);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    await mkdir(join(home, ".memento"), { recursive: true });
    await writeFile(join(home, ".memento", "workbuddy-gateway.json"), JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, password: "pw", pid: process.pid }));

    const child = spawn(process.execPath, [RUNNER, "-p", "ask me"], { cwd: home, env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    const closed = new Promise<number | null>((r) => child.on("close", r));
    while (!stdout.includes('"kind":"question"')) await new Promise((r) => setTimeout(r, 50));
    const question = JSON.parse(stdout.split("\n").find((l) => l.includes('"kind":"question"'))!).event;
    expect(question).toMatchObject({ id: "wb_tc1:0", tool: "AskUserQuestion", header: "颜色", question: "选哪个颜色？", options: [{ label: "红" }, { label: "蓝" }], status: "waiting" });

    child.stdin.write(`${JSON.stringify({ type: "memento_answer", question_id: question.id, answer: "蓝" })}\n`);
    expect(await closed).toBe(0);
    expect(resolved).toEqual({ sessionId: "s1", toolCallId: "tc1", decision: "allow", answers: { "选哪个颜色？": "蓝" } });
    expect(stdout).toContain("你选了蓝");
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

    // No session to name: nothing is cancelled, so the device's other WorkBuddy tasks keep running.
    expect(await cancelWorkbuddySession("", home)).toBe(false);
    expect(cancelled).toBeNull();

    const ok = await cancelWorkbuddySession("sess-direct-cancel", home);
    expect(ok).toBe(true);
    expect(cancelled).toEqual({ sessionId: "sess-direct-cancel" });
  });
});
