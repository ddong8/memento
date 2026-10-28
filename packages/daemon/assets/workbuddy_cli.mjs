#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { createInterface } from "node:readline";

// How long a task waits for the user to finish signing in through the printed link.
const LOGIN_WAIT_MS = 10 * 60 * 1000;

// Set once a session runs, so an interruption can stop it on the gateway too.
let activeCancel = null;
let terminating = false;

// SIGINT_SIGTERM_HANDLER: Graceful cancellation on system interruption
const cleanupAndExit = async (sig) => {
  terminating = true;
  try {
    process.stderr.write(`\n⏹️ [收到终止信号 (${sig})，已主动停止 WorkBuddy 任务]\n\n`);
  } catch {}
  // memento's gateway outlives this process: tell it to stop the session as well.
  if (activeCancel) {
    try {
      // Inside the 800 ms the daemon allows before SIGKILL.
      await Promise.race([activeCancel().catch(() => {}), new Promise((r) => setTimeout(r, 600))]);
    } catch {}
  }
  process.exit(130);
};
process.on("SIGINT", () => void cleanupAndExit("SIGINT"));
process.on("SIGTERM", () => void cleanupAndExit("SIGTERM"));

function parseArgs(argv) {
  const out = {
    resumeId: "",
    model: "",
    effort: "",
    sysAppend: "",
    timeout: 1800,
    prompt: "",
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--resume" || a === "-r") && i + 1 < argv.length) {
      out.resumeId = String(argv[++i] ?? "").trim();
    } else if (a.startsWith("--resume=")) {
      out.resumeId = a.slice("--resume=".length).trim();
    } else if (a === "--resume-create-missing") {
      out.resumeCreateMissing = true;
    } else if ((a === "--session-id" || a === "-s") && i + 1 < argv.length) {
      out.resumeId = String(argv[++i] ?? "").trim();
    } else if (a.startsWith("--session-id=")) {
      out.resumeId = a.slice("--session-id=".length).trim();
    } else if ((a === "--output-format" || a === "-o") && i + 1 < argv.length) {
      out.outputFormat = String(argv[++i] ?? "").trim();
    } else if (a.startsWith("--output-format=")) {
      out.outputFormat = a.slice("--output-format=".length).trim();
    } else if ((a === "--model" || a === "-m") && i + 1 < argv.length) {
      out.model = String(argv[++i] ?? "").trim();
    } else if (a.startsWith("--model=")) {
      out.model = a.slice("--model=".length).trim();
    } else if (a === "--effort" && i + 1 < argv.length) {
      out.effort = String(argv[++i] ?? "").trim();
    } else if (a.startsWith("--effort=")) {
      out.effort = a.slice("--effort=".length).trim();
    } else if (a === "--append-system-prompt" && i + 1 < argv.length) {
      out.sysAppend = String(argv[++i] ?? "").trim();
    } else if (a === "--timeout" && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) out.timeout = n;
    } else if (a.startsWith("--timeout=")) {
      const n = Number(a.slice("--timeout=".length));
      if (Number.isFinite(n) && n > 0) out.timeout = n;
    } else if ((a === "-p" || a === "--print") && i + 1 < argv.length) {
      positional.push(String(argv[++i] ?? ""));
    } else if (!a.startsWith("-")) {
      positional.push(a);
    }
  }
  out.prompt = positional.join(" ").trim();
  return out;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function probeEndpoint(endpoint, authHeaders = {}) {
  try {
    const res = await fetch(`${endpoint}/api/v1/acp/connect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...authHeaders,
      },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && typeof data.connectionId === "string") {
      return { endpoint, connectionId: data.connectionId, authHeaders, managed: Object.keys(authHeaders).length > 0 };
    }
  } catch {
    // unreachable
  }
  return null;
}

/**
 * The files of the gateways memento's daemon serves on WorkBuddy ≥ 5.8 (see src/workbuddy.ts), in the order
 * to try them. MEMENTO_GATEWAY_FILE GATEWAY_PER_CWD: the daemon starts one per task directory and names its
 * file in MEMENTO_WORKBUDDY_GATEWAY_FILE; the shared one is the fallback.
 */
function mementoGatewayFiles(home) {
  const shared = join(home, ".memento", "workbuddy-gateway.json");
  const own = process.env.MEMENTO_WORKBUDDY_GATEWAY_FILE;
  return own && own !== shared ? [own, shared] : [shared];
}

function mementoGateway(file) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (typeof raw?.endpoint === "string" && typeof raw?.password === "string") {
      return {
        endpoint: raw.endpoint.replace(/\/+$/, ""),
        authHeaders: { Authorization: `Bearer ${raw.password}`, "x-codebuddy-request": "1" },
        // It saves the login in a credential file of its own, so signing in once lasts across restarts.
        keepsLogin: raw.credentials === "own-file",
        // The directory its sessions run in (unset: memento's own folder).
        cwd: typeof raw.cwd === "string" ? raw.cwd : "",
      };
    }
  } catch {
    // not serving one
  }
  return null;
}

/** Whether two paths name the same directory. */
function sameDir(a, b) {
  if (!a || !b) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const [x, y] = [real(a), real(b)];
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

async function discoverGateway(home) {
  for (const file of mementoGatewayFiles(home)) {
    const managed = mementoGateway(file);
    if (!managed) continue;
    const ok = await probeEndpoint(managed.endpoint, managed.authHeaders);
    if (ok) return { ...ok, keepsLogin: managed.keepsLogin, cwd: managed.cwd };
  }
  const candidates = [];
  const lgState = join(home, ".workbuddy", "local-gateway", "state.json");
  try {
    if (existsSync(lgState)) {
      const raw = JSON.parse(readFileSync(lgState, "utf8"));
      if (typeof raw?.port === "number" && raw.port > 0) {
        candidates.push({
          endpoint: `http://127.0.0.1:${raw.port}`,
          startedAt: Number(statSync(lgState).mtimeMs ?? Date.now()),
        });
      }
    }
  } catch {
    // ignore
  }

  const sessionsDir = join(home, ".workbuddy", "sessions");
  try {
    for (const f of readdirSync(sessionsDir)) {
      if (!f.endsWith(".json")) continue;
      const full = join(sessionsDir, f);
      try {
        const raw = JSON.parse(readFileSync(full, "utf8"));
        if (typeof raw?.endpoint === "string" && raw.endpoint.startsWith("http://127.0.0.1:")) {
          candidates.push({
            endpoint: raw.endpoint.replace(/\/+$/, ""),
            startedAt: Number(raw.startedAt ?? statSync(full).mtimeMs ?? 0),
          });
        }
      } catch {
        // ignore broken session file
      }
    }
  } catch {
    // no sessions dir
  }
  candidates.sort((a, b) => b.startedAt - a.startedAt);
  for (const c of candidates) {
    const ok = await probeEndpoint(c.endpoint);
    if (ok) return ok;
  }
  return null;
}

async function ensureGatewayRunning(home) {
  let gw = await discoverGateway(home);
  if (gw) return gw;
  // WorkBuddy ≥ 5.8: memento's daemon serves the gateway; launching the app won't bring one up.
  if (mementoGatewayFiles(home).some((f) => existsSync(f))) return null;

  // Try launching WorkBuddy desktop app if installed so its local gateway boots up
  if (process.platform === "darwin") {
    const macApps = ["/Applications/WorkBuddy.app", join(home, "Applications", "WorkBuddy.app")];
    for (const appPath of macApps) {
      if (existsSync(appPath)) {
        try {
          const child = spawn("open", ["-g", "-a", appPath], { detached: true, stdio: "ignore" });
          child.unref();
        } catch {
          // ignore
        }
        break;
      }
    }
  } else if (process.platform === "win32") {
    const winCandidates = [
      join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "WorkBuddy", "WorkBuddy.exe"),
      join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "WorkBuddy", "WorkBuddy.exe"),
      "C:\\Program Files\\WorkBuddy\\WorkBuddy.exe",
      "C:\\Program Files (x86)\\WorkBuddy\\WorkBuddy.exe",
      "D:\\Program Files\\WorkBuddy\\WorkBuddy.exe",
    ];
    for (const exe of winCandidates) {
      if (existsSync(exe)) {
        try {
          const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: true });
          child.unref();
        } catch {
          // ignore
        }
        break;
      }
    }
  } else if (process.platform === "linux") {
    const linuxCandidates = [
      "/opt/WorkBuddy/workbuddy",
      "/opt/workbuddy/workbuddy",
      "/usr/bin/workbuddy-app",
      "/usr/local/bin/workbuddy-app",
      join(home, ".local", "share", "WorkBuddy", "workbuddy"),
    ];
    for (const bin of linuxCandidates) {
      if (existsSync(bin)) {
        try {
          const child = spawn(bin, [], { detached: true, stdio: "ignore" });
          child.unref();
        } catch {
          // ignore
        }
        break;
      }
    }
  }

  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 500));
    gw = await discoverGateway(home);
    if (gw) return gw;
  }
  return null;
}

/** Asks memento's gateway for a WorkBuddy sign-in link, prints it, and waits until the user has signed in. */
async function signIn(gw) {
  const headers = { "Content-Type": "application/json", Accept: "application/json", ...gw.authHeaders };
  let authUrl = "";
  try {
    const res = await fetch(`${gw.endpoint}/api/v1/auth/account/login`, {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(30000),
    });
    authUrl = (await res.json())?.data?.authUrl ?? "";
  } catch {
    // reported below
  }
  if (!authUrl) {
    process.stderr.write("WorkBuddy 需要登录，但没能取到登录链接，请稍后重试。\n");
    return false;
  }
  const minutes = Math.round(LOGIN_WAIT_MS / 60000);
  process.stdout.write(
    `\n🔐 WorkBuddy 需要登录一次：新版 WorkBuddy（5.8 起）不再允许其他程序沿用桌面端的登录。\n` +
      `已在这台设备的浏览器打开登录页，浏览器里已登录 WorkBuddy 时会自动完成；也可以在手机上打开下面的链接登录。` +
      (gw.keepsLogin
        ? `登录后任务会自动继续（${minutes} 分钟内有效）。登录会保存在这台设备上，之后 Memento 或电脑重启都不用再登录：\n\n${authUrl}\n\n`
        : `登录后任务会自动继续（${minutes} 分钟内有效；设备重启后需要重新登录）：\n\n${authUrl}\n\n`),
  );
  const deadline = Date.now() + LOGIN_WAIT_MS;
  let lastNote = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const res = await fetch(`${gw.endpoint}/api/v1/auth/account/status`, { headers, signal: AbortSignal.timeout(5000) });
      const data = (await res.json())?.data;
      if (data?.authenticated) {
        process.stdout.write("✅ WorkBuddy 已登录，继续执行任务…\n\n");
        return true;
      }
      if (data?.loginError) {
        process.stderr.write(`WorkBuddy 登录没有完成：${data.loginError}\n`);
        return false;
      }
    } catch {
      // keep waiting
    }
    if (Date.now() - lastNote > 120000) {
      lastNote = Date.now();
      process.stdout.write("⏳ 仍在等待 WorkBuddy 登录…\n");
    }
  }
  process.stderr.write("等待 WorkBuddy 登录超时，请重新发起任务。\n");
  return false;
}

function parseSseFrames(rawText) {
  const results = [];
  for (const line of rawText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr.startsWith("{")) continue;
    try {
      results.push(JSON.parse(jsonStr));
    } catch {
      // skip invalid json
    }
  }
  return results;
}

function extractImageBlocks(promptText) {
  const blocks = [];
  const seen = new Set();
  const re = /((?:\/tmp\/memento_images\/|[a-zA-Z]:[\\/][^\s\n\r"'`]*memento_images[\\/])[^\s\n\r"'`]+\.(?:png|jpg|jpeg|webp|gif))/gi;
  for (const m of promptText.matchAll(re)) {
    const imgPath = m[1];
    if (!imgPath || seen.has(imgPath) || !existsSync(imgPath)) continue;
    seen.add(imgPath);
    try {
      const data = readFileSync(imgPath).toString("base64");
      const ext = extname(imgPath).toLowerCase().replace(".", "");
      const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext || "png"}`;
      blocks.push({ type: "image", data, mimeType });
    } catch {
      // ignore unreadable image
    }
  }
  return blocks;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let prompt = args.prompt;
  if (!prompt) prompt = await readStdin();
  if (!prompt) {
    process.stderr.write("Error: empty prompt\n");
    process.exit(1);
  }

  const home = homedir();
  const cwd = process.cwd();
  const gw = await ensureGatewayRunning(home);
  if (!gw) {
    process.stderr.write(
      mementoGatewayFiles(home).some((f) => existsSync(f))
        ? "💡 memento 为 WorkBuddy 启动的本地服务没有响应，请稍后重试；仍不行请重启 Memento 客户端。\n"
        : "💡 未检测到正在运行的 WorkBuddy 本地网关服务。请先启动 WorkBuddy 客户端并登录账号后再试。\n",
    );
    process.exit(1);
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...gw.authHeaders,
    "acp-connection-id": gw.connectionId,
  };

  let reqId = 1;
  const rpcCall = async (method, params, timeoutMs = 15000) => {
    const id = reqId++;
    const res = await fetch(`${gw.endpoint}/api/v1/acp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const frames = parseSseFrames(text);
    const reply = frames.find((f) => f.id === id);
    return { frames, reply };
  };

  await rpcCall("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "memento", version: process.env.MEMENTO_DESKTOP_VERSION || "1.0.90" },
    // NO_CLIENT_FS_TERMINAL: whatever the client claims, WorkBuddy hands its Read/Write/Edit/Bash to it
    // (fs/*, terminal/* requests) instead of running them itself. This runner doesn't serve those, so it
    // claims none and WorkBuddy runs every tool on its own, in the session's cwd.
    clientCapabilities: {},
  });

  const isAuthError = (reply) => {
    const e = reply?.error;
    return !!e && (e.data?.category === "auth" || /Authentication required/i.test(String(e.message ?? "")));
  };
  const newSession = async () => {
    const created = await rpcCall("session/new", { cwd, mcpServers: [] });
    for (const f of created.frames) {
      const sid = f?.params?.sessionId ?? f?.result?.sessionId;
      if (typeof sid === "string" && sid) return { sessionId: sid, reply: created.reply };
    }
    return { sessionId: "", reply: created.reply };
  };
  const openSession = async () => {
    if (args.resumeId) {
      const resumed = await rpcCall("session/resume", {
        sessionId: args.resumeId,
        cwd,
      });
      if (!resumed.reply?.error) return { sessionId: args.resumeId, reply: resumed.reply };
      if (isAuthError(resumed.reply)) return { sessionId: "", reply: resumed.reply };
      // If resume failed on this device, fall back to a new session
    }
    return newSession();
  };

  let opened = await openSession();
  // memento's own gateway (WorkBuddy ≥ 5.8) needs one sign-in; it lives until the gateway restarts.
  if (!opened.sessionId && gw.managed && isAuthError(opened.reply) && (await signIn(gw))) {
    opened = await openSession();
  }
  const sessionId = opened.sessionId;
  if (!sessionId) {
    const why = opened.reply?.error?.message;
    process.stderr.write(`Error: failed to initialize WorkBuddy ACP session${why ? `: ${why}` : ""}\n`);
    process.exit(1);
  }
  activeCancel = () =>
    fetch(`${gw.endpoint}/api/v1/acp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }),
      signal: AbortSignal.timeout(1500),
    });

  process.stderr.write(`session id: ${sessionId}\n`);

  await rpcCall("session/set_mode", {
    sessionId,
    modeId: "bypassPermissions",
  }).catch(() => {});

  if (args.model) {
    await rpcCall("session/set_model", {
      sessionId,
      modelId: args.model,
    }).catch(() => {});
    await rpcCall("session/set_config_option", {
      sessionId,
      configId: "model",
      value: args.model,
    }).catch(() => {});
  }

  if (args.effort) {
    await rpcCall("session/set_config_option", {
      sessionId,
      configId: "thought_level",
      value: args.effort,
    }).catch(() => {});
  }

  // TASK_CWD_NOTE: a gateway runs every session in its own directory (session/new's cwd is ignored). One started
  // in the task's directory needs no note; any other (the shared one, the desktop app's) gets told where it is.
  const cwdNote = sameDir(gw.cwd, cwd)
    ? ""
    : `【工作目录】本任务的工作目录是 ${cwd}。读写文件请用这个目录下的绝对路径，执行命令前先 cd 到这个目录。`;
  const finalPrompt = [args.sysAppend, cwdNote, prompt].filter(Boolean).join("\n\n");
  const promptBlocks = [...extractImageBlocks(finalPrompt), { type: "text", text: finalPrompt }];

  const promptId = reqId++;
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), args.timeout * 1000);

  let printedText = false;
  let lastToolId = "";
  let thoughtShown = false;

  // Questions WorkBuddy holds open for the user. Its AskUserQuestion comes as session/request_permission
  // (the questions in toolCall.rawInput) and is answered through _codebuddy.ai/resolveInterruption, as the
  // WorkBuddy app answers it; other permission requests take the option the user picks.
  const asks = new Map(); // ask id -> { rpcId, toolCallId, kind, questions, options, answers }
  const openQuestions = []; // [question id, ask id, index]
  const emit = (event) => process.stdout.write(`\n${JSON.stringify({ type: "memento_event", event })}\n`);
  const reply = (id, result) =>
    fetch(`${gw.endpoint}/api/v1/acp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, result }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
  const replyError = (id, error) =>
    fetch(`${gw.endpoint}/api/v1/acp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, error }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);

  const onPermissionRequest = (obj) => {
    const p = obj.params ?? {};
    const tc = p.toolCall ?? {};
    const toolName = String(tc._meta?.["codebuddy.ai/toolName"] ?? "");
    const askId = `wb_${String(tc.toolCallId ?? obj.id)}`;
    const options = Array.isArray(p.options) ? p.options : [];
    const questions = toolName === "AskUserQuestion" && Array.isArray(tc.rawInput?.questions) ? tc.rawInput.questions : [];
    if (questions.length) {
      asks.set(askId, { rpcId: obj.id, toolCallId: tc.toolCallId, kind: "ask", questions, options, answers: {} });
      questions.forEach((q, i) => {
        openQuestions.push([`${askId}:${i}`, askId, i]);
        emit({
          kind: "question",
          id: `${askId}:${i}`,
          tool: "AskUserQuestion",
          ...(q.header ? { header: String(q.header) } : {}),
          question: String(q.question ?? "请选择或确认下一步操作"),
          options: (q.options ?? []).map((o) =>
            typeof o === "string" ? o : { label: String(o.label ?? ""), ...(o.description ? { description: String(o.description) } : {}) },
          ),
          is_multi_select: Boolean(q.multiSelect),
          status: "waiting",
        });
      });
      return;
    }
    asks.set(askId, { rpcId: obj.id, kind: "permission", options, answers: {} });
    openQuestions.push([`${askId}:0`, askId, 0]);
    const detail = tc.rawInput?.command ?? tc.rawInput?.target ?? tc.title ?? "";
    emit({
      kind: "question",
      id: `${askId}:0`,
      tool: toolName || "permission",
      question: `WorkBuddy 请求授权：${toolName || "操作"}${detail ? `\n${detail}` : ""}`,
      options: options.map((o) => String(o.name ?? o.optionId)),
      is_multi_select: false,
      status: "waiting",
    });
  };

  const answerQuestion = async (questionId, text) => {
    const at = openQuestions.findIndex(([id]) => !questionId || id === questionId);
    if (at < 0) return false;
    const [, askId, index] = openQuestions.splice(at, 1)[0];
    const a = asks.get(askId);
    a.answers[index] = text;
    if (a.kind === "permission") {
      asks.delete(askId);
      const chosen = a.options.find((o) => String(o.name ?? o.optionId) === text.trim()) ?? a.options.find((o) => String(o.kind ?? "").startsWith("reject"));
      await reply(a.rpcId, chosen ? { outcome: { outcome: "selected", optionId: chosen.optionId } } : { outcome: { outcome: "cancelled" } });
      return true;
    }
    if (Object.keys(a.answers).length < a.questions.length) return true;
    asks.delete(askId);
    const answers = {};
    a.questions.forEach((q, i) => {
      answers[String(q.question ?? `q_${i}`)] = a.answers[i];
    });
    const { reply: r } = await rpcCall("_codebuddy.ai/resolveInterruption", { sessionId, toolCallId: a.toolCallId, decision: "allow", answers }).catch(
      () => ({}),
    );
    if (!r?.result?.resolved) {
      // Answers not taken: decline the request rather than leave WorkBuddy waiting on it
      process.stderr.write(`\n⚠️ [WorkBuddy 没有收下这次回答${r?.error?.message ? `：${r.error.message}` : ""}]\n`);
      await reply(a.rpcId, { outcome: { outcome: "cancelled" } });
    }
    return true;
  };

  // stdin, one line each: a memento_answer for a question above, else a follow-up for the session
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", async (line) => {
    const raw = line.trim();
    if (!raw) return;
    let qid;
    let text = raw;
    if (raw.startsWith("{")) {
      try {
        const m = JSON.parse(raw);
        if (m?.type === "memento_answer") {
          qid = m.question_id || undefined;
          text = String(m.answer ?? "");
        }
      } catch {
        // plain text after all
      }
    }
    if (await answerQuestion(qid, text)) return;
    await rpcCall("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    }).catch(() => {});
  });

  try {
    const res = await fetch(`${gw.endpoint}/api/v1/acp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: promptId,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: promptBlocks,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      process.stderr.write(`WorkBuddy ACP HTTP error: ${res.status}\n`);
      process.exit(1);
    }

    const decoder = new TextDecoder("utf8");
    let buffer = "";
    let answered = false;
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr.startsWith("{")) continue;
        let obj;
        try {
          obj = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        if (obj.method === "session/request_permission" && obj.id != null) {
          onPermissionRequest(obj);
          continue;
        }
        // UNHANDLED_CLIENT_REQUEST: any other request waits on this client for good unless refused.
        if (typeof obj.method === "string" && obj.id != null) {
          void replyError(obj.id, { code: -32601, message: `Method not found: ${obj.method} (memento does not serve it)` });
          continue;
        }

        if (obj.method === "session/update" && obj.params?.update) {
          const upd = obj.params.update;
          const kind = upd.sessionUpdate;
          if (kind === "agent_thought_chunk") {
            const t = upd.content?.text ?? "";
            if (t && !thoughtShown) {
              const clean = t.replace(/\s+/g, " ").trim().slice(0, 60);
              if (clean) {
                thoughtShown = true;
                process.stdout.write(`\n⚡ [深度思考: ${clean}...]\n`);
              }
            }
          } else if (kind === "tool_call") {
            const tcId = upd.toolCallId ?? "";
            if (tcId !== lastToolId) {
              lastToolId = tcId;
              const toolName = upd._meta?.["codebuddy.ai/toolName"] ?? upd.title ?? upd.kind ?? "tool";
              const title = upd.title && upd.title !== toolName ? `${toolName}: ${upd.title}` : toolName;
              process.stdout.write(`\n⚡ [${String(title).replace(/[\r\n]+/g, " ").slice(0, 120)}]\n`);
            }
          } else if (kind === "agent_message_chunk") {
            const t = upd.content?.text ?? "";
            if (t) {
              if (!printedText && (thoughtShown || lastToolId)) {
                process.stdout.write("\n");
              }
              printedText = true;
              process.stdout.write(t);
            }
          }
        } else if (obj.id === promptId) {
          if (obj.error) {
            process.stderr.write(`\nWorkBuddy Error: ${obj.error.message || JSON.stringify(obj.error)}\n`);
            process.exit(1);
          }
          if (obj.result?.errorMessage) {
            process.stderr.write(`\nWorkBuddy Error: ${obj.result.errorMessage}\n`);
            if (!printedText) process.exit(1);
          }
          // The prompt's own response is the last frame; the gateway may keep the stream open after it.
          answered = true;
          break;
        }
      }
      if (answered) break;
    }
    if (printedText) process.stdout.write("\n");
    if (!terminating) {
      try {
        process.stdin.pause();
        process.stdin.destroy();
      } catch {}
      process.exit(0);
    }
  } catch (err) {
    if (controller.signal.aborted) {
      process.stderr.write(`\n[Agent timeout: 任务执行已达到安全上限（${args.timeout}s）]\n`);
      process.exit(124);
    }
    process.stderr.write(`\nWorkBuddy execution error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  } finally {
    clearTimeout(timeoutTimer);
  }
}

main();
