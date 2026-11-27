// Multi-tool Agent Orchestrator: device dispatch, parallel read-only tools, loop guard & overflow recovery
// (server/server/services/orchestrator.py).
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";

import type { UserRow } from "../auth/current-user";
import type { Deps } from "../context";
import { withoutNul } from "../db/client";
import { deviceTasks, machines } from "../db/pulled/schema";
import { cleanSessionId, deviceOs } from "./agent-ids";
import { markUsageLimit } from "./agent-limits";
import { callChatCompletion, splitThinking, streamChatCompletion } from "./ai-provider";
import { deliverTask } from "./device-dispatch";
import { getCachedDeviceCapabilities, getDeviceEnvironmentSummary } from "./device-reports";
import { HEARTBEAT_WRITE_EVERY_MS } from "./device-service";
import {
  cleanGuardrailOutput,
  detectScenario,
  enrichDeviceListing,
  renderMindResonanceMarkdown,
  senseResonance,
  validateShellCommandAgainstIronRules,
} from "./mind-resonance-service";
import { termsFor } from "./guidance-service";
import { compactLoopMessages, isContextOverflowError, prepareAiHistory, type CompactState, type HistoryTurn } from "./orchestrator-context";
import { executeKnowledgeTool, KNOWLEDGE_TOOLS_SCHEMA, READ_ONLY_TOOL_NAMES } from "./orchestrator-tools";
import { getPublishedProfileContent } from "./profile-read";
import { normalizeDeviceName } from "./user-filter";
import { seesAll } from "./visibility";
import { wsManager } from "./ws-manager";

const MAX_AGENT_ITERATIONS = 16;
const REPEAT_TOOL_LIMIT = 4;

export const ORCHESTRATOR_SYSTEM_PROMPT = `你是用户的智能总控大脑（Memento Agent Orchestrator）。你可以：
1) 检索用户的全量历史对话、笔记、项目蓝图、长期核心记忆与知识图谱；
2) 在用户授权并在线的远程电脑上执行 shell 命令或调度本地 AI 编程代理（Claude Code / Codex / Antigravity / WorkBuddy）；
3) 查询与维护待办、检查操作前规矩与踩坑记录。

核心行为准则：
- 需要核查项目、历史记录、代码或文件时，主动调用相应工具查证事实，严禁凭记忆臆测或编造路径与结论。
- 动手执行部署、迁移、删改数据等重要操作前，先检查规则与踩坑。
- 回复始终简洁直接，先给结论再给依据；用纯文本列表 1), 2), 3) 组织要点，避免多余客套。`;

const DEVICE_TOOLS_SCHEMA: Record<string, unknown>[] = [
  {
    type: "function",
    function: {
      name: "list_devices",
      description: "列出用户当前已绑定的所有电脑设备（含在线状态、支持的工具代理、工作目录与推荐亲和场景）。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "run_on_device",
      description: "在指定在线设备上执行 shell 命令，或派发给本地编程代理（claude / codex / antigravity / workbuddy）执行任务。",
      parameters: {
        type: "object",
        properties: {
          device: { type: "string", description: "目标设备名或 device_id" },
          action: { type: "string", enum: ["shell", "agent"], description: "shell 执行命令；agent 启动本地编程代理" },
          command: { type: "string", description: "当 action=shell 时执行的命令" },
          prompt: { type: "string", description: "当 action=agent 时发给代理的指令" },
          binary: { type: "string", description: "agent 引擎：claude / codex / antigravity / workbuddy，默认 claude" },
          cwd: { type: "string", description: "工作目录绝对路径" },
          session_id: { type: "string", description: "可选：续接已有会话 ID" },
          timeout_seconds: { type: "integer", description: "超时时间（秒），默认 600" },
        },
        required: ["device", "action"],
      },
    },
  },
];

export async function listUserDevices(deps: Deps, user: UserRow, queryHint = ""): Promise<Record<string, unknown>[]> {
  const { db, settings } = deps;
  const rows = seesAll(user, settings)
    ? await db.select().from(machines).where(eq(machines.isArchived, false)).orderBy(desc(machines.lastHeartbeat))
    : await db
        .select()
        .from(machines)
        .where(and(eq(machines.userId, user.id), eq(machines.isArchived, false)))
        .orderBy(desc(machines.lastHeartbeat));

  const onlineIds = new Set(wsManager.connectedIds());
  const nowMs = Date.now();
  const rawList = rows.map((m) => {
    const devKey = m.collectorTokenHash || m.name;
    const wsConnected = onlineIds.has(m.collectorTokenHash) || onlineIds.has(m.name) || onlineIds.has(m.id);
    const hbMs = m.lastHeartbeat ? Date.parse(m.lastHeartbeat) : Number.NaN;
    const online = wsConnected || (Number.isFinite(hbMs) && nowMs - hbMs <= HEARTBEAT_WRITE_EVERY_MS * 3);
    const caps = getCachedDeviceCapabilities(m.collectorTokenHash, null, user, settings) ?? getCachedDeviceCapabilities(m.name, null, user, settings) ?? null;
    return {
      id: m.id,
      device_id: devKey,
      name: m.name,
      online,
      ws_connected: wsConnected,
      capabilities: caps,
    };
  });
  const scen = detectScenario(termsFor(queryHint), queryHint);
  return enrichDeviceListing(rawList, scen);
}

export async function resolveDeviceForUser(deps: Deps, user: UserRow, target: string) {
  const { db, settings } = deps;
  const rows = seesAll(user, settings)
    ? await db.select().from(machines).where(eq(machines.isArchived, false))
    : await db.select().from(machines).where(and(eq(machines.userId, user.id), eq(machines.isArchived, false)));
  const norm = normalizeDeviceName(target);
  return (
    rows.find((m) => m.id === target || m.collectorTokenHash === target || m.name === target || normalizeDeviceName(m.name) === norm) ??
    rows.find((m) => m.name.toLowerCase().includes(target.toLowerCase())) ??
    null
  );
}

export function deviceCwd(machineName: string, requestedCwd?: string | null): string | null {
  const cwd = (requestedCwd ?? "").trim();
  if (!cwd) return null;
  const os = deviceOs(machineName);
  const looksWinPath = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.includes("\\");
  const looksPosixPath = cwd.startsWith("/");
  if (os === "windows" && looksPosixPath) return null;
  if ((os === "macos" || os === "linux") && looksWinPath) return null;
  return cwd;
}

export async function runOnDevice(
  deps: Deps,
  user: UserRow,
  opts: {
    device: string;
    action: "shell" | "agent";
    command?: string;
    prompt?: string;
    binary?: string;
    cwd?: string | null;
    sessionId?: string | null;
    permissionMode?: string | null;
    conversationId?: string | null;
    timeoutSeconds?: number;
    systemPromptAppend?: string | null;
    model?: string | null;
    signal?: AbortSignal;
    onEvent?: (ev: Record<string, unknown>) => void;
  },
): Promise<Record<string, unknown>> {
  const { db, settings } = deps;
  if (!settings.remoteExec) {
    return { status: "failed", error: "远程执行未开启（MEMENTO_REMOTE_EXEC=0）" };
  }
  const machine = await resolveDeviceForUser(deps, user, opts.device);
  if (!machine) return { status: "failed", error: `未找到设备「${opts.device}」` };

  if (opts.action === "shell" && opts.command) {
    const [allowed, warning] = validateShellCommandAgainstIronRules(opts.command, machine.name);
    if (!allowed) return { status: "failed", error: warning || "命令被安全策略拦截" };
  }

  const deviceId = machine.collectorTokenHash || machine.name;
  const effectiveCwd = deviceCwd(machine.name, opts.cwd);
  const cleanSid = cleanSessionId(opts.sessionId, opts.binary);
  let sysAppend = (opts.systemPromptAppend ?? "").trim();
  if (opts.action === "agent" && !cleanSid) {
    const envSummary =
      getDeviceEnvironmentSummary(deviceId, user, settings) ??
      getDeviceEnvironmentSummary(machine.name, user, settings);
    if (envSummary) {
      const envBlock = `【目标设备就绪环境指纹画像】\n${envSummary}`;
      sysAppend = sysAppend ? `${envBlock}\n\n${sysAppend}` : envBlock;
    }
  }
  const timeoutSec = Math.min(3600, Math.max(30, opts.timeoutSeconds ?? 600));
  const taskId = randomUUID();
  const payload: Record<string, unknown> = {
    ...(opts.action === "shell" ? { command: opts.command || "" } : { prompt: opts.prompt || "", binary: opts.binary || "claude" }),
    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
    ...(cleanSid ? { session_id: cleanSid } : {}),
    ...(opts.permissionMode ? { permission_mode: opts.permissionMode } : {}),
    ...(opts.conversationId ? { conversation_id: opts.conversationId } : {}),
    ...(sysAppend ? { system_prompt_append: sysAppend } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  };

  const nowIso = new Date().toISOString();
  const [task] = await db
    .insert(deviceTasks)
    .values(
      withoutNul({
        id: taskId,
        deviceId,
        machineId: machine.id,
        userId: user.id,
        action: opts.action,
        payload,
        status: "queued",
        alerts: [],
        events: [],
        sessionId: cleanSessionId(opts.sessionId, opts.binary),
        timeoutSeconds: timeoutSec,
        createdAt: nowIso,
      }),
    )
    .returning();

  const streamQ = await wsManager.subscribeTask(taskId);
  try {
    const { sent: delivered } = await deliverTask(db, task!, machine);
    if (!delivered) {
      return { status: "failed", task_id: taskId, error: `设备「${machine.name}」当前离线或无法连接。` };
    }
    opts.onEvent?.({ type: "task_started", task_id: taskId, device: machine.name, action: opts.action });

    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) {
        await wsManager.sendCancel(deviceId, taskId);
        await db.update(deviceTasks).set({ status: "cancelled", error: "Cancelled by user", finishedAt: new Date().toISOString() }).where(eq(deviceTasks.id, taskId));
        return { status: "cancelled", task_id: taskId, error: "Cancelled by user" };
      }
      const ev = await streamQ.get(3000);
      if (ev) {
        opts.onEvent?.(ev);
        if (ev.type === "task_result") {
          const result = markUsageLimit({ ...ev, task_id: taskId, action: opts.action });
          return result;
        }
      } else {
        // Fallback DB check in case task finished on another replica
        const [fresh] = await db.select().from(deviceTasks).where(eq(deviceTasks.id, taskId)).limit(1);
        if (fresh && fresh.finishedAt) {
          return markUsageLimit({
            task_id: taskId,
            action: opts.action,
            status: fresh.status,
            exit_code: fresh.exitCode,
            stdout: fresh.stdout || "",
            stderr: fresh.stderr || "",
            error: fresh.error,
            session_id: fresh.sessionId,
          });
        }
      }
    }
    return { status: "timeout", task_id: taskId, error: `任务执行超过 ${timeoutSec} 秒超时` };
  } finally {
    wsManager.unsubscribeTask(taskId);
  }
}

export async function stopOrphanedAgentTasks(deps: Deps, userId: string, convId: string): Promise<string[]> {
  const { db } = deps;
  const rows = await db
    .select()
    .from(deviceTasks)
    .where(
      and(
        eq(deviceTasks.userId, userId),
        sql`${deviceTasks.payload}->>'conversation_id' = ${convId}`,
        inArray(deviceTasks.status, ["queued", "running", "still_running", "pending", "dispatched"]),
      ),
    );
  const ids: string[] = [];
  const nowIso = new Date().toISOString();
  for (const r of rows) {
    await db.update(deviceTasks).set({ status: "cancelled", error: "Cancelled by user", finishedAt: nowIso }).where(eq(deviceTasks.id, r.id));
    await wsManager.sendCancel(r.deviceId, r.id);
    ids.push(r.id);
  }
  return ids;
}

export interface AgentLoopEvent {
  type: "thinking" | "delta" | "tool_start" | "tool_end" | "sources" | "compact" | "error" | "done";
  [k: string]: unknown;
}

export async function* runAgentLoop(
  deps: Deps,
  user: UserRow,
  opts: {
    question: string;
    history?: HistoryTurn[];
    compactState?: CompactState | null;
    images?: string[];
    model?: string | null;
    project?: string | null;
    conversationId?: string | null;
    liveRules?: string[] | null;
    enableDeviceTools?: boolean;
    signal?: AbortSignal;
    onCompactUpdate?: (state: CompactState) => Promise<void>;
  },
): AsyncGenerator<AgentLoopEvent, { answer: string; thinking: string; steps: Record<string, unknown>[]; sources: Record<string, unknown>[] }, void> {
  const { db, settings } = deps;
  const redis = deps.redis();

  const sysParts = [ORCHESTRATOR_SYSTEM_PROMPT];
  const prof = await getPublishedProfileContent(db, redis, user).catch(() => null);
  if (prof) sysParts.push(`\n## 关于当前用户（常驻画像，请始终遵守）\n${prof}`);

  try {
    const res = await senseResonance(db, redis, user, { query: opts.question, project: opts.project ?? null, action: "agent" });
    const md = renderMindResonanceMarkdown(res, opts.liveRules);
    if (md) sysParts.push(`\n${md}`);
  } catch {
    /* ignore */
  }
  sysParts.push(`\n当前 UTC 时间：${new Date().toISOString()}`);

  const prep = await prepareAiHistory(settings, redis, opts.history ?? [], {
    user,
    compactState: opts.compactState,
    autoCompact: true,
  });
  if (prep.autoCompacted && prep.newCompactState) {
    await opts.onCompactUpdate?.(prep.newCompactState);
    yield { type: "compact", covered_turns: prep.newCompactState.covered_turns, summary_chars: prep.newCompactState.summary?.length ?? 0 };
  }

  let messages: Record<string, unknown>[] = [{ role: "system", content: sysParts.join("\n") }, ...prep.messages];
  if (opts.images?.length) {
    const parts: Record<string, unknown>[] = [{ type: "text", text: opts.question }];
    for (const img of opts.images.slice(0, 6)) {
      if (img.startsWith("data:image/") || img.startsWith("http://") || img.startsWith("https://")) {
        parts.push({ type: "image_url", image_url: { url: img } });
      }
    }
    messages.push({ role: "user", content: parts });
  } else {
    messages.push({ role: "user", content: opts.question });
  }

  const tools = opts.enableDeviceTools !== false && settings.remoteExec ? [...KNOWLEDGE_TOOLS_SCHEMA, ...DEVICE_TOOLS_SCHEMA] : KNOWLEDGE_TOOLS_SCHEMA;
  const steps: Record<string, unknown>[] = [];
  const allSources: Record<string, unknown>[] = [];
  const thinkingParts: string[] = [];
  const callCounts = new Map<string, number>();
  let finalAnswer = "";

  for (let iter = 0; iter < MAX_AGENT_ITERATIONS; iter++) {
    if (opts.signal?.aborted) break;
    messages = compactLoopMessages(messages);

    let data: Record<string, unknown>;
    try {
      [data] = await callChatCompletion(settings, redis, messages, {
        tools,
        temperature: 0.3,
        maxTokens: 3500,
        timeoutSec: 150,
        background: false,
        user,
        model: opts.model,
      });
    } catch (e) {
      if (isContextOverflowError(e)) {
        messages = compactLoopMessages(messages, 32_000);
        [data] = await callChatCompletion(settings, redis, messages, {
          tools,
          temperature: 0.3,
          maxTokens: 2500,
          timeoutSec: 150,
          background: false,
          user,
          model: opts.model,
        });
      } else {
        throw e;
      }
    }

    const choice = ((data.choices as Record<string, unknown>[] | undefined) ?? [])[0] ?? {};
    const msg = (choice.message as Record<string, unknown> | undefined) ?? {};
    const [thinking, clean] = splitThinking(msg.content as string | undefined, msg.reasoning_content as string | undefined);
    if (thinking) {
      thinkingParts.push(thinking);
      yield { type: "thinking", text: thinking };
    }

    const toolCalls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as Record<string, unknown>[]) : [];
    if (!toolCalls.length) {
      finalAnswer = cleanGuardrailOutput(clean || String(msg.content || ""));
      if (finalAnswer) yield { type: "delta", text: finalAnswer };
      break;
    }

    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: toolCalls,
    });

    const parsedCalls = toolCalls.map((tc) => {
      const fn = (tc.function as Record<string, unknown> | undefined) ?? {};
      const name = String(fn.name ?? "");
      let args: Record<string, unknown> = {};
      try {
        const parsed = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments;
        if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      return { id: String(tc.id ?? randomUUID()), name, args };
    });

    const allReadOnly = parsedCalls.every((c) => READ_ONLY_TOOL_NAMES.has(c.name));
    const runOne = async (c: { id: string; name: string; args: Record<string, unknown> }) => {
      const sig = `${c.name}:${JSON.stringify(c.args)}`;
      const cnt = (callCounts.get(sig) ?? 0) + 1;
      callCounts.set(sig, cnt);
      if (cnt > REPEAT_TOOL_LIMIT) {
        return { id: c.id, name: c.name, args: c.args, output: "检测到重复调用同一工具与参数，已熔断。请基于已有信息直接给出结论。", sources: undefined as Record<string, unknown>[] | undefined };
      }
      if (c.name === "list_devices") {
        const list = await listUserDevices(deps, user, opts.question);
        return { id: c.id, name: c.name, args: c.args, output: JSON.stringify(list, null, 2), sources: undefined };
      }
      if (c.name === "run_on_device") {
        const res = await runOnDevice(deps, user, {
          device: String(c.args.device ?? ""),
          action: c.args.action === "agent" ? "agent" : "shell",
          command: typeof c.args.command === "string" ? c.args.command : undefined,
          prompt: typeof c.args.prompt === "string" ? c.args.prompt : undefined,
          binary: typeof c.args.binary === "string" ? c.args.binary : undefined,
          cwd: typeof c.args.cwd === "string" ? c.args.cwd : null,
          sessionId: typeof c.args.session_id === "string" ? c.args.session_id : null,
          conversationId: opts.conversationId ?? null,
          timeoutSeconds: typeof c.args.timeout_seconds === "number" ? c.args.timeout_seconds : 600,
          signal: opts.signal,
        });
        return { id: c.id, name: c.name, args: c.args, output: JSON.stringify(res, null, 2).slice(0, 12_000), sources: undefined };
      }
      const res = await executeKnowledgeTool(deps, user, c.name, c.args, { userQuestion: opts.question, projectHint: opts.project });
      return { id: c.id, name: c.name, args: c.args, output: res.output, sources: res.sources };
    };

    for (const c of parsedCalls) {
      yield { type: "tool_start", tool: c.name, args: c.args, id: c.id };
    }

    const results = allReadOnly ? await Promise.all(parsedCalls.map(runOne)) : [];
    if (!allReadOnly) {
      for (const c of parsedCalls) results.push(await runOne(c));
    }

    for (const r of results) {
      if (r.sources?.length) {
        allSources.push(...r.sources);
        yield { type: "sources", sources: r.sources };
      }
      const preview = r.output.slice(0, 500);
      steps.push({ type: "tool_call", tool: r.name, name: r.name, args: r.args, output: preview });
      yield { type: "tool_end", tool: r.name, id: r.id, output: preview };
      messages.push({ role: "tool", tool_call_id: r.id, content: r.output.slice(0, 12_000) });
    }
  }

  // Fallback synthesis if loop exhausted without a final answer
  if (!finalAnswer && !opts.signal?.aborted) {
    messages.push({ role: "user", content: "请基于以上已收集的所有信息，直接给出最终总结与结论。" });
    let buf = "";
    for await (const chunk of streamChatCompletion(settings, redis, compactLoopMessages(messages), {
      temperature: 0.3,
      maxTokens: 2500,
      user,
      model: opts.model,
      signal: opts.signal,
    })) {
      if (chunk.type === "thinking") {
        thinkingParts.push(chunk.text);
        yield { type: "thinking", text: chunk.text };
      } else {
        buf += chunk.text;
        yield { type: "delta", text: chunk.text };
      }
    }
    finalAnswer = cleanGuardrailOutput(buf);
  }

  return { answer: finalAnswer, thinking: thinkingParts.join("\n\n").trim(), steps, sources: allSources };
}
