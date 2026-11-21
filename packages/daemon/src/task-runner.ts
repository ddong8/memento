import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  AgentEventLog,
  AgyCliStreamParser,
  ClaudeStreamParser,
  CodexStreamParser,
  UniversalStreamParser,
  cleanSessionId,
  type AgentEvent,
  type AgentStreamParser,
} from "./agent-stream.js";
import {
  agyCliOpenBackgroundTasks,
  antigravityCliHasConversation,
  antigravityDesktopHasConversation,
  antigravityDesktopTranscriptContext,
  antigravityExecutable,
  discoverAntigravityEnv,
  ensureOfficialAgyCli,
  extractUserTitleFromText,
  isAppAuthRejection,
  updateAntigravitySessionTitle,
} from "./antigravity.js";
import { agyQuotaMessage, isExhausted, listAgyModels, nextAgyModel, noteDefaultModel, noteQuotaExhausted, quotaResetMs } from "./agy-models.js";
import { ensureProjectBlueprint, findGitRoot } from "./blueprint-auto.js";
import {
  CLAUDE_MODELS,
  claudeModelLimit,
  codexModelLimit,
  codexModels,
  isModelLimited,
  nextModel,
  noteDefaultModel as noteAgentDefault,
  noteModelLimit,
  type LimitAgent,
  type ModelChoice,
} from "./model-limits.js";
import { probeAllQuotas } from "./quotas.js";
import { homeDir } from "./config.js";
import { LineDecoder, windowsConsoleEncoding } from "./console-text.js";
import { executionEnvironment, findExecutable, killProcessTree, prepareCommand, withExeDirOnPath } from "./exec-env.js";
import { HookBridge, type ToolUse } from "./hook-bridge.js";
import { getOfflineMindSnapshot } from "./profile-inject.js";
import { codexRunner } from "./codex.js";
import {
  adoptWorkbuddySession,
  cancelWorkbuddySession,
  ensureWorkbuddyCliInstalled,
  ensureWorkbuddyGateway,
  isWorkbuddyDirGateway,
  reapWorkbuddyGateways,
  stopWorkbuddyGateway,
  touchWorkbuddyGateway,
  workbuddyCliDir,
  type WorkbuddyGatewayHandle,
} from "./workbuddy.js";
import { IdleCompactor, matchingBuild } from "./claude-cache.js";
import { fetchClaudeSession, findClaudeSession } from "./session-sync.js";
import { executorDenyReason, executorOnlyEdits, SourceExecBridge, sourceExecHint } from "./source-exec.js";
import { TaskWorktree } from "./worktree.js";
import { managedPolicy, pathAllowed, taskRefusal } from "./managed-policy.js";
import { finishWorkspace, parseWorkspaceSpec, prepareWorkspace, toSourcePaths, type Relay, type WorkspaceRun } from "./workspace-sync.js";

export * from "./task-adapters.js";
import {
  SESSION_UNAVAILABLE,
  STEER_AFTER_ANSWER_MS,
  TIMED_OUT,
  appQuotaFallbacks,
  claudeArgs,
  claudeClientEnv,
  claudeSessionName,
  claudeUserMessage,
  codexArgs,
  antigravityArgs,
  isSessionNotFound,
  agentLoginHint,
  usageLimitMessage,
  detectStillRunning,
  resolveWorkingDir,
  smartTruncateOutput,
  stripRuntimeWarnings,
  taskFinishedMessage,
  type RunSpec,
  type Send,
  type TaskChunkMessage,
  type TaskDispatch,
  type TaskFinished,
} from "./task-adapters.js";

export class TaskRunner {
  private readonly running = new Map<string, ChildProcess>();
  private readonly taskPids = new Map<string, number>();
  private readonly outputs = new Map<string, { stdout: string; stderr: string }>();
  /** Claude tasks keep stdin open for follow-up instructions until their run ends. */
  private readonly steerInputs = new Map<string, NodeJS.WritableStream & { writable: boolean }>();
  private readonly claudeTasks = new Set<string>();
  /** Claude tasks: answers one of the questions Claude asked; false when none is waiting. */
  private readonly answerers = new Map<string, (questionId: string | undefined, text: string) => boolean>();
  /** Tasks run by memento's own runners (Codex, Antigravity, WorkBuddy), which take answers as memento_answer lines. */
  private readonly runnerTasks = new Set<string>();
  /** Agents that don't read stdin while they run (Google's agy CLI, the native CodeBuddy CLI, others): follow-ups wait for the next message. */
  private readonly noSteerTasks = new Set<string>();
  private readonly eventLogs = new Map<string, AgentEventLog>();
  /** Per running task: its agent, the session it runs and, for WorkBuddy, the file of the gateway it is on. */
  private readonly taskSessions = new Map<string, { binary: string; sessionId?: string; gatewayFile?: string }>();
  private readonly cancelledTasks = new Set<string>();
  private readonly taskSeq = new Map<string, number>();
  private readonly taskLogBuffer = new Map<string, TaskChunkMessage[]>();
  private readonly MAX_TASK_LOG_BUFFER = 2000;
  private hookBridge: HookBridge | undefined;
  /** The agent's `memento-source`: its commands run on the device the code is on. */
  private sourceExec: SourceExecBridge | undefined;
  /** Tasks whose code is on another device: this one only edits it (the command to use instead, the device's name). */
  private readonly editOnly = new Map<string, { command: string; source: string }>();
  /** Compacts the Claude sessions memento ran once they sit idle, before their cache runs out (as Claude Code's terminal does). */
  private readonly idleCompactor = new IdleCompactor((m) => this.log(m), { findSession: (id) => findClaudeSession(id) });
  /** Requests to the server over this device's connection: fetching code that lives on another device. */
  relay: Relay | undefined;

  constructor(
    private readonly send: Send,
    private readonly log: (message: string) => void = () => {},
  ) {}

  sendChunk(taskId: string, stream: "stdout" | "stderr", text: string): TaskChunkMessage {
    const nextSeq = (this.taskSeq.get(taskId) ?? 0) + 1;
    this.taskSeq.set(taskId, nextSeq);
    const msg: TaskChunkMessage = {
      type: "task_chunk",
      task_id: taskId,
      stream,
      text,
      seq: nextSeq,
      timestamp: Date.now(),
    };
    let buf = this.taskLogBuffer.get(taskId);
    if (!buf) {
      buf = [];
      this.taskLogBuffer.set(taskId, buf);
    }
    buf.push(msg);
    if (buf.length > this.MAX_TASK_LOG_BUFFER) {
      buf.shift();
    }
    this.send(msg as unknown as Record<string, unknown>);
    return msg;
  }

  getBufferedChunks(taskId: string, fromSeq = 1): TaskChunkMessage[] {
    const buf = this.taskLogBuffer.get(taskId);
    if (!buf) return [];
    return buf.filter((c) => (c.seq ?? 0) >= fromSeq);
  }

  resendBufferedChunks(taskId: string, fromSeq = 1): number {
    const toResend = this.getBufferedChunks(taskId, fromSeq);
    for (const msg of toResend) {
      this.send(msg as unknown as Record<string, unknown>);
    }
    return toResend.length;
  }

  clearTaskLogBuffer(taskId: string): void {
    this.taskLogBuffer.delete(taskId);
    this.taskSeq.delete(taskId);
  }

  get runningTaskIds(): string[] {
    return [...this.running.keys()];
  }

  /** The gateways other WorkBuddy tasks are on right now. */
  private gatewaysInUse(exceptTaskId?: string): Set<string> {
    const files = new Set<string>();
    for (const [id, s] of this.taskSessions) if (id !== exceptTaskId && s.gatewayFile) files.add(s.gatewayFile);
    return files;
  }

  /**
   * The gateway memento serves for a WorkBuddy task in `workDir` (null: none, the runner looks for the app's).
   * A session to resume that ran in another directory is copied over first, since a gateway only finds its own.
   */
  private async workbuddyGateway(taskId: string, workDir: string | undefined, sessionId: string): Promise<WorkbuddyGatewayHandle | null> {
    const gateway = await ensureWorkbuddyGateway(undefined, { cwd: workDir, inUse: this.gatewaysInUse(taskId) }).catch((err) => {
      this.log(`WorkBuddy gateway failed to start: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (!gateway) return null;
    const sess = this.taskSessions.get(taskId);
    if (sess) sess.gatewayFile = gateway.file;
    if (sessionId) {
      // The shared gateway runs in the CLI dir; the session may have started in a directory gateway.
      const dir = gateway.cwd ?? workbuddyCliDir();
      await adoptWorkbuddySession(sessionId, dir)
        .then((copied) => copied && this.log(`Copied WorkBuddy session ${sessionId} to ${dir}`))
        .catch((err) => this.log(`Failed to copy WorkBuddy session: ${err instanceof Error ? err.message : String(err)}`));
    }
    this.sweepIdleGateways();
    return gateway;
  }

  /** Stops WorkBuddy gateways no task has used for a while (the daemon runs this every few minutes too). */
  sweepIdleGateways(): void {
    void reapWorkbuddyGateways(undefined, { inUse: this.gatewaysInUse() })
      .then((stopped) => {
        if (stopped.length) this.log(`Stopped ${stopped.length} idle WorkBuddy gateway(s)`);
      })
      .catch((err) => this.log(`WorkBuddy gateway sweep failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  emitEvent(taskId: string, event: AgentEvent): void {
    const row = this.eventLogs.get(taskId)?.add(event) ?? { ...event, at: new Date().toISOString() };
    this.send({ type: "agent_event", task_id: taskId, event: row });
  }

  cancel(taskId: string): boolean {
    const proc = this.running.get(taskId);
    const pid = this.taskPids.get(taskId) ?? proc?.pid;
    this.log(`Cancelling task ${taskId} (proc running: ${Boolean(proc)}, pid: ${pid})`);
    this.cancelledTasks.add(taskId);
    this.running.delete(taskId);
    this.taskPids.delete(taskId);
    this.steerInputs.delete(taskId);
    this.claudeTasks.delete(taskId);
    this.noSteerTasks.delete(taskId);

    // The session runs in memento's gateway, which outlives the runner (and on Windows the runner is
    // killed outright, with no chance to cancel it itself): stop just this task's session there.
    const sessionInfo = this.taskSessions.get(taskId);
    if (sessionInfo?.sessionId && /workbuddy|codebuddy/.test(sessionInfo.binary)) {
      this.log(`Cancelling WorkBuddy session ${sessionInfo.sessionId} for task ${taskId}`);
      void cancelWorkbuddySession(sessionInfo.sessionId, undefined, sessionInfo.gatewayFile).catch((err) =>
        this.log(`Failed to cancel WorkBuddy session: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    // A cancel only reaches the prompt over the connection that sent it, which dies with the runner (killed
    // outright on Windows). A directory gateway with no other task on it is simply stopped; the next task starts
    // a fresh one, which resumes the session.
    const gatewayFile = sessionInfo?.gatewayFile;
    if (process.platform === "win32" && gatewayFile && isWorkbuddyDirGateway(gatewayFile) && !this.gatewaysInUse(taskId).has(gatewayFile)) {
      void stopWorkbuddyGateway(gatewayFile).catch(() => {});
    }

    if (proc || pid) {
      killProcessTree(proc ?? pid);
    }
    // 立即向服务端发送 task_finished (status: cancelled)，防止服务端、灵动岛挂死等待
    this.send(
      taskFinishedMessage({
        taskId,
        status: "cancelled",
        exitCode: 130,
        error: "任务已由用户手动停止",
      }),
    );
    return true;
  }

  /** A follow-up from the user: steers a running Claude/Antigravity/WorkBuddy task or goes to process stdin. */
  /**
   * A reply from the user. When it answers a question the agent asked (by id, or the one waiting), it goes
   * back the way that agent takes answers: Claude Code over its control channel, memento's runners as a
   * memento_answer line. Anything else steers the running task.
   */
  input(taskId: string, text: string, questionId?: string): void {
    if (this.answerers.get(taskId)?.(questionId, text)) return this.echoInput(taskId, text);
    if (this.noSteerTasks.has(taskId)) {
      this.emitEvent(taskId, { kind: "steer", text, status: "unsupported" });
      return;
    }
    const sink = this.steerInputs.get(taskId) ?? this.running.get(taskId)?.stdin;
    if (!sink?.writable) {
      this.emitEvent(taskId, { kind: "steer", text, status: "late" });
      return;
    }
    const waiting = this.eventLogs
      .get(taskId)
      ?.events.find((e) => e.kind === "question" && (questionId ? e.id === questionId : e.status === "waiting" || !e.status));
    if (waiting?.id && this.runnerTasks.has(taskId)) {
      sink.write(`${JSON.stringify({ type: "memento_answer", question_id: waiting.id, answer: text })}\n`);
      this.emitEvent(taskId, { kind: "question", id: waiting.id, status: "answered", answer: text });
    } else {
      sink.write(this.claudeTasks.has(taskId) ? `${JSON.stringify(claudeUserMessage(text))}\n` : `${text}\n`);
      if (waiting?.id) this.emitEvent(taskId, { kind: "question", id: waiting.id, status: "answered", answer: text });
      this.emitEvent(taskId, { kind: "steer", text, status: "sent" });
    }
    this.echoInput(taskId, text);
  }

  private echoInput(taskId: string, text: string): void {
    const echo = `\n[输入] ${text}\n`;
    const out = this.outputs.get(taskId);
    if (out) out.stdout += echo;
    this.sendChunk(taskId, "stdout", echo);
  }


  dispose(): void {
    const killedPids = new Set<number>();
    for (const proc of this.running.values()) {
      if (proc.pid) killedPids.add(proc.pid);
      killProcessTree(proc);
    }
    for (const pid of this.taskPids.values()) {
      if (!killedPids.has(pid)) {
        killedPids.add(pid);
        killProcessTree(pid);
      }
    }
    this.running.clear();
    this.taskPids.clear();
    this.outputs.clear();
    void this.hookBridge?.stop();
    this.hookBridge = undefined;
    this.sourceExec?.dispose();
    this.sourceExec = undefined;
    this.idleCompactor.dispose();
  }

  /** Starts one process for the task and resolves with its exit code (TIMED_OUT on timeout). */
  private async runOnce(taskId: string, spec: RunSpec, timeoutSeconds: number): Promise<number> {
    const prep = await prepareCommand(spec.exe, spec.args);
    const proc = spawn(prep.executable, prep.args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
      // Its own process group, so cancelling reaches everything it started.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.running.set(taskId, proc);
    if (proc.pid) this.taskPids.set(taskId, proc.pid);
    const out = this.outputs.get(taskId)!;
    const { parser } = spec;

    proc.stdin.on("error", () => {});
    this.steerInputs.set(taskId, proc.stdin);
    let steerCap: NodeJS.Timeout | undefined;
    const closeSteer = () => {
      if (steerCap) clearTimeout(steerCap);
      const sink = this.steerInputs.get(taskId);
      if (sink !== proc.stdin) return;
      this.steerInputs.delete(taskId);
      sink.end();
    };
    const flushReplies = () => {
      if (!(parser instanceof ClaudeStreamParser)) return;
      for (const reply of parser.takeReplies()) if (proc.stdin.writable) proc.stdin.write(`${JSON.stringify(reply)}\n`);
    };
    if (parser instanceof ClaudeStreamParser) {
      this.answerers.set(taskId, (questionId, text) => {
        const events = parser.answer(questionId, text);
        if (!events) return false;
        for (const e of events) this.emitEvent(taskId, e);
        flushReplies();
        return true;
      });
    }
    if (spec.stdinPrompt !== undefined && parser instanceof ClaudeStreamParser) {
      proc.stdin.write(`${JSON.stringify(claudeUserMessage(spec.stdinPrompt))}\n`);
    }

    const stdoutDone = new Promise<void>((resolve) => proc.stdout.once("end", () => resolve()));

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let stallTimer: NodeJS.Timeout | undefined;

    const cmdLine = `${spec.exe} ${spec.args?.join(" ")} ${spec.stdinPrompt ?? ""}`;
    const isHeavyCommand = /\b(?:cargo\s+build|flutter\s+build|npm\s+run\s+build|docker\s+build|mvn\s+package|gradle\s+build|git\s+clone)\b/i.test(
      cmdLine,
    );
    // Dynamically grant at least 300s (5 minutes) for heavy build/compilation jobs if a small timeout (<300s) was passed
    const effectiveTimeout = isHeavyCommand && timeoutSeconds > 0 && timeoutSeconds < 300 ? 300 : timeoutSeconds;

    const hasWaitingQuestion = () => {
      const el = this.eventLogs.get(taskId);
      return el?.events.some((e) => e.kind === "question" && (e.status === "waiting" || !e.status)) ?? false;
    };

    const armStallWatchdog = () => {
      if (stallTimer) clearTimeout(stallTimer);
      // If process runs for 5 minutes with zero output, send a progress heartbeat alert
      stallTimer = setTimeout(() => {
        this.send({
          type: "task_progress",
          task_id: taskId,
          status: "进程正在静默运行中（超过 5 分钟无新输出，可能处于深度计算或等待输入）",
        });
      }, 300_000);
    };

    // Activity-based watchdog: refreshed whenever process produces stdout/stderr, disabled if timeoutSeconds <= 0
    const armTimer = () => {
      armStallWatchdog();
      if (effectiveTimeout > 0) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (hasWaitingQuestion()) {
            // User is reviewing an interactive question dialog; defer timeout
            armTimer();
            return;
          }
          timedOut = true;
          killProcessTree(proc);
        }, effectiveTimeout * 1000);
      }
    };
    armTimer();

    // PowerShell writes the console code page (GBK on Chinese Windows) into the pipe, not UTF-8
    const lineText = (stream: NodeJS.ReadableStream, onText: (text: string) => void) => {
      const decoder = new LineDecoder(spec.consoleEncoding ?? null);
      stream.on("data", (bytes: Buffer) => {
        const text = decoder.push(bytes);
        if (text) onText(text);
      });
      stream.on("end", () => {
        const text = decoder.flush();
        if (text) onText(text);
      });
    };
    const consoleText = spec.consoleEncoding !== undefined;

    if (!parser) {
      const onStdout = (text: string) => {
        armTimer();
        if (out.stdout.length < 2_500_000) {
          out.stdout += text;
        } else if (!out.stdout.endsWith("[...后续输出过大已转为实时流式传输...]\n")) {
          out.stdout += "\n[...后续输出过大已转为实时流式传输...]\n";
        }
        this.sendChunk(taskId, "stdout", text);
      };
      if (consoleText) {
        lineText(proc.stdout, onStdout);
      } else {
        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", onStdout);
      }
    } else {
      createInterface({ input: proc.stdout, crlfDelay: Infinity }).on("line", (line) => {
        armTimer();
        const events = parser.feed(line);
        if (events === null) {
          if (!line.trim()) {
            // Preserve paragraph separation while preventing excessive empty lines
            if (out.stdout.endsWith("\n\n")) return;
            out.stdout += "\n";
            this.sendChunk(taskId, "stdout", "\n");
            return;
          }
          if (out.stdout.length < 2_500_000) {
            out.stdout += `${line}\n`;
          }
          this.sendChunk(taskId, "stdout", `${line}\n`);
          return;
        }
        for (const e of events) {
          if (e.kind === "text") {
            // What the agent says along the way; the final answer replaces it at the end.
            const text = `${String(e.text)}\n\n`;
            out.stdout += text;
            this.sendChunk(taskId, "stdout", text);
          } else {
            this.emitEvent(taskId, e);
          }
        }
        flushReplies();
        if (parser.sessionId) {
          const sess = this.taskSessions.get(taskId);
          if (sess && !sess.sessionId) sess.sessionId = parser.sessionId;
        }
        // Answered and nothing queued: stdin closes so the CLI can exit. Not while it still waits on background
        // tasks (it goes on when they end): a follow-up typed then still reaches the session, as in its TUI.
        // An error answer (quota, API) ends it right away; otherwise at most STEER_AFTER_ANSWER_MS past the
        // answer, in case a task's end never shows in the stream.
        if (parser instanceof ClaudeStreamParser && parser.finished && (parser.queuedTurns ?? 0) === 0) {
          if (parser.activeBackgroundTasks.size === 0 || parser.resultFailed) closeSteer();
          else if (!steerCap) steerCap = setTimeout(closeSteer, STEER_AFTER_ANSWER_MS).unref();
        }
      });
    }
    const onStderr = (text: string) => {
      armTimer();
      out.stderr += text;
      // workbuddy_cli.mjs reports the session it actually runs (a failed resume opens a new one) as
      // "session id: <id>" on stderr; the reply itself goes to stdout.
      const sid = cleanSessionId(/^session id:\s*(\S+)/m.exec(text)?.[1]);
      const sess = this.taskSessions.get(taskId);
      if (sid && sess) sess.sessionId = sid;
      this.sendChunk(taskId, "stderr", text);
    };
    if (consoleText) {
      lineText(proc.stderr, onStderr);
    } else {
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", onStderr);
    }

    return new Promise<number>((resolve, reject) => {
      proc.once("error", (e) => {
        if (timer) clearTimeout(timer);
        if (stallTimer) clearTimeout(stallTimer);
        reject(e);
      });
      proc.once("exit", (code, signal) => {
        if (timer) clearTimeout(timer);
        if (stallTimer) clearTimeout(stallTimer);
        // Let the last output drain, but don't wait on a pipe some leftover child still holds.
        void Promise.race([stdoutDone, new Promise((r) => setTimeout(r, 3000))]).then(() =>
          resolve(timedOut ? TIMED_OUT : (code ?? (signal ? -1 : 1))),
        );
      });
    });
  }

  private notice(taskId: string, text: string): void {
    const out = this.outputs.get(taskId);
    if (out) out.stderr += text;
    this.sendChunk(taskId, "stderr", text);
  }

  /** A model ran out: the server's model picker learns it now rather than at the next quota report. */
  private reportModelLimits(): void {
    void probeAllQuotas(undefined, { force: true })
      .then((quotas) => this.send({ type: "agent_quotas", quotas }))
      .catch(() => {});
  }

  /** The model asked for (or the agent's default) ran out in an earlier task and hasn't reset: one that has quota. */
  /** A command the agent runs here that belongs on the device the code is on (tests, builds, commits): why it is turned down. */
  private executorDeny(taskId: string, use: ToolUse): string | undefined {
    const at = this.editOnly.get(taskId);
    if (!at || use.tool !== "Bash") return undefined;
    const what = executorOnlyEdits(use.input.command ?? "");
    return what ? executorDenyReason(what, at.command, at.source) : undefined;
  }

  private skipLimitedModel(taskId: string, agent: LimitAgent, model: string, models: ModelChoice[], effort: string): string {
    if (!isModelLimited(agent, model)) return model;
    const next = nextModel(agent, models, model, effort);
    if (!next) return model;
    this.notice(taskId, `\n⚡ [模型切换] ${model || "默认模型"} 的额度还没恢复，这次改用 ${next.label}。\n\n`);
    return next.id;
  }

  /** Tasks taken and not over yet, from receipt (preparing a workspace, waiting to start) to the end. */
  private readonly accepted = new Set<string>();

  /** Every task this daemon has on hand: started, or taken and still getting ready. */
  get activeTaskIds(): string[] {
    return [...new Set([...this.accepted, ...this.running.keys()])];
  }

  async execute(task: TaskDispatch): Promise<void> {
    this.accepted.add(task.id);
    try {
      await this.executeTask(task);
    } finally {
      this.accepted.delete(task.id);
    }
  }

  private async executeTask(task: TaskDispatch): Promise<void> {
    const taskId = task.id;
    const { action, payload } = task;
    const text = (key: string) => (payload[key] == null ? "" : String(payload[key]));
    const notAllowed = taskRefusal(action);
    if (notAllowed) {
      this.log(`Refused task ${taskId}: ${notAllowed}`);
      this.send(taskFinishedMessage({ taskId, status: "failed", exitCode: 1, error: notAllowed, errorType: "policy" }));
      return;
    }
    const wsSpec = action === "agent" ? parseWorkspaceSpec(payload.workspace) : undefined;
    /** The code is on another device: the agent works in this device's clone of it. */
    let wsRun: WorkspaceRun | undefined;
    let workDir: string | undefined;
    if (wsSpec) {
      this.eventLogs.set(taskId, new AgentEventLog());
      this.emitEvent(taskId, { kind: "workspace", status: "syncing", source: wsSpec.sourceName, path: wsSpec.sourcePath });
      try {
        if (!this.relay) throw new Error("和服务器的连接还没建立");
        wsRun = await prepareWorkspace(wsSpec, this.relay, { env: await executionEnvironment(), emit: (e) => this.emitEvent(taskId, e) });
        workDir = wsRun.mirror.workDir;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        this.emitEvent(taskId, { kind: "workspace", status: "failed", source: wsSpec.sourceName, error: reason });
        this.send(
          taskFinishedMessage({
            taskId,
            status: "failed",
            exitCode: 1,
            error: `取不到 ${wsSpec.sourceName} 上 ${wsSpec.sourcePath} 的代码：${reason}`,
            events: this.eventLogs.get(taskId)?.events,
          }),
        );
        this.eventLogs.delete(taskId);
        return;
      }
    } else {
      workDir = resolveWorkingDir(text("cwd"), this.log);
    }

    // The company's policy on this computer (managed-policy.ts): which tasks, in which directories
    const refusal =
      (!wsRun && managedPolicy().allowedRoots.length && !(workDir && pathAllowed(workDir))
        ? `这台电脑的管理员策略只允许在 ${managedPolicy().allowedRoots.join("、")} 里运行任务${workDir ? `，${workDir} 不在其中` : ""}`
        : null);
    if (refusal) {
      this.log(`Refused task ${taskId}: ${refusal}`);
      this.send(taskFinishedMessage({ taskId, status: "failed", exitCode: 1, error: refusal, errorType: "policy" }));
      this.eventLogs.delete(taskId);
      return;
    }

    // Refresh the living blueprint before the agent starts, but never hold the task up more than 3 s
    if (workDir && !payload.worktree && !wsRun) {
      const ensuring = ensureProjectBlueprint(workDir, { log: this.log }).catch(() => false);
      await Promise.race([ensuring, new Promise((r) => setTimeout(r, 3_000).unref?.())]);
    }

    let exe = "";
    let args: string[] = [];
    let isAntigravity = false;
    // memento's Antigravity runner (agy_cli.mjs), run on this process's own runtime like the Codex runner
    let agyRunner: string | undefined;
    /** Google's own agy CLI runs the task: the Antigravity app isn't running here (a server without a desktop). */
    let officialAgy = false;
    /** When the task started: the background tasks Google's agy CLI started in it are the ones after this. */
    const startedAt = Date.now();
    // Structured agents (Claude, Codex) report every step through the parser.
    let parser: AgentStreamParser | undefined;
    let stdinPrompt: string | undefined;
    let claudeSettings: string | undefined;
    let consoleEncoding: string | null | undefined;
    let worktree: TaskWorktree | undefined;
    /** Added to the agent's environment (the WorkBuddy gateway to use). */
    const env0: NodeJS.ProcessEnv = {};
    /** Set for Codex tasks: memento's runner and the Codex binary it drives. */
    let codex: { runner: string; codex: string } | undefined;

    const binary = (text("binary") || "claude").toLowerCase();
    let prompt = text("prompt");
    const askedSession = text("session_id").trim();
    // Only an id an agent could have made: text taken for one (an older daemon read `\"\"` out of a tool's
    // output) resumes nothing, so the task starts a session of its own and reports that one instead
    let sessionId = cleanSessionId(askedSession) ?? "";
    this.taskSessions.set(taskId, { binary, sessionId: sessionId || undefined });
    let model = text("model");
    const effort = text("effort");
    const rawSysAppend = text("system_prompt_append");
    const offlineMind = !rawSysAppend ? await getOfflineMindSnapshot() : null;
    let sysAppend = rawSysAppend || offlineMind || "";
    if (workDir) {
      const bpRoot = findGitRoot(workDir) || workDir;
      const bpFile = ["CODE_BLUEPRINT.md", "PROJECT_BLUEPRINT.md"].map((f) => join(bpRoot, f)).find((f) => existsSync(f)) ?? "";
      if (bpFile && !sysAppend.includes("CODE_BLUEPRINT.md") && !sysAppend.includes("PROJECT_BLUEPRINT.md")) {
        let bpHint = `[架构心智指引] 当前项目根目录有随提交更新的代码蓝图 (${bpFile})。新会话或跨模块排查前先读它开头的「0. 速览与章节索引」，再按索引里的行号只读需要的章节，不要整份读入。`;
        const bizFile = join(bpRoot, "BUSINESS_BLUEPRINT.md");
        if (existsSync(bizFile)) {
          bpHint += `\n[业务心智指引] 同目录的业务蓝图 (${bizFile}) 写着用户定下的业务规则、术语、流程和状态归属，每条挂了代码位置和测试。动手前先看开头索引里和这次改动相关的条目；改了条目「代码」里列的文件，确认这条规则还成立；用户提出新的长期规则时，按文件里的格式补一条并挂上代码和测试。`;
        }
        sysAppend = sysAppend ? `${sysAppend}\n\n${bpHint}` : bpHint;
      }
    }
    // The code is on another device: the agent can run its tests and builds there, on its changes
    if (wsRun && action === "agent") {
      this.sourceExec ??= new SourceExecBridge(() => this.relay, (tid, e) => this.emitEvent(tid, e));
      const cli = await this.sourceExec.register(taskId, wsRun);
      if (cli) {
        env0.MEMENTO_SOURCE_URL = cli.url;
        this.editOnly.set(taskId, { command: cli.command, source: wsRun.spec.sourceName });
        const hint = sourceExecHint(cli.command, wsRun.spec.sourceName);
        // Codex and Antigravity take no appended system prompt here: the rules go at the top of the task instead
        if (binary.includes("claude") || binary.includes("workbuddy") || binary.includes("codebuddy")) sysAppend = sysAppend ? `${sysAppend}\n\n${hint}` : hint;
        else prompt = `${hint}\n\n---\n\n${prompt}`;
      }
    }

    // Materialize uploaded base64 images on the local device so local Agent CLI can view them
    if (Array.isArray(payload.images) && payload.images.length > 0) {
      const convId =
        text("conversation_id") ||
        prompt.match(/\/tmp\/memento_images\/([a-zA-Z0-9_-]+)\//)?.[1] ||
        taskId;
      // The prompt names /tmp/memento_images/<conv>/…; on a machine with a /data2 disk the files live
      // there behind a per-conversation link, and stay on /tmp when /data2 isn't writable.
      const tmpDir = join("/tmp/memento_images", convId);
      let imgDir = tmpDir;
      if (existsSync("/data2")) {
        try {
          const bigDir = join("/data2/memento/images", convId);
          mkdirSync(bigDir, { recursive: true });
          mkdirSync("/tmp/memento_images", { recursive: true });
          if (!existsSync(tmpDir)) symlinkSync(bigDir, tmpDir);
          if (realpathSync(tmpDir) === realpathSync(bigDir)) imgDir = bigDir;
        } catch {
          // stay on /tmp
        }
      }
      try {
        mkdirSync(imgDir, { recursive: true });
        // The names the prompt gives them (each question its own, so a later one doesn't overwrite this one's);
        // a server that doesn't send them still says image_<n>
        const names = Array.isArray(payload.image_names) ? payload.image_names.map((n) => String(n ?? "")) : [];
        for (let idx = 0; idx < payload.images.length; idx++) {
          const img = String(payload.images[idx] ?? "");
          if (img.startsWith("data:image/")) {
            const commaIdx = img.indexOf(",");
            if (commaIdx > 0) {
              const header = img.slice(0, commaIdx);
              const b64data = img.slice(commaIdx + 1);
              const mime = header.split(";")[0]?.split(":")[1] ?? "image/png";
              let ext = mime.split("/")[1] ?? "png";
              if (ext === "jpeg") ext = "jpg";
              const given = names[idx] ?? "";
              const imgPath = join(imgDir, /^image_[A-Za-z0-9_]{1,40}\.[a-z0-9]{2,5}$/i.test(given) ? given : `image_${idx + 1}.${ext}`);
              writeFileSync(imgPath, Buffer.from(b64data, "base64"));
            }
          }
        }
      } catch (err) {
        this.log(`Failed to materialize local image attachments: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (action === "shell") {
      const command = text("command");
      if (process.platform === "win32") {
        exe = "powershell.exe";
        args = ["-NoProfile", "-NonInteractive", "-Command", command];
        consoleEncoding = await windowsConsoleEncoding();
      } else {
        exe = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh";
        args = ["-c", command];
      }
    } else {
      isAntigravity = binary.includes("agy") || binary.includes("antigravity");
      const isWorkbuddy = binary.includes("workbuddy") || binary.includes("codebuddy");
      if (isWorkbuddy) await ensureWorkbuddyCliInstalled();
      const candidates = binary === "workbuddy" ? ["workbuddy_cli.mjs", "workbuddy.cmd", "workbuddy", "codebuddy"] : [binary];
      const resolved = isAntigravity ? await antigravityExecutable() : await findExecutable(candidates);
      if (!resolved) {
        let tip = "";
        if (isAntigravity) {
          tip =
            "\n💡 Antigravity 运行脚本没能写入 ~/.gemini/antigravity/bin（检查该目录的写权限和磁盘空间），并请保持 Antigravity 应用运行；处理后重启 Memento。";
        } else if (isWorkbuddy) {
          tip = "\n💡 未检测到 CodeBuddy/WorkBuddy 命令行工具。请运行 npm install -g @tencent-ai/codebuddy-code 进行安装，并确保腾讯 WorkBuddy 客户端保持启动。";
        } else if (binary.includes("claude")) {
          tip = "\n💡 请运行 npm install -g @anthropic-ai/claude-code 安装 Claude Code CLI";
        } else if (binary.includes("codex")) {
          tip = "\n💡 请运行 npm install -g @openai/codex 或参考 Codex 官方文档安装 Codex CLI";
        }
        this.send(
          taskFinishedMessage({ taskId, status: "failed", exitCode: 1, error: `Agent CLI executable not found on device: ${binary}${tip}` }),
        );
        wsRun?.release();
        return;
      }
      exe = resolved;
      if (isAntigravity && exe.toLowerCase().endsWith(".mjs")) {
        agyRunner = exe;
        exe = process.execPath;
      }
      if (!this.eventLogs.has(taskId)) this.eventLogs.set(taskId, new AgentEventLog());

      // Its own worktree and branch, so parallel tasks on one repository don't collide.
      // (A clone of another device's code is a separate checkout already.)
      if (payload.worktree === true && workDir && !wsRun) {
        const made = await TaskWorktree.create(workDir, taskId, { env: await executionEnvironment() });
        if (made.tree) {
          worktree = made.tree;
          workDir = made.tree.workDir;
          this.emitEvent(taskId, { kind: "worktree", status: "created", branch: made.tree.branch, path: made.tree.path });
        } else {
          this.emitEvent(taskId, { kind: "worktree", status: "skipped", reason: made.reason });
        }
      }

      if (binary.includes("claude")) {
        const settings: Record<string, unknown> = {};
        if (effort) settings.effortLevel = effort;
        // Background memory consolidation (auto-dream) never runs as sdk-cli but would under memento's own name;
        // it stays with the user's own Claude Code sessions, as before, rather than spending quota on memento's runs.
        settings.autoDreamEnabled = false;
        Object.assign(env0, claudeClientEnv(payload.claude_entrypoint));
        // Report each tool call to the server, which pushes risky ones to the phone.
        this.hookBridge ??= new HookBridge(
          (tid, use) => this.send({ type: "agent_tool_use", task_id: tid, ...use }),
          (tid, use) => this.executorDeny(tid, use),
        );
        const hooks = await this.hookBridge.claudeHooks(taskId);
        if (hooks) settings.hooks = hooks;
        claudeSettings = Object.keys(settings).length ? JSON.stringify(settings) : undefined;
        model = this.skipLimitedModel(taskId, "claude", model, CLAUDE_MODELS, effort);
        // The session's latest copy is on another device: fetched first, so it goes on here as is
        const sessionHome = text("session_home");
        if (sessionId && sessionHome && workDir) {
          try {
            if (!this.relay) throw new Error("和服务器的连接还没建立");
            const got = await fetchClaudeSession({ sessionId, sourceDeviceId: sessionHome, workDir, relay: this.relay });
            this.emitEvent(taskId, { kind: "session_sync", status: got.status, ...(got.bytes ? { bytes: got.bytes } : {}), ...(got.direct ? { direct_bytes: got.direct } : {}) } as unknown as AgentEvent);
            this.log(`Session ${sessionId} from ${sessionHome}: ${got.status}${got.bytes ? ` (${got.bytes} bytes)` : ""}`);
          } catch (e) {
            throw new Error(`${SESSION_UNAVAILABLE} ${sessionId.slice(0, 8)}：${e instanceof Error ? e.message : e}。可以点「瘦身后重试」，用它的核心记忆快照在这台设备上接着做`);
          }
        }
        if (sessionId) {
          this.idleCompactor.cancel(sessionId);
          // Goes on with the Claude Code build that ran the session last (the terminal's, an editor's): another
          // build starts its requests differently and the whole history is written to the cache again
          try {
            const build = await matchingBuild(exe, await findClaudeSession(sessionId), await executionEnvironment());
            if (build) {
              exe = build.path;
              this.log(`Session ${sessionId} goes on with Claude Code ${build.version} (${build.source}), the build that ran it last${build.had ? `, not ${build.had}` : ""}: its cache still applies`);
            }
          } catch {
            // the default build then
          }
        }
        const sessionName = claudeSessionName(text("title"), text("user_question"), prompt);
        args = claudeArgs({ sessionId, sysAppend, model, settingsJson: claudeSettings, sessionName });
        parser = new ClaudeStreamParser();
        stdinPrompt = prompt;
        this.claudeTasks.add(taskId);
      } else if (binary.includes("codex")) {
        codex = { runner: await codexRunner(), codex: exe };
        exe = process.execPath;
        model = this.skipLimitedModel(taskId, "codex", model, await codexModels(), effort);
        args = codexArgs({ ...codex, workDir, sessionId, fork: payload.fork === true, effort, model, prompt });
        parser = new CodexStreamParser();
        this.runnerTasks.add(taskId);
      } else if (isWorkbuddy) {
        const isNativeCodebuddy = exe.toLowerCase().includes("codebuddy");
        if (!isNativeCodebuddy) {
          // WorkBuddy ≥ 5.8 has no gateway of its own any more: the runner uses the one memento serves for this
          // directory (after the worktree, which moves it).
          const gateway = await this.workbuddyGateway(taskId, workDir, sessionId);
          if (gateway) env0.MEMENTO_WORKBUDDY_GATEWAY_FILE = gateway.file;
          args = [
            ...(sessionId ? ["--resume", sessionId] : []),
            ...(model ? ["--model", model] : []),
            ...(effort ? ["--effort", effort] : []),
            ...(sysAppend ? ["--append-system-prompt", sysAppend] : []),
            "-p",
            prompt,
          ];
          parser = new UniversalStreamParser({ sessionFromStdout: false });
          this.runnerTasks.add(taskId);
        } else {
          // Native WorkBuddy / CodeBuddy CLI supports Claude-compatible stream-json; headless tool use needs -y.
          // A session missing on this device falls through to the "session not found" retry below.
          args = [
            "--output-format",
            "stream-json",
            "-y",
            ...(sessionId ? ["--resume", sessionId] : []),
            ...(model ? ["--model", model] : []),
            ...(effort ? ["--effort", effort] : []),
            ...(sysAppend ? ["--append-system-prompt", sysAppend] : []),
            "-p",
            prompt,
          ];
          parser = new ClaudeStreamParser();
          this.noSteerTasks.add(taskId);
        }
      } else if (isAntigravity) {
        args = antigravityArgs({
          sessionId,
          model,
          effort,
          timeoutSeconds: task.timeoutSeconds,
          prompt,
        });
        parser = new UniversalStreamParser({ sessionFromStdout: false });
        this.runnerTasks.add(taskId);
      } else {
        args = [
          ...(sessionId ? ["--resume", sessionId] : []),
          ...(model ? ["--model", model] : []),
          ...(task.timeoutSeconds > 0 ? ["--timeout", String(Math.max(60, task.timeoutSeconds - 15))] : ["--timeout", "0"]),
          "-p",
          prompt,
        ];
        parser = new UniversalStreamParser();
        this.noSteerTasks.add(taskId);
      }
    }

    this.send({ type: "task_progress", task_id: taskId, status: "running" });
    const out = { stdout: "", stderr: "" };
    this.outputs.set(taskId, out);
    if (askedSession && !sessionId) {
      this.log(`Task ${taskId}: session id ${JSON.stringify(askedSession.slice(0, 60))} isn't one, starting a new session`);
      this.notice(taskId, "\n⚡ [自动自愈] 这个对话记下的会话号无效（不是智能体生成的会话号），已改为新开会话执行，之后的追问会接着这个新会话。\n\n");
    }

    try {
      // The Codex and Antigravity runners run on this process's own runtime (Electron as Node in the desktop app)
      const env = { ...withExeDirOnPath(await executionEnvironment(), codex?.codex ?? agyRunner ?? exe), ...env0 };
      if (codex || agyRunner) env.ELECTRON_RUN_AS_NODE = "1";
      /** Has this task run on Google's agy CLI from here on: its arguments and parser for the first run. */
      const toOfficialCli = async (cli: string) => {
        exe = cli;
        agyRunner = undefined;
        officialAgy = true;
        delete env.ELECTRON_RUN_AS_NODE;
        this.runnerTasks.delete(taskId);
        this.noSteerTasks.add(taskId);
        // Official agy CLI keeps its own trajectory store (~/.gemini/antigravity-cli) separate from the
        // Antigravity desktop app (~/.gemini/antigravity). Passing a desktop-only conversation ID to
        // `agy --conversation` fails with `trajectory not found`, so bridge its recent transcript into a
        // fresh CLI session once; subsequent turns resume that CLI session natively.
        if (sessionId && !antigravityCliHasConversation(sessionId) && antigravityDesktopHasConversation(sessionId)) {
          const desktopSid = sessionId;
          const alreadyHasHistory = prompt.includes("【前文对话历史") || prompt.includes("【前序会话核心记忆快照");
          const ctx = alreadyHasHistory ? undefined : antigravityDesktopTranscriptContext(desktopSid);
          if (ctx) {
            prompt = `${ctx}\n【当前用户指令】\n${prompt}`;
          }
          this.log(`Task ${taskId}: session ${desktopSid} is in Antigravity desktop store only; starting bridged agy CLI session`);
          this.notice(
            taskId,
            `\n⚡ [会话接续] 原会话 ${desktopSid.slice(0, 8)} 属于 Antigravity 桌面应用，官方 agy 命令行使用独立会话库；${ctx ? "已自动携带最近对话上下文" : "已自动"}在 agy 中开启续接会话，后续对话将在新会话里原样继续。\n\n`,
          );
          sessionId = "";
        }
        // A model that ran out of quota in an earlier task: straight to one that has some
        if (isExhausted(model)) {
          const next = nextAgyModel(await listAgyModels(cli, env), model, effort);
          if (next) {
            this.notice(taskId, `\n⚡ [模型切换] ${model || "默认模型"} 的额度还没恢复，这次改用 ${next.label}。\n\n`);
            model = next.id;
          }
        }
        return {
          args: antigravityArgs({ sessionId, model, effort, timeoutSeconds: task.timeoutSeconds, prompt, official: true }),
          parser: new AgyCliStreamParser() as AgentStreamParser,
        };
      };
      if (isAntigravity) {
        const ag = await discoverAntigravityEnv();
        const cli = ag ? undefined : await ensureOfficialAgyCli();
        if (ag) {
          Object.assign(env, ag);
        } else if (cli) {
          // No Antigravity app here, or one that keeps its language server to itself: Google's own CLI in
          // print mode, in its own conversations
          this.log(`Task ${taskId}: Antigravity app not reachable, using Google's agy CLI at ${cli}`);
          ({ args, parser } = await toOfficialCli(cli));
        } else {
          this.send(
            taskFinishedMessage({
              taskId,
              status: "failed",
              exitCode: 1,
              error:
                "💡 本机的 Antigravity 应用不对外开放会话接口（2.34 起不再提供 CSRF 令牌），也没能自动装上 Google 官方 agy 命令行。\n\n" +
                "macOS / Linux：在终端运行 curl -fsSL https://antigravity.google/cli/install.sh | bash\n" +
                "Windows：在 PowerShell 运行 irm https://antigravity.google/cli/install.ps1 | iex\n" +
                "装好后它会沿用 Antigravity 应用的登录（没有桌面的服务器在终端里运行一次 agy 完成登录），之后任务自动改用它。",
            }),
          );
          return;
        }
      }
      /** The model Antigravity retries take: none once Google's CLI turned it down. */
      let agyModel = model;
      /** Antigravity's arguments and parser for a run: memento's runner or Google's CLI. */
      const agyRun = (o: Omit<Parameters<typeof antigravityArgs>[0], "official">) => {
        parser = officialAgy ? new AgyCliStreamParser() : new UniversalStreamParser({ sessionFromStdout: false });
        return { args: antigravityArgs({ ...o, official: officialAgy }), parser };
      };
      /** Where the latest run's stderr starts: a retry that succeeded leaves the earlier errors above it. */
      let runFrom = 0;
      const run = (spec: Omit<RunSpec, "exe" | "cwd" | "env">) => {
        runFrom = out.stderr.length;
        return this.runOnce(
          taskId,
          { exe, cwd: workDir, env, ...spec, args: agyRunner ? [agyRunner, ...spec.args] : spec.args },
          task.timeoutSeconds,
        );
      };

      let exitCode = await run({ args, parser, stdinPrompt, consoleEncoding });
      if (this.cancelledTasks.has(taskId)) {
        this.log(`Task ${taskId} was cancelled by user; skipping retries`);
        return;
      }
      // Errors can come on stderr or inside the JSON stream; retries look at both.
      const errScan = () => `${out.stderr}\n${parser?.errors ?? ""}`;
      const lastErrors = () => `${out.stderr.slice(runFrom)}\n${parser?.errors ?? ""}`;
      if (officialAgy && !model && parser instanceof AgyCliStreamParser) noteDefaultModel(parser.model);

      // Retry 0.1: the Antigravity app's language server turned the runner away (no CSRF token for other
      // programs since 2.34): the same task on Google's CLI, which shares the app's sign-in
      if (exitCode !== 0 && isAntigravity && !officialAgy && isAppAuthRejection(lastErrors()) && !this.cancelledTasks.has(taskId)) {
        const cli = await ensureOfficialAgyCli();
        if (cli) {
          this.log(`Task ${taskId}: Antigravity app refused agentapi (CSRF), retrying on Google's agy CLI at ${cli}`);
          this.notice(taskId, "\n⚡ [环境自愈] Antigravity 应用不再对外开放会话接口，已自动改用 Google 官方 agy 命令行（沿用同一账号登录）重新执行...\n\n");
          const first = await toOfficialCli(cli);
          parser = first.parser;
          agyModel = model;
          exitCode = await run({ args: first.args, parser, stdinPrompt, consoleEncoding });
        }
      }

      // Retry 0.4: Google's CLI ran out of this model's quota (each model has its own): go on with another
      for (let switches = 0; exitCode !== 0 && officialAgy && switches < 3 && !this.cancelledTasks.has(taskId); switches++) {
        const quota = agyQuotaMessage(lastErrors());
        if (!quota) break;
        const models = await listAgyModels(exe, env);
        // No model asked for and the CLI failed before naming it: its default, which `agy models` lists first
        const failed = agyModel || (parser instanceof AgyCliStreamParser ? parser.model : "") || models[0]?.id || "";
        if (!agyModel) noteDefaultModel(failed);
        noteQuotaExhausted(failed, quota);
        this.reportModelLimits();
        const next = nextAgyModel(models, failed, effort);
        if (!next) break;
        const reset = quotaResetMs(quota);
        this.notice(
          taskId,
          `\n⚡ [模型切换] ${failed || "默认模型"} 的额度用完了${reset ? `（约 ${Math.ceil(reset / 3_600_000)} 小时后恢复）` : ""}，改用 ${next.label} 继续。\n\n`,
        );
        agyModel = next.id;
        exitCode = await run(agyRun({ sessionId, model: agyModel, effort, timeoutSeconds: task.timeoutSeconds, prompt }));
      }

      // Retry 0.42: the Antigravity app's model ran out of quota (each has its own; the default heavy model
      // runs out first, Flash still answers): a new session on the runner's other tiers
      if (exitCode !== 0 && isAntigravity && !officialAgy && agyQuotaMessage(lastErrors())) {
        for (const tier of appQuotaFallbacks(model)) {
          if (this.cancelledTasks.has(taskId)) break;
          const quota = agyQuotaMessage(lastErrors())!;
          const reset = quotaResetMs(quota);
          this.notice(
            taskId,
            `\n⚡ [模型切换] ${model || "默认模型"} 的额度用完了${reset ? `（约 ${Math.ceil(reset / 3_600_000)} 小时后恢复）` : ""}，改用 ${tier.toUpperCase()} 档位继续。\n\n`,
          );
          model = tier;
          exitCode = await run(agyRun({ model, effort, timeoutSeconds: task.timeoutSeconds, prompt }));
          if (exitCode === 0 || !agyQuotaMessage(lastErrors())) break;
        }
      }

      // Retry 0.45: Claude Code's or Codex's model ran out (a limit of the model, not the account's): go on with another
      const limitAgent: LimitAgent | undefined = action !== "agent" ? undefined : binary.includes("claude") ? "claude" : binary.includes("codex") ? "codex" : undefined;
      if (limitAgent && !model) noteAgentDefault(limitAgent, parser?.model);
      for (let switches = 0; limitAgent && switches < 3 && !this.cancelledTasks.has(taskId); switches++) {
        const choices = limitAgent === "claude" ? CLAUDE_MODELS : await codexModels();
        const current = model || parser?.model || "";
        const hit =
          limitAgent === "claude"
            ? claudeModelLimit(lastErrors(), current, parser instanceof ClaudeStreamParser ? parser.rejectedLimit : undefined)
            : codexModelLimit(lastErrors(), current, choices);
        if (!hit) break;
        noteModelLimit(limitAgent, hit.model, hit.message, hit.until);
        this.reportModelLimits();
        const next = nextModel(limitAgent, choices, hit.model || current, effort);
        if (!next) break;
        const hours = hit.until ? Math.ceil((hit.until - Date.now()) / 3_600_000) : 0;
        this.notice(
          taskId,
          hit.unsupported
            ? `\n⚡ [模型切换] 这个账号用不了 ${hit.model || current || "默认模型"}，改用 ${next.label} 继续。\n\n`
            : `\n⚡ [模型切换] ${hit.model || current || "默认模型"} 的额度用完了${hours > 0 ? `（约 ${hours} 小时后恢复）` : ""}，改用 ${next.label} 继续。\n\n`,
        );
        model = next.id;
        if (limitAgent === "claude") {
          parser = new ClaudeStreamParser();
          const sessionName = claudeSessionName(text("title"), text("user_question"), prompt);
          exitCode = await run({ args: claudeArgs({ sessionId, sysAppend, model, settingsJson: claudeSettings, sessionName }), parser, stdinPrompt: prompt });
        } else {
          parser = new CodexStreamParser();
          exitCode = await run({ args: codexArgs({ ...codex!, workDir, sessionId, fork: payload.fork === true, effort, model, prompt }), parser });
        }
      }

      // Retry 0: Antigravity's language server moved.
      if (exitCode !== 0 && isAntigravity && (out.stderr + out.stdout).includes("ANTIGRAVITY_LS_ADDRESS is not set")) {
        this.notice(taskId, "\n⚡ [环境自愈] 正在重新检测并绑定本地 Antigravity 运行端口...\n\n");
        const ag = await discoverAntigravityEnv(true);
        if (ag) {
          Object.assign(env, ag);
          exitCode = await run({ args });
        }
      }

      // Retry 0.5: Antigravity model capacity unavailable (503 / RESOURCE_EXHAUSTED): fallback tier
      if (
        exitCode !== 0 &&
        isAntigravity &&
        /No capacity available|UNAVAILABLE.*503|RESOURCE_EXHAUSTED|code 503/i.test(lastErrors()) &&
        !agyQuotaMessage(lastErrors())
      ) {
        const currentModel = (model || "").toLowerCase();
        // The runner's tiers; Google's CLI names its models differently, so it falls back to its default
        const fallbackModel = officialAgy ? "" : currentModel.includes("pro") ? "flash_lite" : "pro";
        this.notice(
          taskId,
          `\n⚡ [模型容灾降级] 检测到当前模型容量不足 (503 No capacity)，已自动切换至 ${fallbackModel ? `${fallbackModel.toUpperCase()} 档位` : "默认模型"}全新会话无缝重试...\n\n`,
        );
        exitCode = await run(agyRun({ model: fallbackModel, effort, timeoutSeconds: task.timeoutSeconds, prompt }));
      }

      // Retry 0.6: Google's CLI doesn't know the model (memento's tier names, or one it dropped): its default
      if (exitCode !== 0 && officialAgy && model && /invalid model selection|not recognized as a known model/i.test(errScan())) {
        this.notice(taskId, `\n⚡ [模型自适应] agy 不认识模型 ${model}，已改用它的默认模型重试...\n\n`);
        agyModel = "";
        exitCode = await run(agyRun({ sessionId, effort, timeoutSeconds: task.timeoutSeconds, prompt }));
      }

      // Retry 1: the ChatGPT app holds the Codex session's writer lock, so fork it instead.
      if (exitCode !== 0 && binary.includes("codex") && sessionId && payload.fork !== true && errScan().includes("already has an active writer")) {
        this.notice(taskId, "\n⚡ [自动重试] 该会话当前正被 ChatGPT 客户端占用锁定，已自动无缝切换为 Fork 分支模式重新执行（完整继承上下文记忆）...\n\n");
        parser = new CodexStreamParser();
        exitCode = await run({ args: codexArgs({ ...codex!, workDir, sessionId, fork: true, effort, model, prompt }), parser });
      }

      // Retry 2: the session to resume isn't on this device (common when dispatching across devices): start fresh.
      const sessionNotFoundDetected = isSessionNotFound(errScan());
      if ((exitCode !== 0 || (!out.stdout.trim() && !parser?.finalText?.trim())) && action !== "shell" && sessionId && sessionNotFoundDetected) {
        this.notice(taskId, "\n⚡ [自动自愈] 本地未找到历史会话（跨设备远程调度或会话过期常见），已自动重置为全新会话重新执行...\n\n");
        if (binary.includes("claude")) {
          parser = new ClaudeStreamParser();
          const sessionName = claudeSessionName(text("title"), text("user_question"), prompt);
          exitCode = await run({ args: claudeArgs({ sysAppend, model, settingsJson: claudeSettings, sessionName }), parser, stdinPrompt: prompt });
        } else if (binary.includes("codex")) {
          parser = new CodexStreamParser();
          exitCode = await run({ args: codexArgs({ ...codex!, workDir, effort, model, prompt }), parser });
        } else if (binary.includes("workbuddy") || binary.includes("codebuddy")) {
          const isNativeCodebuddy = exe.toLowerCase().includes("codebuddy");
          if (!isNativeCodebuddy) {
            parser = new UniversalStreamParser({ sessionFromStdout: false });
            exitCode = await run({
              args: [
                ...(model ? ["--model", model] : []),
                ...(effort ? ["--effort", effort] : []),
                ...(sysAppend ? ["--append-system-prompt", sysAppend] : []),
                "-p",
                prompt,
              ],
              parser,
            });
          } else {
            parser = new ClaudeStreamParser();
            exitCode = await run({
              args: [
                "--output-format",
                "stream-json",
                "-y",
                ...(model ? ["--model", model] : []),
                ...(effort ? ["--effort", effort] : []),
                ...(sysAppend ? ["--append-system-prompt", sysAppend] : []),
                "-p",
                prompt,
              ],
              parser,
            });
          }
        } else if (isAntigravity) {
          if (officialAgy && sessionId && !prompt.includes("【前文对话历史") && !prompt.includes("【前序会话核心记忆快照")) {
            const ctx = antigravityDesktopTranscriptContext(sessionId);
            if (ctx) prompt = `${ctx}\n【当前用户指令】\n${prompt}`;
          }
          exitCode = await run(agyRun({ model: agyModel, effort, timeoutSeconds: task.timeoutSeconds, prompt }));
        } else {
          parser = new UniversalStreamParser();
          exitCode = await run({ args: [...(model ? ["--model", model] : []), "-p", prompt], parser });
        }
      }

      if (exitCode !== 0 && process.platform === "darwin" && /Operation not permitted|Permission denied/.test(out.stderr)) {
        this.notice(
          taskId,
          "\n💡 [权限提示] 检测到 macOS 磁盘访问受限。请在「系统设置 -> 隐私与安全性 -> 完全磁盘访问权限」中添加并开启 Memento。\n",
        );
      }
      // Only the agent's errors are scanned, not its answer, which may well discuss logins.
      const loginHint = exitCode !== 0 ? agentLoginHint(binary, errScan()) : undefined;
      if (loginHint) this.notice(taskId, `\n🔑 [登录失效] ${loginHint}\n`);

      let fullOut = out.stdout.trim();
      const fullErr = stripRuntimeWarnings(out.stderr).trim();
      // A structured run's answer includes all intermediate thoughts and final conclusions from the parser
      const answer = parser?.finalText?.trim();
      if (answer) {
        fullOut = answer;
      } else {
        fullOut = smartTruncateOutput(fullOut);
      }
      const safeErr = smartTruncateOutput(fullErr, 80_000, 20_000, 60_000);
      const streamErrors = parser?.errors.trim() ?? "";
      const timedOut = exitCode === TIMED_OUT;
      const hasStillRunningTag = out.stdout.includes("STATUS_STILL_RUNNING") || fullErr.includes("STATUS_STILL_RUNNING");
      // Google's agy CLI: its conversation's transcript says which background tasks ended. Its stream and the
      // agent's words don't (2026-11-19: both tasks of a run on vps3 exited 0 and it still read as left running).
      const agyOpen = officialAgy && parser?.sessionId ? agyCliOpenBackgroundTasks(parser.sessionId, startedAt) : undefined;
      const isStillRunning = agyOpen
        ? agyOpen.length > 0
        : (!timedOut || hasStillRunningTag) && detectStillRunning(out.stdout, fullErr, parser, exitCode);
      if (agyOpen?.length) this.log(`Task ${taskId}: Antigravity left background tasks running: ${agyOpen.join(", ")}`);
      const promptTooLong = errScan().includes("Prompt is too long") || fullOut.includes("Prompt is too long");

      // memento's runners report the session on stderr, a "session id: <id>" line per run, the last one being
      // the run that counts. Their stdout is the agent's answer and tool output, never read for it: it may
      // quote any id (2026-11-16: a file's `session_id: ""` became the session and no turn after it resumed).
      const reportedSid = [...fullErr.matchAll(/^session id:\s*(\S+)/gim)]
        .map((m) => cleanSessionId(m[1]))
        .filter((s): s is string => !!s)
        .pop();
      const sid = this.runnerTasks.has(taskId)
        ? reportedSid
        : (cleanSessionId(/session id:\s*([0-9a-fA-F-]+)/i.exec(fullOut)?.[1]) ??
          reportedSid ??
          cleanSessionId(/thread[_-]id:\s*([0-9a-fA-F-]+)/i.exec(fullOut)?.[1]));

      if (worktree) {
        try {
          const done = await worktree.finish(await executionEnvironment());
          this.emitEvent(taskId, done);
          // Its directory is gone, and with it the reason for its gateway.
          const gatewayFile = this.taskSessions.get(taskId)?.gatewayFile;
          if (done.status === "removed" && gatewayFile && isWorkbuddyDirGateway(gatewayFile) && !this.gatewaysInUse(taskId).has(gatewayFile)) {
            void stopWorkbuddyGateway(gatewayFile).catch(() => {});
          }
        } catch (e) {
          this.log(`Worktree wrap-up failed for ${taskId}: ${e instanceof Error ? e.message : e}`);
        }
      }

      const sessionFailedFinal = !fullOut && (isSessionNotFound(fullErr) || isSessionNotFound(streamErrors));
      // Out of quota: the run stopped there, whatever background work it had open or however it exited
      const usageLimit =
        action !== "agent"
          ? undefined
          : // The last run's: a model that ran out before another one went on doesn't count
            (usageLimitMessage(lastErrors()) ?? (isAntigravity && exitCode !== 0 ? agyQuotaMessage(lastErrors()) : undefined));
      const effectiveExitCode = (sessionFailedFinal || usageLimit) && exitCode === 0 ? 1 : exitCode;

      if (wsRun) fullOut = toSourcePaths(fullOut, wsRun.mirror.workDir, wsRun.spec.sourcePath);
      if (wsRun && this.relay) {
        // Back to the device the code is on: into its files when the run finished well, else only kept there
        const ok = !this.cancelledTasks.has(taskId) && !usageLimit && !timedOut && effectiveExitCode === 0;
        const run = wsRun;
        wsRun = undefined;
        const done = await finishWorkspace(run, taskId, ok ? "apply" : "save", this.relay, { env: await executionEnvironment() });
        this.emitEvent(taskId, done);
        if (done.status !== "unchanged") this.log(`Workspace changes of ${taskId} -> ${run.spec.sourceDeviceId}: ${done.status}`);
      }

      if (this.cancelledTasks.has(taskId)) {
        this.log(`Task ${taskId} was cancelled by user; skipping final task_finished overwrite`);
        return;
      }

      // Idle from now: compacted before its cache runs out when nobody goes on with it (Claude Code's idle compaction)
      if (parser instanceof ClaudeStreamParser && parser.sessionId && workDir && !usageLimit && !timedOut) {
        void this.idleCompactor
          .schedule({ sessionId: parser.sessionId, cwd: workDir, exe, model: parser.model || model || undefined, env, contextTokens: parser.contextTokens })
          .catch(() => {});
      }

      // Keep Google agy CLI's local conversation title aligned with Memento's conversation title (R-TITLE-CONSISTENT)
      const finalAgySid = officialAgy && effectiveExitCode === 0 ? cleanSessionId(parser?.sessionId) : undefined;
      if (finalAgySid) {
        const desiredTitle = text("title").trim() || extractUserTitleFromText(text("user_question") || prompt);
        if (desiredTitle) {
          try {
            updateAntigravitySessionTitle(finalAgySid, desiredTitle);
          } catch {
            // non-critical title sync
          }
        }
      }

      this.send(
        taskFinishedMessage({
          taskId,
          status: usageLimit
            ? "failed"
            : timedOut && !isStillRunning
              ? "timeout"
              : isStillRunning
                ? "still_running"
                : effectiveExitCode === 0
                  ? "succeeded"
                  : "failed",
          exitCode: effectiveExitCode,
          stdout: fullOut,
          stderr: safeErr,
          error: usageLimit
            ? usageLimit
            : timedOut
              ? `Task timed out after ${task.timeoutSeconds}s`
              : effectiveExitCode !== 0
                ? loginHint || fullErr || streamErrors || (sessionFailedFinal ? "会话未找到或已过期" : `Exit code ${effectiveExitCode}`)
                : null,
          errorType: usageLimit ? "usage_limit" : promptTooLong ? "prompt_too_long" : loginHint ? "agent_login_required" : null,
          sessionId: cleanSessionId(parser?.sessionId) ?? sid ?? (sessionFailedFinal ? null : (sessionId || null)),
          events: this.eventLogs.get(taskId)?.events,
        }),
      );
    } catch (e) {
      if (!this.cancelledTasks.has(taskId)) {
        this.send(taskFinishedMessage({ taskId, status: "failed", exitCode: 1, error: `Execution failed to start: ${e instanceof Error ? e.message : e}` }));
      }
    } finally {
      this.outputs.delete(taskId);
      this.eventLogs.delete(taskId);
      this.claudeTasks.delete(taskId);
      this.answerers.delete(taskId);
      this.runnerTasks.delete(taskId);
      this.noSteerTasks.delete(taskId);
      this.steerInputs.get(taskId)?.end();
      this.steerInputs.delete(taskId);
      this.running.delete(taskId);
      this.taskPids.delete(taskId);
      this.sourceExec?.unregister(taskId);
      this.editOnly.delete(taskId);
      const gatewayFile = this.taskSessions.get(taskId)?.gatewayFile;
      this.taskSessions.delete(taskId);
      // Its idle time starts now.
      if (gatewayFile) void touchWorkbuddyGateway(gatewayFile).catch(() => {});
      if (wsRun) {
        // Stopped or broke off before the wrap-up: whatever it changed is still kept on the source
        const run = wsRun;
        wsRun = undefined;
        if (this.relay) {
          void executionEnvironment()
            .then((env) => finishWorkspace(run, taskId, "save", this.relay!, { env }))
            .then((done) => this.log(`Workspace changes of ${taskId} kept on ${run.spec.sourceDeviceId}: ${done.status}`))
            .catch(() => run.release());
        } else run.release();
      }
      if (workDir && !payload.worktree && !wsSpec && action === "agent") {
        void ensureProjectBlueprint(workDir, { log: this.log }).catch(() => {});
      }
      setTimeout(() => {
        this.cancelledTasks.delete(taskId);
        this.taskLogBuffer.delete(taskId);
        this.taskSeq.delete(taskId);
      }, 30_000);
    }
  }
}
