// Direct agent SSE streaming (with 20ms chunk coalescing, session reconciliation & handover resume)
// and runResponse helper (server/server/services/ask_stream.py).
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type { UserRow } from "../auth/current-user";
import type { Deps } from "../context";
import { withoutNul } from "../db/client";
import { deviceTasks } from "../db/pulled/schema";
import { HttpError, normalizeUuid } from "../http";
import { cleanSessionId, reportedSessionId } from "./agent-ids";
import { markUsageLimit, USAGE_LIMIT } from "./agent-limits";
import { askRuns, RunConflict, type RunStreamFactory } from "./ask-runs";
import {
  appendConversationTurns,
  extractRealAssistantContent,
  extractThinkingFromEvents,
  reconcileSession,
  sanitizeToolCallEntry,
} from "./ask-store";
import { storeImages } from "./chat-images";
import { deliverTask } from "./device-dispatch";
import { renderMindResonanceMarkdown, senseResonance } from "./mind-resonance-service";
import { resolveDeviceForUser } from "./orchestrator";
import { wsManager } from "./ws-manager";

export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

const SESSION_GONE = ["No conversation found", "session not found", "not found", "expired", "does not exist"];
const CHUNK_COALESCE_MS = 20;
const MAX_TASK_EVENTS = 800;
const MAX_COALESCE_CHARS = 32_768;

const TRANSIENT_LINE_RE =
  /^(?:(?:⚡|⏳|✅|⏹\uFE0F?|❌|🈳)\s*\[(?:后台任务|模型思考|等待用户|工具|任务在后台)[^\]]*\]|\[STATUS_STILL_RUNNING:[^\]]*\])/;

const STDERR_NOISE_RE = new RegExp(
  [
    "^\\s*npm\\s+(?:warn|WARN|notice|NOTICE)\\b.*",
    "^\\s*\\(node:\\d+\\)\\s+(?:\\[\\w+\\]\\s+)?(?:ExperimentalWarning|DeprecationWarning|Warning)\\b.*",
    "^\\s*\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was created\\)",
    "^\\s*Debugger attached\\..*",
    "^\\s*Waiting for the debugger to disconnect\\..*",
    "^\\s*Browserslist: caniuse-lite is outdated\\..*",
    "^\\s*(?:To|From)\\s+https?://.*",
    "^\\s*\\*\\s+\\[(?:new branch|new tag|branch)\\]\\s+.*",
    "^\\s*Switched to (?:a new )?branch\\s+.*",
    "^\\s*Already on\\s+.*",
    "^\\s*session id:\\s*[0-9a-fA-F-]+\\s*$",
  ]
    .map((p) => `(?:${p})`)
    .join("|"),
  "i",
);

function cleanStderrNoise(stderr: string): string {
  if (!stderr) return "";
  return stderr
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return Boolean(trimmed) && !STDERR_NOISE_RE.test(trimmed);
    })
    .join("\n")
    .trim();
}

function cleanAgentSummary(text: string): string {
  if (!text) return "";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    if (!TRANSIENT_LINE_RE.test(trimmed)) {
      start = i;
      break;
    }
  }
  if (start === -1) return text.replace(/\r\n/g, "\n").trim();
  return lines
    .slice(start)
    .filter((l) => !l.trim().startsWith("[STATUS_STILL_RUNNING:"))
    .join("\n")
    .trim();
}

function continuedNote(compactedFrom?: string | null, nextSession?: string | null): string {
  if (!compactedFrom || !nextSession || nextSession === compactedFrom) return "";
  return `\n\n> 🔀 已新开会话 \`${nextSession.slice(0, 8)}\`，接续自 \`${compactedFrom.slice(0, 8)}\`。`;
}

function nextSession(result: Record<string, unknown> | null, curSession?: string | null, origSession?: string | null, binary?: string | null): string | null {
  if (!result) return cleanSessionId(curSession, binary) ?? cleanSessionId(origSession, binary);
  const asked = new Set([curSession, origSession].filter((s): s is string => Boolean(s)));
  const reported =
    cleanSessionId(result.session_id, binary) ??
    reportedSessionId(typeof result.stderr === "string" ? result.stderr : null, binary);
  const errors = `${result.error ?? ""}\n${result.stderr ?? ""}`;
  const gone = asked.size > 0 && SESSION_GONE.some((s) => errors.includes(s));
  if (reported && !(gone && asked.has(reported))) return reported;
  if (gone) return "";
  if (result.status === "failed") return null;
  return cleanSessionId(curSession, binary) ?? cleanSessionId(origSession, binary);
}

function mergeLiveEvent(list: Record<string, unknown>[], ev: Record<string, unknown>): void {
  if (ev.kind === "tool" && typeof ev.id === "string" && ev.id) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.kind === "tool" && list[i]?.id === ev.id) {
        list[i] = { ...list[i], ...ev };
        return;
      }
    }
  }
  list.push(ev);
  if (list.length > MAX_TASK_EVENTS) list.splice(0, list.length - MAX_TASK_EVENTS);
}

function stripImagesAndSystemPrompt(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "system_prompt_append") continue;
    if (k === "images") {
      if (Array.isArray(v)) out[k] = v.map((_, i) => `<image attachment ${i + 1}>`);
      continue;
    }
    out[k] = v;
  }
  return out;
}

function formatSummaryText(
  resultDict: Record<string, unknown> | null,
  streamError: string | null,
  streamedText: string,
  action: "agent" | "shell",
  binary: string,
  compactedFrom: string | null | undefined,
  finalSid: string | null,
): string {
  let answer = "";
  if (resultDict) {
    const stdout = extractRealAssistantContent(
      typeof resultDict.stdout === "string" ? resultDict.stdout : streamedText,
      Array.isArray(resultDict.events) ? resultDict.events : [],
    );
    const stderrClean = cleanStderrNoise(typeof resultDict.stderr === "string" ? resultDict.stderr : "");
    const status = String(resultDict.status || "");
    const exitCode = typeof resultDict.exit_code === "number" ? resultDict.exit_code : null;
    const errMsg =
      String(resultDict.error || "").trim() ||
      stderrClean ||
      (exitCode !== null && exitCode !== 0 ? `退出码 ${exitCode}` : "") ||
      "任务异常结束";

    const nonEmptyLines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const isOnlyToolCalls =
      action === "agent" &&
      nonEmptyLines.length > 0 &&
      nonEmptyLines.every((l) => l.startsWith("[Tool:") || l.startsWith("⚡ [") || l.startsWith("[Tool "));

    if (resultDict.error_type === USAGE_LIMIT) {
      const toolName =
        ({ claude: "Claude Code", codex: "Codex", antigravity: "Antigravity", workbuddy: "WorkBuddy" } as Record<string, string>)[binary] ?? binary;
      const note = `⛔ ${toolName} 的额度已用完（${errMsg}），这一步没做完。额度恢复后发送“继续”接着做。`;
      const before = stdout ? cleanAgentSummary(stdout.replace(errMsg, "")).trim() : "";
      answer = before ? `${before}\n\n> ${note}` : note;
    } else if (status === "failed") {
      answer = action === "agent" && stdout ? `${cleanAgentSummary(stdout)}\n\n> ❌ *[任务执行遇到错误: ${errMsg}]*` : `❌ ${errMsg}`;
    } else if (status === "timeout" || exitCode === 124) {
      answer = stdout
        ? `${cleanAgentSummary(stdout)}\n\n> ⚠️ *[任务执行耗时较长触发安全保护中断，已记录上述排查过程。请发送“继续”以获取完整结论]*`
        : `⚠️ 任务执行超时（${errMsg.slice(0, 100)}）。您可以发送“继续”继续获取结果。`;
    } else if (status === "still_running") {
      answer = stdout ? `${cleanAgentSummary(stdout)}\n\n> ⏳ *[智能体结束时还有它启动的后台任务没有跑完]*` : "⏳ 智能体结束时还有它启动的后台任务没有跑完。";
    } else if (action === "agent" && stdout) {
      answer = isOnlyToolCalls
        ? `${stdout}\n\n> 💡 *[阶段工具排查已完成，正在生成结论。如未显示完整回复，请发送“继续”]*`
        : cleanAgentSummary(stdout) || `✅ ${binary.charAt(0).toUpperCase() + binary.slice(1)} 任务在设备上执行完毕。`;
    } else if (stdout) {
      answer = action === "shell" ? `\`\`\`\n${stdout}\n\`\`\`` : cleanAgentSummary(stdout);
    } else if (status === "succeeded" || exitCode === 0) {
      if (stderrClean && SESSION_GONE.some((s) => stderrClean.includes(s))) {
        answer = `⚠️ 历史会话未在设备上找到或已过期（${stderrClean.slice(0, 120)}）。已自动为您重置会话，请重新提问。`;
      } else if (stderrClean) {
        answer = `⚠️ 任务执行完成但无输出（${stderrClean.slice(0, 120)}）。`;
      } else {
        answer = `✅ ${binary.charAt(0).toUpperCase() + binary.slice(1)} 任务在设备上执行完毕。`;
      }
    } else {
      answer = `⚠️ 任务执行完成（${errMsg.slice(0, 100)}）。`;
    }
  } else if (streamError) {
    answer = `❌ ${streamError}`;
  } else if (streamedText.trim()) {
    answer = cleanAgentSummary(streamedText);
  } else {
    answer = "任务执行结束。";
  }
  return answer + continuedNote(compactedFrom, finalSid);
}

export async function* directAgentStream(
  deps: Deps,
  user: UserRow,
  opts: {
    convId: string;
    convTitle?: string | null;
    question: string;
    device: string;
    executionMode: string;
    cwd?: string | null;
    sessionId?: string | null;
    permissionMode?: string | null;
    model?: string | null;
    effort?: string | null;
    projectId?: string | null;
    fork?: boolean | null;
    worktree?: boolean;
    images?: string[] | null;
    compactedFrom?: string | null;
    liveRules?: string[] | null;
    action?: "agent" | "shell";
    timeoutSeconds?: number;
    checkpoint?: Record<string, unknown> | null;
    resume?: boolean;
  },
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
  const { db, settings } = deps;
  const redis = deps.redis();
  const ckpt = opts.checkpoint ?? {};
  const userCreatedAt = typeof ckpt.user_created_at === "string" ? ckpt.user_created_at : new Date().toISOString();
  const startedAt = typeof ckpt.started_at === "number" ? ckpt.started_at * 1000 : Date.now();
  const action = opts.action ?? (opts.executionMode === "shell" ? "shell" : "agent");
  const binary = opts.executionMode;
  const origSessionId = cleanSessionId(opts.sessionId, binary);
  let sessionId = origSessionId;
  let taskId: string | null = typeof ckpt.task_id === "string" ? ckpt.task_id : null;
  const callId = typeof ckpt.call_id === "string" && ckpt.call_id ? ckpt.call_id : `direct_${randomUUID().replaceAll("-", "").slice(0, 8)}`;

  let resultDict: Record<string, unknown> | null = null;
  let streamError: string | null = null;
  const liveEvents: Record<string, unknown>[] = [];
  const thinkingBuf: string[] = Array.isArray(ckpt.thinking) ? [...(ckpt.thinking as string[])] : [];
  let streamedText = "";
  let persisted = false;
  let cancelled = false;
  let summaryTextFinal = "";
  let assistantCreatedAtFinal = new Date().toISOString();
  let durationMsFinal = 0;

  const machine = await resolveDeviceForUser(deps, user, opts.device);
  const deviceId = machine?.collectorTokenHash || machine?.name || opts.device;
  const deviceName = machine?.name || opts.device;

  const runArgs: Record<string, unknown> = {
    action,
    device_id: deviceId,
    cwd: opts.cwd || "",
    timeout_seconds: Math.min(14400, Math.max(0, opts.timeoutSeconds ?? (action === "agent" ? 7200 : 60))),
    conversation_id: opts.convId,
    user_question: opts.question,
    ...(action === "shell" ? { command: opts.question } : { prompt: opts.question, binary }),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(action === "agent" && opts.permissionMode && opts.permissionMode !== "full" ? { permission_mode: opts.permissionMode } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(opts.projectId ? { project_id: opts.projectId } : {}),
    ...(opts.fork != null ? { fork: opts.fork } : {}),
    ...(opts.worktree && action === "agent" ? { worktree: true } : {}),
    ...(opts.convTitle && action === "agent" ? { title: opts.convTitle } : {}),
  };

  const toolCallItem: Record<string, unknown> =
    ckpt.call && typeof ckpt.call === "object"
      ? { ...(ckpt.call as Record<string, unknown>) }
      : {
          id: callId,
          tool_call_id: callId,
          name: "run_on_device",
          device_name: deviceName,
          args: stripImagesAndSystemPrompt(runArgs),
          command: action === "shell" ? opts.question : `[${binary}] ${opts.question.slice(0, 80)}`,
          action,
          ...(action === "agent" ? { binary } : {}),
          status: "running",
        };

  const buildResultFromRaw = (raw: Record<string, unknown>, fallbackEvents: Record<string, unknown>[]): Record<string, unknown> => {
    const rawEvents = Array.isArray(raw.events) && raw.events.length ? (raw.events as Record<string, unknown>[]) : fallbackEvents;
    const events = rawEvents.slice(-MAX_TASK_EVENTS);
    const stderrStr = typeof raw.stderr === "string" ? raw.stderr : "";
    const sid = cleanSessionId(raw.session_id, binary) ?? reportedSessionId(stderrStr, binary);
    const res: Record<string, unknown> = markUsageLimit({
      task_id: taskId,
      device_id: deviceId,
      device_name: deviceName,
      action,
      ...(action === "agent" ? { binary } : {}),
      status: raw.status ?? "succeeded",
      exit_code: raw.exit_code ?? null,
      stdout: typeof raw.stdout === "string" ? raw.stdout : streamedText,
      stderr: stderrStr,
      error: raw.error ?? null,
      error_type: raw.error_type ?? null,
      session_id: sid,
      alerts: Array.isArray(raw.alerts) ? raw.alerts : [],
      events,
    });
    if (action === "agent" && nextSession(res, sessionId, origSessionId, binary) === "") {
      res.session_reset = true;
    }
    return res;
  };

  const persist = async () => {
    if (persisted) return;
    persisted = true;
    durationMsFinal = Math.max(0, Date.now() - startedAt);
    const finalSid = nextSession(resultDict, sessionId, origSessionId, binary);
    if (finalSid) await reconcileSession(db, opts.convId, finalSid, binary).catch(() => {});

    const answer =
      summaryTextFinal ||
      (cancelled
        ? "⏹ 已停止"
        : formatSummaryText(resultDict, streamError, streamedText, action, binary, opts.compactedFrom, finalSid));

    const savedCall: Record<string, unknown> = sanitizeToolCallEntry({ ...toolCallItem });
    if (resultDict) {
      savedCall.result = resultDict;
      savedCall.status = resultDict.status === "succeeded" || resultDict.status === "still_running" ? "executed" : String(resultDict.status || "executed");
    } else if (cancelled) {
      savedCall.status = "failed";
      savedCall.result = {
        task_id: taskId,
        device_id: deviceId,
        device_name: deviceName,
        action,
        status: "cancelled",
        error: "已手动停止",
        events: liveEvents.slice(-MAX_TASK_EVENTS),
      };
    } else if (streamError) {
      savedCall.status = "failed";
      savedCall.result = {
        task_id: taskId,
        device_id: deviceId,
        device_name: deviceName,
        action,
        status: "failed",
        error: streamError,
        events: liveEvents.slice(-MAX_TASK_EVENTS),
      };
    } else {
      savedCall.status = "executed";
      savedCall.result = {
        task_id: taskId,
        device_id: deviceId,
        device_name: deviceName,
        action,
        status: "succeeded",
        stdout: answer,
        exit_code: 0,
        events: liveEvents.slice(-MAX_TASK_EVENTS),
      };
    }

    const fromBuf = thinkingBuf.join("").trim();
    const fromEvents = extractThinkingFromEvents((resultDict?.events as unknown[]) ?? liveEvents);
    const persistedThinking = (fromBuf.length >= fromEvents.length ? fromBuf : fromEvents) || null;

    const saved = await appendConversationTurns(db, opts.convId, {
      settings,
      userId: user.id,
      question: opts.question,
      answer,
      thinking: persistedThinking,
      toolCalls: [savedCall],
      images: opts.images ?? null,
      userCreatedAt,
      startedAt: userCreatedAt,
      durationMs: durationMsFinal,
      taskId,
      agentSessionId: finalSid || null,
      forgetSession: finalSid === "",
      model: opts.model ?? null,
      executionMode: action === "shell" ? "shell" : binary,
      deviceId,
      cwd: opts.cwd ?? null,
    });
    assistantCreatedAtFinal = saved.assistantCreatedAt;
  };

  try {
    if (!opts.resume) {
      yield `data: ${JSON.stringify({ type: "sources", sources: [] })}\n\n`;
      yield `data: ${JSON.stringify({
        type: "tool_call",
        id: callId,
        tool_call_id: callId,
        name: "run_on_device",
        args: stripImagesAndSystemPrompt(runArgs),
        device_name: deviceName,
        call: toolCallItem,
      })}\n\n`;
    }

    if (!settings.remoteExec) {
      streamError = "远程执行未开启（MEMENTO_REMOTE_EXEC=0）";
      summaryTextFinal = `❌ ${streamError}`;
      yield `data: ${JSON.stringify({ type: "delta", text: summaryTextFinal })}\n\n`;
      return;
    }

    let streamQ: Awaited<ReturnType<typeof wsManager.subscribeTask>> | null = null;
    if (!opts.resume || !taskId) {
      let resonanceAppend = "";
      if (action === "agent") {
        try {
          const res = await senseResonance(db, redis, user, { query: opts.question, project: opts.cwd ?? null, action: "agent" });
          resonanceAppend = renderMindResonanceMarkdown(res, opts.liveRules);
        } catch {
          /* ignore */
        }
      }

      taskId = randomUUID();
      const timeoutSec = Math.min(14400, Math.max(60, opts.timeoutSeconds ?? (action === "agent" ? 7200 : 60)));
      let storedImgs: string[] | undefined;
      if (opts.images?.length) {
        try {
          storedImgs = await storeImages(settings, user.id, opts.convId, opts.images);
        } catch {
          storedImgs = opts.images;
        }
      }
      const payload: Record<string, unknown> = {
        ...runArgs,
        timeout_seconds: timeoutSec,
        ...(storedImgs?.length ? { images: storedImgs } : {}),
        ...(resonanceAppend ? { system_prompt_append: resonanceAppend } : {}),
      };
      const [task] = await db
        .insert(deviceTasks)
        .values(
          withoutNul({
            id: taskId,
            deviceId,
            machineId: machine?.id ?? null,
            userId: user.id,
            action,
            payload,
            status: "queued",
            alerts: [],
            events: [],
            sessionId,
            timeoutSeconds: timeoutSec,
            createdAt: new Date().toISOString(),
          }),
        )
        .returning();

      // Subscribe BEFORE sending so no early chunk/event is ever missed.
      streamQ = await wsManager.subscribeTask(taskId);
      const { sent: delivered } = await deliverTask(db, task!, machine);
      if (!delivered) {
        await wsManager.unsubscribeTask(taskId);
        streamQ = null;
        streamError = `设备「${deviceName}」当前离线或未连接到服务器。`;
        summaryTextFinal = `❌ ${streamError}`;
        yield `data: ${JSON.stringify({
          type: "tool_result",
          task_id: taskId,
          tool_call_id: callId,
          result: { task_id: taskId, device_id: deviceId, device_name: deviceName, action, status: "failed", error: streamError },
        })}\n\n`;
        yield `data: ${JSON.stringify({ type: "delta", text: summaryTextFinal })}\n\n`;
        return;
      }
    } else {
      streamQ = await wsManager.subscribeTask(taskId);
    }

    yield `data: ${JSON.stringify({
      type: "task_progress",
      task_id: taskId,
      tool_call_id: callId,
      device_name: deviceName,
      device_id: deviceId,
      action,
      status: "running",
    })}\n\n`;
    yield `data: ${JSON.stringify({
      type: "checkpoint",
      data: {
        task_id: taskId,
        session_id: sessionId,
        call_id: callId,
        call: toolCallItem,
        action,
        user_created_at: userCreatedAt,
        started_at: startedAt / 1000,
      },
    })}\n\n`;

    const timeoutMs = (opts.timeoutSeconds && opts.timeoutSeconds > 0 ? opts.timeoutSeconds : action === "agent" ? 7200 : 120) * 1000;
    const deadline = Date.now() + timeoutMs;
    let pendingChunk: { stream: string; text: string } | null = null;
    let lastChunkFlush = Date.now();
    let lastPingAt = Date.now();

    const flushChunk = (): string | null => {
      if (!pendingChunk || !pendingChunk.text) return null;
      const out = `data: ${JSON.stringify({
        type: "task_chunk",
        task_id: taskId,
        tool_call_id: callId,
        device_name: deviceName,
        stream: pendingChunk.stream,
        text: pendingChunk.text,
      })}\n\n`;
      pendingChunk = null;
      lastChunkFlush = Date.now();
      return out;
    };

    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          cancelled = true;
          await wsManager.sendCancel(deviceId, taskId);
          return;
        }
        const ev = await streamQ.get(pendingChunk ? CHUNK_COALESCE_MS : 3000);
        if (!ev) {
          const flushed = flushChunk();
          if (flushed) yield flushed;
          const [fresh] = await db.select().from(deviceTasks).where(eq(deviceTasks.id, taskId)).limit(1);
          if (fresh?.finishedAt) {
            resultDict = buildResultFromRaw(
              {
                status: fresh.status,
                exit_code: fresh.exitCode,
                stdout: fresh.stdout || "",
                stderr: fresh.stderr || "",
                error: fresh.error,
                session_id: fresh.sessionId,
                alerts: fresh.alerts,
                events: fresh.events,
              },
              liveEvents,
            );
            yield `data: ${JSON.stringify({ type: "tool_result", task_id: taskId, tool_call_id: callId, result: resultDict })}\n\n`;
            break;
          }
          if (Date.now() - lastPingAt >= 15_000) {
            lastPingAt = Date.now();
            yield 'data: {"type":"ping"}\n\n';
          }
          continue;
        }

        const t = String(ev.type ?? "");
        if (typeof ev.session_id === "string" && cleanSessionId(ev.session_id, binary)) {
          sessionId = cleanSessionId(ev.session_id, binary);
          yield `data: ${JSON.stringify({ type: "checkpoint", data: { task_id: taskId, session_id: sessionId } })}\n\n`;
        }

        if (t === "task_chunk") {
          const streamName = String(ev.stream || "stdout");
          const chunkText = typeof ev.text === "string" ? ev.text : "";
          if (!chunkText) continue;
          if (streamName !== "stderr") streamedText += chunkText;
          if (pendingChunk && pendingChunk.stream === streamName && pendingChunk.text.length + chunkText.length < MAX_COALESCE_CHARS) {
            pendingChunk.text += chunkText;
          } else {
            const flushed = flushChunk();
            if (flushed) yield flushed;
            pendingChunk = { stream: streamName, text: chunkText };
            lastChunkFlush = Date.now();
          }
          if (Date.now() - lastChunkFlush >= CHUNK_COALESCE_MS) {
            const flushed = flushChunk();
            if (flushed) yield flushed;
          }
          continue;
        }

        const flushed = flushChunk();
        if (flushed) yield flushed;

        if (t === "task_finished" || t === "task_result") {
          const raw = t === "task_finished" && ev.result && typeof ev.result === "object" ? (ev.result as Record<string, unknown>) : ev;
          resultDict = buildResultFromRaw(raw, liveEvents);
          yield `data: ${JSON.stringify({ type: "tool_result", task_id: taskId, tool_call_id: callId, result: resultDict })}\n\n`;
          break;
        }

        if (t === "task_progress") {
          yield `data: ${JSON.stringify({
            type: "task_progress",
            task_id: taskId,
            tool_call_id: callId,
            device_name: deviceName,
            device_id: deviceId,
            action,
            status: ev.status ?? "running",
          })}\n\n`;
          continue;
        }

        if (t === "task_alert") {
          yield `data: ${JSON.stringify({
            type: "task_alert",
            task_id: taskId,
            tool_call_id: callId,
            device_name: deviceName,
            alert: ev.alert,
          })}\n\n`;
          continue;
        }

        if (t === "task_event" && ev.event && typeof ev.event === "object") {
          const inner = ev.event as Record<string, unknown>;
          mergeLiveEvent(liveEvents, inner);
          if (inner.kind === "session" && typeof inner.session_id === "string" && cleanSessionId(inner.session_id, binary)) {
            sessionId = cleanSessionId(inner.session_id, binary);
            yield `data: ${JSON.stringify({ type: "checkpoint", data: { task_id: taskId, session_id: sessionId } })}\n\n`;
          }
          if (inner.kind === "thinking" && typeof inner.text === "string" && inner.text) {
            thinkingBuf.push(inner.text);
            yield `data: ${JSON.stringify({ type: "thinking", text: inner.text })}\n\n`;
          }
          yield `data: ${JSON.stringify({ type: "task_event", task_id: taskId, tool_call_id: callId, event: inner })}\n\n`;
          continue;
        }

        if (t === "thinking" && typeof ev.text === "string" && ev.text) {
          thinkingBuf.push(ev.text);
          yield `data: ${JSON.stringify({ type: "thinking", text: ev.text })}\n\n`;
          continue;
        }
      }
    } finally {
      if (taskId) await wsManager.unsubscribeTask(taskId);
    }

    const finalSid = nextSession(resultDict, sessionId, origSessionId, binary);
    summaryTextFinal = formatSummaryText(resultDict, streamError, streamedText, action, binary, opts.compactedFrom, finalSid);
    yield `data: ${JSON.stringify({ type: "delta", text: summaryTextFinal })}\n\n`;
  } finally {
    await persist();
  }

  yield `data: ${JSON.stringify({ type: "done", assistant_created_at: assistantCreatedAtFinal, duration_ms: durationMsFinal })}\n\n`;
}

askRuns.resumers["direct_agent"] = (kwargs, ckpt): RunStreamFactory => {
  return (deps, user, signal) =>
    directAgentStream(
      deps,
      user,
      {
        convId: String(kwargs.conv_id ?? kwargs.convId),
        convTitle: typeof kwargs.conv_title === "string" ? kwargs.conv_title : null,
        question: String(kwargs.question ?? ""),
        device: String(kwargs.device ?? ""),
        executionMode: String(kwargs.execution_mode ?? kwargs.executionMode ?? "claude"),
        cwd: typeof kwargs.cwd === "string" ? kwargs.cwd : null,
        sessionId: typeof ckpt.session_id === "string" ? ckpt.session_id : typeof kwargs.session_id === "string" ? kwargs.session_id : null,
        permissionMode: typeof kwargs.permission_mode === "string" ? kwargs.permission_mode : null,
        model: typeof kwargs.model === "string" ? kwargs.model : null,
        effort: typeof kwargs.effort === "string" ? kwargs.effort : null,
        projectId: typeof kwargs.project_id === "string" ? kwargs.project_id : null,
        compactedFrom: typeof kwargs.compacted_from === "string" ? kwargs.compacted_from : null,
        checkpoint: ckpt,
        resume: true,
      },
      signal,
    );
};

export async function runResponse(
  deps: Deps,
  convId: string,
  user: UserRow,
  question: string,
  requestId: string | null | undefined,
  factory: RunStreamFactory,
  opts: {
    executionMode?: string | null;
    model?: string | null;
    deviceName?: string | null;
    title?: string | null;
    images?: string[] | null;
    resume?: { kind: string; kwargs: Record<string, unknown>; checkpoint?: Record<string, unknown> } | null;
    signal?: AbortSignal;
  } = {},
): Promise<Response> {
  let images = opts.images ?? [];
  if (images.length) {
    try {
      images = await Promise.race([
        storeImages(deps.settings, user.id, convId, images),
        new Promise<string[]>((r) => setTimeout(() => r(images), 5000)),
      ]);
    } catch {
      /* keep original */
    }
  }
  let run;
  try {
    run = await askRuns.start(deps, convId, user, question, factory, {
      requestId: requestId ?? null,
      executionMode: opts.executionMode,
      model: opts.model,
      deviceName: opts.deviceName,
      title: opts.title,
      images,
      resume: opts.resume,
    });
  } catch (e) {
    if (e instanceof RunConflict) {
      throw new HttpError(409, "这个对话还有任务在运行，请等它结束或先停止");
    }
    throw e;
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of run.stream(0, opts.signal)) {
          controller.enqueue(encoder.encode(frame));
        }
      } catch {
        /* client disconnected — background run keeps going */
      } finally {
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      ...SSE_HEADERS,
      "X-Ask-Run-Id": run.runId,
      "X-Ask-Conversation-Id": convId,
    },
  });
}

export { normalizeUuid };
