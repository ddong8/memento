import { EventEmitter } from "node:events";
import { hostname } from "node:os";

import { loadConfig, saveConfig, type CollectorConfig } from "./config.js";
import { discoverAll, toolReport, type DiscoveredTool } from "./discovery.js";
import { checkStop, GUARD_TOOLS, type GuardTool, type StopInput, type Verdict } from "./guard.js";
import { applyGuards } from "./guard-inject.js";
import { IngestClient } from "./ingest.js";
import { applyProfileInjection, PROFILE_SYNC_MS } from "./profile-inject.js";
import { ServerRoute } from "./server-route.js";
import { applySkillInjection } from "./skill-inject.js";
import { FileWatcher } from "./watcher.js";
import { TaskWorktree } from "./worktree.js";
import { WsTaskClient } from "./ws-client.js";

export interface DaemonStatus {
  running: boolean;
  online: boolean;
  deviceName: string;
  deviceId: string;
  serverUrl: string;
  tools: Record<string, Record<string, unknown>>;
  runningTasks: string[];
  startedAt: string | null;
}

const COMMAND_POLL_MS = 30_000;
const WORKBUDDY_GATEWAY_SWEEP_MS = 5 * 60_000;
const LOG_LIMIT = 200;

const sameReport = (a: Record<string, string>, b: Record<string, string> | undefined) =>
  !!b && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

/**
 * The daemon's lifecycle: registers the device, reports its tools, watches their
 * session files, keeps the task socket up, polls control commands, and keeps
 * the resident profile and skills in each enabled tool.
 *
 * Emits "status" (DaemonStatus) and "log" (line) for the desktop app and local API.
 */
export class Daemon extends EventEmitter {
  private config: CollectorConfig | undefined;
  private ingest: IngestClient | undefined;
  private watcher: FileWatcher | undefined;
  private ws: WsTaskClient | undefined;
  private timers: NodeJS.Timeout[] = [];
  private tools: Record<string, DiscoveredTool> = {};
  private online = false;
  private running = false;
  private startedAt: Date | undefined;
  private readonly logs: string[] = [];
  private lastProfileReport: Record<string, string> | undefined;
  private lastSkillReport: Record<string, string> | undefined;
  private lastGuardReport: Record<string, string> | undefined;
  /** Tools the server turned the completion check on for. */
  private guardTools = new Set<GuardTool>();
  private syncing = false;
  private commandPollTimer: NodeJS.Timeout | null = null;

  get status(): DaemonStatus {
    return {
      running: this.running,
      online: this.online,
      deviceName: this.config?.deviceName ?? hostname(),
      deviceId: this.config?.deviceId ?? "unknown",
      serverUrl: this.config?.serverUrl ?? "",
      tools: Object.fromEntries(Object.entries(this.tools).map(([k, t]) => [k, toolReport(t)])),
      runningTasks: this.ws?.runner.runningTaskIds ?? [],
      startedAt: this.startedAt?.toISOString() ?? null,
    };
  }

  get recentLogs(): readonly string[] {
    return this.logs;
  }

  log = (message: string): void => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${message}`;
    this.logs.push(line);
    if (this.logs.length > LOG_LIMIT) this.logs.shift();
    this.emit("log", line);
  };

  private notify(): void {
    this.emit("status", this.status);
  }

  async start(configOverride?: CollectorConfig): Promise<void> {
    if (this.running) return;
    this.log("Starting Memento daemon (Node)...");
    let config = configOverride ?? (await loadConfig());
    if (!config.token) throw new Error("没有 collector token：先在应用里登录，或设置 MEMENTO_SERVER_TOKEN");
    this.config = config;
    this.running = true;
    this.startedAt = new Date();
    this.notify();

    const ingest = new IngestClient(config, this.log);
    this.ingest = ingest;
    // On the server's LAN (as the heartbeat tells), uploads and the task socket skip the public entry
    const route = new ServerRoute(config.serverUrl, config.deviceId, this.log, () => this.ws?.reroute());
    ingest.useRoute(route);

    this.log(`Discovering installed AI tools on ${config.deviceName}...`);
    this.tools = await discoverAll();
    this.log(`Discovered ${Object.keys(this.tools).length} tools: ${Object.keys(this.tools).join(", ")}`);

    this.log(`Connecting to server ${config.serverUrl}...`);
    const key = await ingest.sendHeartbeat();
    if (key && key !== config.remoteExecKey) {
      config = { ...config, remoteExecKey: key };
      this.config = config;
      ingest.updateConfig(config);
      await saveConfig(config).catch(() => {});
      this.log("Enrolled for remote execution (key verified)");
    }
    await ingest.reportDiscovery(this.tools);

    this.watcher = new FileWatcher(config, ingest, this.log);
    void this.watcher.start(this.tools);

    this.ws = new WsTaskClient(config, this.log, (online) => {
      this.online = online;
      this.notify();
      // When WS disconnects, immediately check HTTP fallback and poll more frequently
      if (!online) {
        this.scheduleCommandPoll(5_000);
      }
    });
    this.ws.useRoute(route);
    // Commands are queued for HTTP polling; the server nudges over the socket so they don't wait for it
    this.ws.onCommandsPending(() => this.scheduleCommandPoll(0));
    void this.ws.start();
    // Back onto the LAN when it reappears, and move the socket over once no task is running
    this.timers.push(
      setInterval(() => {
        void route.maybeProbe().then(() => this.ws?.reroute());
      }, 60_000),
    );

    // Control commands over HTTP: adaptive fallback channel (checks every 10 min while WS is online, 30s when offline)
    this.scheduleCommandPoll(5_000);
    // The resident profile and published skills, kept in each enabled tool.
    void this.syncProfileAndSkills();
    this.timers.push(setInterval(() => void this.syncProfileAndSkills(), PROFILE_SYNC_MS));

    // Clean up stale git worktrees and cache artifacts in background periodically
    const runWorktreeGc = () => {
      void TaskWorktree.cleanupStale().then((count) => {
        if (count > 0) this.log(`Cleaned up ${count} stale worktree/cache artifact(s)`);
      }).catch(() => {});
    };
    runWorktreeGc();
    const WORKTREE_GC_INTERVAL_MS = 60 * 60 * 1000;
    this.timers.push(setInterval(runWorktreeGc, WORKTREE_GC_INTERVAL_MS));
    // WorkBuddy gateways (one per task directory) that sat idle, also ones left from before a restart.
    this.timers.push(setInterval(() => this.ws?.runner.sweepIdleGateways(), WORKBUDDY_GATEWAY_SWEEP_MS));

    this.log("Memento daemon is running.");
    this.notify();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.log("Stopping Memento daemon...");
    if (this.commandPollTimer) {
      clearTimeout(this.commandPollTimer);
      this.commandPollTimer = null;
    }
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.watcher?.dispose();
    this.watcher = undefined;
    this.ws?.dispose();
    this.ws = undefined;
    this.ingest = undefined;
    this.running = false;
    this.online = false;
    this.notify();
    this.log("Daemon stopped.");
  }

  /** Discover tools again and tell the server (after installing a tool, say). */
  async rediscover(): Promise<void> {
    this.tools = await discoverAll();
    await this.ingest?.reportDiscovery(this.tools);
    this.notify();
  }

  async resync(): Promise<void> {
    await this.watcher?.resync();
  }

  private scheduleCommandPoll(delayMs = COMMAND_POLL_MS): void {
    if (this.commandPollTimer) clearTimeout(this.commandPollTimer);
    if (!this.running) return;
    this.commandPollTimer = setTimeout(() => {
      void this.pollCommands().finally(() => {
        // While WebSocket is online and active, HTTP command polling is purely a fallback (every 10 minutes).
        // When WebSocket drops offline, poll every 30s to pick up commands promptly.
        const nextDelay = this.online && this.ws?.connected ? 600_000 : COMMAND_POLL_MS;
        this.scheduleCommandPoll(nextDelay);
      });
    }, delayMs);
  }

  private async pollCommands(): Promise<void> {
    const commands = (await this.ingest?.pollCommands()) ?? [];
    for (const cmd of commands) {
      const action = String(cmd.action ?? "");
      this.log(`Server command: ${action}`);
      if (action === "resync") await this.watcher?.resync();
      else if (action === "rediscover") await this.rediscover();
    }
  }

  /**
   * A Stop hook from Claude Code or Codex (local API): block a "done" without a
   * passing check. Every claim it saw is reported, so the server can count how
   * often agents claim without checking and whether they check when sent back.
   */
  async checkStop(tool: GuardTool, input: StopInput): Promise<Verdict> {
    const idle: Verdict = { block: false, outcome: "no_claim", claim: null, deploy: false, followup: false, check: null };
    if (!this.guardTools.has(tool)) return idle;
    let verdict: Verdict;
    try {
      verdict = await checkStop(tool, input);
    } catch (e) {
      this.log(`Completion check skipped: ${e instanceof Error ? e.message : e}`);
      return idle;
    }
    if (verdict.outcome === "no_claim") return verdict;
    if (verdict.block) this.log(`Completion check (${tool}): sent back, ${verdict.outcome}`);
    void this.ingest?.reportGuardEvent({
      tool,
      session_id: input.session_id ?? null,
      cwd: input.cwd ?? null,
      outcome: verdict.outcome,
      blocked: verdict.block,
      followup: verdict.followup,
      deploy: verdict.deploy,
      claim: verdict.claim,
      check: verdict.check,
      at: new Date().toISOString(),
    });
    return verdict;
  }

  async syncProfileAndSkills(): Promise<void> {
    const ingest = this.ingest;
    if (!ingest || this.syncing) return;
    this.syncing = true;
    try {
      const profile = await ingest.fetchProfileInjection();
      if (profile) {
        const results = await applyProfileInjection({ version: profile.version, block: profile.block, targets: profile.targets ?? [] });
        for (const [tool, outcome] of Object.entries(results)) if (outcome !== "unchanged") this.log(`Profile ${tool}: ${outcome}`);
        if (!sameReport(results, this.lastProfileReport)) {
          await ingest.reportProfileInjection(profile.version, results);
          this.lastProfileReport = results;
        }
        const wanted = (profile.guards?.completion_evidence ?? []).filter((t): t is GuardTool => (GUARD_TOOLS as readonly string[]).includes(t));
        this.guardTools = new Set(wanted);
        const guards = await applyGuards({ tools: wanted });
        for (const [tool, outcome] of Object.entries(guards)) if (outcome !== "unchanged") this.log(`Completion check ${tool}: ${outcome}`);
        if (!sameReport(guards, this.lastGuardReport)) {
          await ingest.reportGuardStatus(guards);
          this.lastGuardReport = guards;
        }
      }
      const skills = await ingest.fetchSkillInjection();
      if (skills) {
        const results = await applySkillInjection({ skills: skills.skills ?? [], targets: skills.targets ?? [] });
        for (const [what, outcome] of Object.entries(results)) if (outcome !== "unchanged") this.log(`Skill ${what}: ${outcome}`);
        if (!sameReport(results, this.lastSkillReport)) {
          await ingest.reportSkillInjection(results);
          this.lastSkillReport = results;
        }
      }
    } catch (e) {
      this.log(`Profile/skill sync skipped: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.syncing = false;
    }
  }
}
