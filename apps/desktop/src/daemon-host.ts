import { app, utilityProcess, type UtilityProcess } from "electron";
import { EventEmitter } from "node:events";
import { join, sep } from "node:path";

import { flutterAppRunning, readLocalApiInfo, runningCollectorPid, type LocalApiInfo } from "@memento/daemon";

export type DaemonMode = "starting" | "running" | "external" | "flutter" | "stopped" | "no-token" | "crashed";

/**
 * Runs the daemon in a utility process and talks to it over its loopback API.
 * If a collector already runs on this machine (a standalone daemon, or the
 * Flutter app's), it attaches instead of starting a second one.
 */
export class DaemonHost extends EventEmitter {
  private child: UtilityProcess | undefined;
  private restarts = 0;
  private stopping = false;
  private events: AbortController | undefined;
  mode: DaemonMode = "stopped";
  private readonly logs: string[] = [];

  private setMode(mode: DaemonMode): void {
    this.mode = mode;
    this.emit("mode", mode);
  }

  private log(line: string): void {
    console.log(`[daemon] ${line}`);
    this.logs.push(line);
    if (this.logs.length > 300) this.logs.shift();
    this.emit("log", line);
  }

  get recentLogs(): readonly string[] {
    return this.logs;
  }

  /** Packaged, the daemon and its assets live outside the asar archive (see asarUnpack). */
  private unpacked(path: string): string {
    return path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  }

  private entry(): string {
    return this.unpacked(join(__dirname, "daemon.mjs"));
  }

  async start(): Promise<void> {
    this.stopping = false;
    const other = await runningCollectorPid();
    if (other) {
      const info = await readLocalApiInfo();
      if (info && info.pid === other) {
        this.setMode("external");
        this.log(`Using the daemon already running (pid ${other})`);
        this.subscribe();
      } else {
        this.setMode("flutter");
        this.log(`Another Memento collector is running (pid ${other}); not starting a second one`);
      }
      return;
    }
    if (!process.env.MEMENTO_DAEMON_FORCE && (await flutterAppRunning([process.pid]))) {
      // Its built-in collector writes no pid file: check again later, it may be quit.
      this.setMode("flutter");
      this.log("The older Memento app is running and collects itself; not starting a second collector");
      setTimeout(() => !this.stopping && this.mode === "flutter" && void this.start(), 60_000);
      return;
    }
    this.spawn();
  }

  private spawn(): void {
    this.setMode("starting");
    const child = utilityProcess.fork(this.entry(), [], {
      serviceName: "Memento Daemon",
      stdio: "pipe",
      env: {
        ...process.env,
        MEMENTO_DAEMON_EMBEDDED: "1",
        MEMENTO_DESKTOP_VERSION: app.getVersion(),
        MEMENTO_AGY_RUNNER: this.unpacked(join(__dirname, "..", "assets", "agy_cli.py")),
        MEMENTO_WORKBUDDY_RUNNER: this.unpacked(join(__dirname, "..", "assets", "workbuddy_cli.mjs")),
      },
    });
    this.child = child;
    const pipe = (stream: NodeJS.ReadableStream | null | undefined) => {
      let buf = "";
      stream?.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) if (l.trim()) this.log(l);
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on("spawn", () => {
      // The loopback API comes up a moment after the process starts.
      setTimeout(() => this.subscribe(), 1500);
    });
    child.on("exit", (code) => {
      this.child = undefined;
      this.events?.abort();
      if (this.stopping) {
        this.setMode("stopped");
        return;
      }
      const noToken = this.logs.slice(-5).some((l) => l.includes("collector token"));
      if (noToken) {
        this.setMode("no-token");
        return;
      }
      if (code === 3) {
        // The Flutter app started in the meantime and collects itself.
        this.setMode("flutter");
        setTimeout(() => !this.stopping && this.mode === "flutter" && void this.start(), 60_000);
        return;
      }
      this.setMode("crashed");
      const delay = Math.min(60, 2 ** Math.min(this.restarts++, 6));
      this.log(`Daemon exited (code ${code}); restarting in ${delay}s`);
      setTimeout(() => !this.stopping && void this.start(), delay * 1000);
    });
  }

  /** Follows the daemon's status and log events. */
  private async subscribe(): Promise<void> {
    const info = await readLocalApiInfo();
    if (!info) return;
    this.events?.abort();
    const ctrl = new AbortController();
    this.events = ctrl;
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/events`, {
        headers: { Authorization: `Bearer ${info.token}` },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) return;
      if (this.mode === "starting") this.setMode("running");
      this.restarts = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (!event || !data) continue;
          try {
            this.emit(event, JSON.parse(data));
          } catch {
            // ignore a malformed frame
          }
        }
      }
    } catch {
      // aborted or the daemon went away
    }
  }

  /** A call to the daemon's loopback API. */
  async call(method: "GET" | "POST", path: string): Promise<unknown> {
    const info: LocalApiInfo | undefined = await readLocalApiInfo();
    if (!info) throw new Error("本机守护进程没有运行");
    const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`守护进程返回 ${res.status}`);
    return res.json();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.events?.abort();
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      // The daemon shuts down cleanly (saves offsets, removes its pid file) on this message.
      child.postMessage({ type: "stop" });
    });
  }
}
