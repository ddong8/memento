#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

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

async function probeEndpoint(endpoint) {
  try {
    const res = await fetch(`${endpoint}/api/v1/acp/connect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && typeof data.connectionId === "string") {
      return { endpoint, connectionId: data.connectionId };
    }
  } catch {
    // unreachable
  }
  return null;
}

async function discoverGateway(home) {
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
    process.stderr.write("💡 未检测到正在运行的 WorkBuddy 本地网关服务。请先启动 WorkBuddy 客户端并登录账号后再试。\n");
    process.exit(1);
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
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
    clientInfo: { name: "memento", version: "1.0.68" },
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
  });

  let sessionId = "";
  if (args.resumeId) {
    const resumed = await rpcCall("session/resume", {
      sessionId: args.resumeId,
      cwd,
    });
    if (!resumed.reply?.error) {
      sessionId = args.resumeId;
    } else {
      // If resume failed on this device, fall back to a new session
      const created = await rpcCall("session/new", { cwd, mcpServers: [] });
      for (const f of created.frames) {
        const sid = f?.params?.sessionId ?? f?.result?.sessionId;
        if (typeof sid === "string" && sid) {
          sessionId = sid;
          break;
        }
      }
    }
  } else {
    const created = await rpcCall("session/new", { cwd, mcpServers: [] });
    for (const f of created.frames) {
      const sid = f?.params?.sessionId ?? f?.result?.sessionId;
      if (typeof sid === "string" && sid) {
        sessionId = sid;
        break;
      }
    }
  }

  if (!sessionId) {
    process.stderr.write("Error: failed to initialize WorkBuddy ACP session\n");
    process.exit(1);
  }

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

  const finalPrompt = args.sysAppend ? `${args.sysAppend}\n\n${prompt}` : prompt;
  const promptBlocks = [...extractImageBlocks(finalPrompt), { type: "text", text: finalPrompt }];

  const promptId = reqId++;
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), args.timeout * 1000);

  let printedText = false;
  let lastToolId = "";
  let thoughtShown = false;

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
        }
      }
    }
    if (printedText) process.stdout.write("\n");
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
