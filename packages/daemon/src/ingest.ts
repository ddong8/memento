import type { CollectorConfig } from "./config.js";
import { toolReport, type DiscoveredTool } from "./discovery.js";
import { sanitizeDocumentContent } from "./sanitizer.js";
import { hostFetch, type LanInfo, type ServerRoute } from "./server-route.js";

export const DAEMON_VERSION = "node-0.1.0";

export interface IngestDocument {
  toolId: string;
  category: string;
  contentType: string;
  relativePath: string;
  content: string;
  contentHash: string;
  offset?: number;
  fileSize?: number;
  mode?: "full" | "delta";
  metadata?: Record<string, unknown>;
}

type Log = (message: string) => void;

/** HTTP calls a device makes as itself (collector token + device id), not as the user. */
export class IngestClient {
  private route: ServerRoute | undefined;

  constructor(
    private config: CollectorConfig,
    private readonly log: Log = () => {},
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  updateConfig(config: CollectorConfig): void {
    this.config = config;
  }

  /** Requests go to the server's LAN address while the route has one, else to the public URL. */
  useRoute(route: ServerRoute): void {
    this.route = route;
  }

  get headers(): Record<string, string> {
    return {
      "X-Collector-Token": this.config.token,
      "X-Device-Id": this.config.deviceId,
      "X-Device-Name": this.config.deviceName,
      "X-Device-Platform": this.config.platform,
      "X-Collector-Version": DAEMON_VERSION,
    };
  }

  private async request(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<Response> {
    const method = init.method ?? "GET";
    const headers = { ...this.headers, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) };
    const body = init.body !== undefined ? JSON.stringify(init.body) : undefined;
    const timeoutMs = init.timeoutMs ?? 20_000;
    const lan = this.route?.target();
    if (lan?.host) {
      try {
        return await hostFetch(`${lan.base}${path}`, { method, headers, body, timeoutMs }, lan.host);
      } catch (e) {
        this.route?.drop(`内网请求失败（${e instanceof Error ? e.message : e}）`);
      }
    }
    return this.fetchImpl(`${this.config.serverUrl}${path}`, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  }

  private readonly offlineBuffer: IngestDocument[] = [];
  private readonly maxOfflineBuffer = 100;

  /** Heartbeat; returns the remote-exec key the server hands out (or the one already held). */
  async sendHeartbeat(): Promise<string | undefined> {
    try {
      const res = await this.request("/api/ingest/heartbeat", { method: "POST", body: {} });
      if (res.ok) {
        void this.flushOfflineBuffer();
        const data = (await res.json()) as { remote_exec_key?: string; lan?: LanInfo };
        await this.route?.update(data.lan);
        if (data.remote_exec_key) return data.remote_exec_key;
      }
    } catch (e) {
      this.log(`Heartbeat failed: ${e instanceof Error ? e.message : e}`);
    }
    return this.config.remoteExecKey;
  }

  /** Flush any documents queued while offline once connectivity is restored. */
  async flushOfflineBuffer(): Promise<number> {
    if (!this.offlineBuffer.length) return 0;
    let sent = 0;
    while (this.offlineBuffer.length) {
      const doc = this.offlineBuffer[0]!;
      const ok = await this.uploadSingleDocument(doc);
      if (!ok) break;
      this.offlineBuffer.shift();
      sent++;
    }
    return sent;
  }

  private async uploadSingleDocument(doc: IngestDocument): Promise<boolean> {
    try {
      const sanitized = sanitizeDocumentContent(doc.content, doc.contentType);
      const metadata = { ...(doc.metadata ?? {}) };
      if (
        typeof doc.content === "string" &&
        /(?:以后|严禁|杜绝|不要|不能|必须|统一|切记|记住)(?:在|用|加|使用|包含|反问|回滚|删除)/.test(doc.content)
      ) {
        metadata.is_user_correction = true;
      }

      const res = await this.request("/api/ingest/file", {
        method: "POST",
        timeoutMs: 30_000,
        body: {
          tool: doc.toolId,
          category: doc.category,
          content_type: doc.contentType,
          relative_path: doc.relativePath,
          content: sanitized,
          hash: doc.contentHash,
          file_size: doc.fileSize ?? Buffer.byteLength(sanitized),
          mode: doc.mode ?? "full",
          offset: doc.offset ?? 0,
          metadata,
        },
      });
      if (res.ok) return true;
      this.log(`Upload ${doc.relativePath} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return false;
    } catch (e) {
      this.log(`Upload ${doc.relativePath} failed: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  async reportDiscovery(tools: Record<string, DiscoveredTool>): Promise<boolean> {
    try {
      const res = await this.request("/api/ingest/discovery", {
        method: "POST",
        body: {
          device_id: this.config.deviceId,
          device_name: this.config.deviceName,
          platform: this.config.platform,
          tools: Object.fromEntries(Object.entries(tools).map(([k, t]) => [k, toolReport(t)])),
        },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Upload a file or a slice of one, with secrets stripped first. Automatically buffers offline on transient errors. */
  async ingestDocument(doc: IngestDocument): Promise<boolean> {
    if (this.offlineBuffer.length) {
      await this.flushOfflineBuffer();
    }
    const ok = await this.uploadSingleDocument(doc);
    if (!ok && this.offlineBuffer.length < this.maxOfflineBuffer) {
      this.offlineBuffer.push(doc);
    }
    return ok;
  }

  /** Control commands (resync etc.), acknowledged as they're picked up. */
  async pollCommands(): Promise<Record<string, unknown>[]> {
    try {
      const res = await this.request("/api/devices/commands");
      if (!res.ok) return [];
      const commands = (await res.json()) as Record<string, unknown>[];
      for (const cmd of commands) {
        if (cmd.id !== undefined) void this.request(`/api/devices/commands/${cmd.id}/ack`, { method: "POST" }).catch(() => {});
      }
      return commands;
    } catch {
      return [];
    }
  }

  /** The published profile block and the tools this device carries it in; null when unreachable. */
  async fetchProfileInjection(): Promise<{ version?: number | null; block?: string | null; targets?: string[] } | null> {
    return this.getJson("/api/profile/injection");
  }

  async reportProfileInjection(version: number | null | undefined, results: Record<string, string>): Promise<void> {
    await this.request("/api/profile/injection/status", { method: "POST", body: { version, results } }).catch(() => {});
  }

  /** Published skills and the tools whose skills folders get them; null when unreachable. */
  async fetchSkillInjection(): Promise<{ skills?: Record<string, unknown>[]; targets?: string[] } | null> {
    return this.getJson("/api/skills/injection");
  }

  async reportSkillInjection(results: Record<string, string>): Promise<void> {
    await this.request("/api/skills/injection/status", { method: "POST", body: { results } }).catch(() => {});
  }

  private async getJson<T>(path: string): Promise<T | null> {
    try {
      const res = await this.request(path);
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  }
}
