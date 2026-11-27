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
import { appendConversationTurns, extractRealAssistantContent, reconcileSession } from "./ask-store";
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

function cleanAgentSummary(text: string): string {
  return (text || "").replace(/\r\n/g, "\n").trim();
}

function continuedNote(compactedFrom?: string | null, nextSession?: string | null): string {
  if (!compactedFrom) return "";
  return `\n\n> ℹ️ 已从前序会话 \`${compactedFrom.slice(0, 8)}\` 自动续接${nextSession ? `至新会话 \`${nextSession.slice(0, 8)}\`` : ""}。`;
}

function nextSession(result: Record<string, unknown> | null, curSession?: string | null, origSession?: string | null, binary?: string | null): string | null {
  if (!result) return cleanSessionId(curSession, binary) ?? cleanSessionId(origSession, binary);
  return (
    cleanSessionId(result.session_id, binary) ??
    reportedSessionId(typeof result.stderr === "string" ? result.stderr : null, binary) ??
    cleanSessionId(curSession, binary) ??
    cleanSessionId(origSession, binary)
  );
}

export async function* directAgentStream(
  deps: Deps,
  user: UserRow,
  opts: {
    convId: string;
    question: string;
    device: string;
    executionMode: string;
    cwd?: string | null;
    sessionId?: string | null;
    permissionMode?: string | null;
    model?: string | null;
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
  const startedAt = Date.now();
  const userCreatedAt = new Date().toISOString();
  const action = opts.action ?? "agent";
  const binary = opts.executionMode;
  const origSessionId = cleanSessionId(opts.sessionId, binary);
  let sessionId = origSessionId;
  let taskId: string | null = typeof opts.checkpoint?.task_id === "string" ? opts.checkpoint.task_id : null;
  let resultDict: Record<string, unknown> | null = null;
  let streamError: string | null = null;
  const steps: Record<string, unknown>[] = [];
  const thinkingBuf: string[] = [];
  let streamedText = "";
  let persisted = false;
  let assistantCreatedAtFinal = new Date().toISOString();
  let durationMsFinal = 0;

  const machine = await resolveDeviceForUser(deps, user, opts.device);
  const deviceId = machine?.collectorTokenHash || machine?.name || opts.device;
  const deviceName = machine?.name || opts.device;

  const persist = async () => {
    if (persisted) return;
    persisted = true;
    durationMsFinal = Date.now() - startedAt;
    const finalSid = nextSession(resultDict, sessionId, origSessionId, binary);
    if (finalSid) await reconcileSession(db, opts.convId, finalSid, binary).catch(() => {});

    let answer = "";
    if (resultDict) {
      const stdout = extractRealAssistantContent(typeof resultDict.stdout === "string" ? resultDict.stdout : streamedText, Array.isArray(resultDict.events) ? resultDict.events : []);
      const errMsg = String(resultDict.error || resultDict.stderr || "").trim();
      const status = String(resultDict.status || "");
      const exitCode = Number(resultDict.exit_code ?? 0);
      if (resultDict.error_type === USAGE_LIMIT) {
        const toolName = ({ claude: "Claude Code", codex: "Codex", antigravity: "Antigravity", workbuddy: "WorkBuddy" } as Record<string, string>)[binary] ?? binary;
        const note = `⛔ ${toolName} 的额度已用完（${errMsg}），这一步没做完。额度恢复后发送“继续”接着做。`;
        const before = stdout ? cleanAgentSummary(stdout.replace(errMsg, "")).trim() : "";
        answer = before ? `${before}\n\n> ${note}` : note;
      } else if (status === "failed") {
        answer = action === "agent" && stdout ? `${cleanAgentSummary(stdout)}\n\n> ❌ *[任务执行遇到错误: ${errMsg}]*` : `❌ ${errMsg || "任务执行失败"}`;
      } else if (status === "timeout" || exitCode === 124) {
        answer = stdout
          ? `${cleanAgentSummary(stdout)}\n\n> ⚠️ *[任务执行耗时较长触发安全保护中断，已记录上述排查过程。请发送“继续”以获取完整结论]*`
          : `⚠️ 任务执行超时（${errMsg.slice(0, 100)}）。您可以发送“继续”继续获取结果。`;
      } else if (status === "still_running") {
        answer = stdout ? `${cleanAgentSummary(stdout)}\n\n> ⏳ *[智能体结束时还有它启动的后台任务没有跑完]*` : "⏳ 智能体结束时还有它启动的后台任务没有跑完。";
      } else if (stdout) {
        answer = action === "shell" ? `\`\`\`\n${stdout}\n\`\`\`` : cleanAgentSummary(stdout);
      } else if (status === "succeeded" || exitCode === 0) {
        const stderr = String(resultDict.stderr || "");
        if (stderr && SESSION_GONE.some((s) => stderr.includes(s))) {
          answer = `⚠️ 历史会话未在设备上找到或已过期（${stderr.trim().slice(0, 120)}）。已自动为您重置会话，请重新提问。`;
        } else if (stderr) {
          answer = `⚠️ 任务执行完成但无输出（${stderr.trim().slice(0, 120)}）。`;
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
    answer += continuedNote(opts.compactedFrom, finalSid);

    const saved = await appendConversationTurns(db, opts.convId, {
      settings,
      userId: user.id,
      question: opts.question,
      answer,
      thinking: thinkingBuf.join("\n\n").trim() || null,
      steps: steps.length ? steps : null,
      images: opts.images ?? null,
      userCreatedAt,
      durationMs: durationMsFinal,
      taskId,
      agentSessionId: finalSid,
      deviceId,
      cwd: opts.cwd ?? null,
    });
    assistantCreatedAtFinal = saved.assistantCreatedAt;
  };

  try {
    if (!settings.remoteExec) {
      streamError = "远程执行未开启（MEMENTO_REMOTE_EXEC=0）";
      yield `data: ${JSON.stringify({ type: "delta", text: `❌ ${streamError}` })}\n\n`;
      return;
    }

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
      const timeoutSec = Math.min(3600, Math.max(60, opts.timeoutSeconds ?? 1800));
      let storedImgs: string[] | undefined;
      if (opts.images?.length) {
        try {
          storedImgs = await storeImages(settings, user.id, opts.convId, opts.images);
        } catch {
          storedImgs = opts.images;
        }
      }
      const payload: Record<string, unknown> = {
        ...(action === "shell" ? { command: opts.question } : { prompt: opts.question, binary }),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(opts.permissionMode ? { permission_mode: opts.permissionMode } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(storedImgs?.length ? { images: storedImgs } : {}),
        ...(resonanceAppend ? { system_prompt_append: resonanceAppend } : {}),
        conversation_id: opts.convId,
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

      const { sent: delivered } = await deliverTask(db, task!, machine);
      if (!delivered) {
        streamError = `设备「${deviceName}」当前离线或未连接到服务器。`;
        yield `data: ${JSON.stringify({ type: "delta", text: `❌ ${streamError}` })}\n\n`;
        return;
      }
    }

    yield `data: ${JSON.stringify({ type: "task_started", task_id: taskId, device: deviceName, session_id: sessionId })}\n\n`;
    yield `data: ${JSON.stringify({ type: "checkpoint", data: { task_id: taskId, session_id: sessionId } })}\n\n`;

    const streamQ = await wsManager.subscribeTask(taskId);
    const deadline = Date.now() + (opts.timeoutSeconds ?? 1800) * 1000;
    let pendingDelta = "";
    let lastFlush = Date.now();

    const flushDelta = () => {
      if (!pendingDelta) return null;
      const chunk = pendingDelta;
      pendingDelta = "";
      lastFlush = Date.now();
      return `data: ${JSON.stringify({ type: "delta", text: chunk })}\n\n`;
    };

    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          await wsManager.sendCancel(deviceId, taskId);
          return;
        }
        const ev = await streamQ.get(pendingDelta ? CHUNK_COALESCE_MS : 3000);
        if (!ev) {
          const flushed = flushDelta();
          if (flushed) yield flushed;
          const [fresh] = await db.select().from(deviceTasks).where(eq(deviceTasks.id, taskId)).limit(1);
          if (fresh?.finishedAt) {
            resultDict = markUsageLimit({
              status: fresh.status,
              exit_code: fresh.exitCode,
              stdout: fresh.stdout || "",
              stderr: fresh.stderr || "",
              error: fresh.error,
              session_id: fresh.sessionId,
              events: fresh.events,
              action,
            });
            break;
          }
          continue;
        }

        const t = String(ev.type ?? "");
        if (typeof ev.session_id === "string" && cleanSessionId(ev.session_id, binary)) {
          sessionId = cleanSessionId(ev.session_id, binary);
          yield `data: ${JSON.stringify({ type: "session_id", session_id: sessionId })}\n\n`;
          yield `data: ${JSON.stringify({ type: "checkpoint", data: { task_id: taskId, session_id: sessionId } })}\n\n`;
        }

        if (t === "task_result") {
          const flushed = flushDelta();
          if (flushed) yield flushed;
          resultDict = markUsageLimit({ ...ev, action });
          break;
        }
        if (t === "thinking" && typeof ev.text === "string" && ev.text) {
          thinkingBuf.push(ev.text);
          yield `data: ${JSON.stringify({ type: "thinking", text: ev.text })}\n\n`;
          continue;
        }
        if ((t === "text" || t === "delta" || t === "stdout") && typeof ev.text === "string" && ev.text) {
          streamedText += ev.text;
          pendingDelta += ev.text;
          if (Date.now() - lastFlush >= CHUNK_COALESCE_MS) {
            const flushed = flushDelta();
            if (flushed) yield flushed;
          }
          continue;
        }
        if (t === "tool_use" || t === "tool_call" || t === "tool_start" || t === "tool_result" || t === "step") {
          const flushed = flushDelta();
          if (flushed) yield flushed;
          steps.push(ev);
          yield `data: ${JSON.stringify(ev)}\n\n`;
          continue;
        }
        yield `data: ${JSON.stringify(ev)}\n\n`;
      }
    } finally {
      wsManager.unsubscribeTask(taskId);
    }

    if (resultDict && !streamedText.trim()) {
      const stdout = extractRealAssistantContent(typeof resultDict.stdout === "string" ? resultDict.stdout : "", Array.isArray(resultDict.events) ? resultDict.events : []);
      const errMsg = String(resultDict.error || resultDict.stderr || "").trim();
      const status = String(resultDict.status || "");
      let summaryText = "";
      if (resultDict.error_type === USAGE_LIMIT) {
        const toolName = ({ claude: "Claude Code", codex: "Codex", antigravity: "Antigravity", workbuddy: "WorkBuddy" } as Record<string, string>)[binary] ?? binary;
        const note = `⛔ ${toolName} 的额度已用完（${errMsg}），这一步没做完。额度恢复后发送“继续”接着做。`;
        const before = stdout ? cleanAgentSummary(stdout.replace(errMsg, "")).trim() : "";
        summaryText = before ? `${before}\n\n> ${note}` : note;
      } else if (status === "failed") {
        summaryText = action === "agent" && stdout ? `${cleanAgentSummary(stdout)}\n\n> ❌ *[任务执行遇到错误: ${errMsg}]*` : `❌ ${errMsg}`;
      } else if (stdout) {
        summaryText = action === "shell" ? `\`\`\`\n${stdout}\n\`\`\`` : cleanAgentSummary(stdout);
      } else if (status === "succeeded") {
        summaryText = `✅ ${binary.charAt(0).toUpperCase() + binary.slice(1)} 任务在设备上执行完毕。`;
      } else {
        summaryText = `⚠️ 任务执行结束（${errMsg.slice(0, 100)}）。`;
      }
      summaryText += continuedNote(opts.compactedFrom, nextSession(resultDict, sessionId, origSessionId, binary));
      yield `data: ${JSON.stringify({ type: "delta", text: summaryText })}\n\n`;
    }
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
        question: String(kwargs.question ?? ""),
        device: String(kwargs.device ?? ""),
        executionMode: String(kwargs.execution_mode ?? kwargs.executionMode ?? "claude"),
        cwd: typeof kwargs.cwd === "string" ? kwargs.cwd : null,
        sessionId: typeof ckpt.session_id === "string" ? ckpt.session_id : typeof kwargs.session_id === "string" ? kwargs.session_id : null,
        permissionMode: typeof kwargs.permission_mode === "string" ? kwargs.permission_mode : null,
        model: typeof kwargs.model === "string" ? kwargs.model : null,
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
