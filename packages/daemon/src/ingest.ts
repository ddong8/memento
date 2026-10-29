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
  /** Where a slice of a log ends in the file: the server stores each slice once, in order. */
  endOffset?: number;
  metadata?: Record<string, unknown>;
}

/** What an upload came to. */
export interface UploadResult {
  ok: boolean;
  /** Where the server's copy of the log ends (a slice it had already: a retry whose first try went in). */
  nextOffset?: number;
  /** The slice doesn't follow what the server holds: the next one has to start here (HTTP 409). */
  expectedOffset?: number;
  /** Failed for a reason that passes (network, timeout, 5xx, 429): try again after a while. */
  retryable?: boolean;
  error?: string;
}

const retryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;

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

  /** Heartbeat, with how collection is going; returns the remote-exec key the server hands out (or the one already held). */
  async sendHeartbeat(collect?: object): Promise<string | undefined> {
    try {
      const res = await this.request("/api/ingest/heartbeat", { method: "POST", body: collect ? { collect } : {} });
      if (res.ok) {
        const data = (await res.json()) as { remote_exec_key?: string; lan?: LanInfo };
        await this.route?.update(data.lan);
        if (data.remote_exec_key) return data.remote_exec_key;
      }
    } catch (e) {
      this.log(`Heartbeat failed: ${e instanceof Error ? e.message : e}`);
    }
    return this.config.remoteExecKey;
  }

  /** The request body for one document, with secrets stripped. */
  private uploadBody(doc: IngestDocument): Record<string, unknown> {
    const sanitized = sanitizeDocumentContent(doc.content, doc.contentType);
    const metadata = { ...(doc.metadata ?? {}) };
    if (
      typeof doc.content === "string" &&
      /(?:以后|严禁|杜绝|不要|不能|必须|统一|切记|记住)(?:在|用|加|使用|包含|反问|回滚|删除)/.test(doc.content)
    ) {
      metadata.is_user_correction = true;
    }
    return {
      tool: doc.toolId,
      category: doc.category,
      content_type: doc.contentType,
      relative_path: doc.relativePath,
      content: sanitized,
      hash: doc.contentHash,
      file_size: doc.fileSize ?? Buffer.byteLength(sanitized),
      mode: doc.mode ?? "full",
      offset: doc.offset ?? 0,
      ...(doc.endOffset !== undefined ? { end_offset: doc.endOffset } : {}),
      metadata,
    };
  }

  /**
   * Upload a file or a slice of one, with secrets stripped first. Nothing is kept to send later: what
   * didn't go in is still past the file's offset and goes up again from there. (An offline buffer
   * replayed old slices after newer ones had gone up, and the server appended them twice: 10-27, 10-28.)
   */
  async ingestDocument(doc: IngestDocument): Promise<UploadResult> {
    try {
      const res = await this.request("/api/ingest/file", { method: "POST", timeoutMs: 30_000, body: this.uploadBody(doc) });
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { next_offset?: number | null };
        return { ok: true, ...(typeof data.next_offset === "number" ? { nextOffset: data.next_offset } : {}) };
      }
      const body = (await res.text()).slice(0, 2000);
      if (res.status === 409) {
        const expected = expectedOffsetOf(body);
        if (expected !== undefined) return { ok: false, expectedOffset: expected };
      }
      const error = `HTTP ${res.status}: ${body.slice(0, 200)}`;
      this.log(`Upload ${doc.relativePath} ${error}`);
      return { ok: false, retryable: retryableStatus(res.status), error };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.log(`Upload ${doc.relativePath} failed: ${error}`);
      return { ok: false, retryable: true, error };
    }
  }

  /** Until when the server is taken to be one from before /api/ingest/files (documents go one by one). */
  private batchUnsupportedUntil = 0;

  /**
   * Several small documents in one request, what came of each, in order. A collector catching up
   * sent 1,600 small files one request each (2026-10-28).
   */
  async ingestBatch(docs: IngestDocument[]): Promise<UploadResult[]> {
    if (docs.length === 1 || Date.now() < this.batchUnsupportedUntil) {
      const out: UploadResult[] = [];
      for (const doc of docs) out.push(await this.ingestDocument(doc));
      return out;
    }
    try {
      const res = await this.request("/api/ingest/files", {
        method: "POST",
        timeoutMs: 60_000,
        body: { files: docs.map((d) => this.uploadBody(d)) },
      });
      if (res.status === 404 || res.status === 405) {
        this.batchUnsupportedUntil = Date.now() + 3_600_000; // asked again in an hour: the server may have been updated
        return this.ingestBatch(docs);
      }
      if (!res.ok) {
        const error = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
        this.log(`Upload of ${docs.length} files ${error}`);
        return docs.map(() => ({ ok: false, retryable: retryableStatus(res.status), error }));
      }
      const { results } = (await res.json()) as {
        results?: { ok?: boolean; error?: string; next_offset?: number | null; expected_offset?: number }[];
      };
      return docs.map((d, i) => {
        const r = results?.[i];
        if (r?.ok === true) return { ok: true, ...(typeof r.next_offset === "number" ? { nextOffset: r.next_offset } : {}) };
        if (typeof r?.expected_offset === "number") return { ok: false, expectedOffset: r.expected_offset };
        const error = r?.error ?? "unknown";
        this.log(`Upload ${d.relativePath} failed: ${error}`);
        // A file the server failed on (its database, say): tried again with the next scan
        return { ok: false, retryable: true, error };
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.log(`Upload of ${docs.length} files failed: ${error}`);
      return docs.map(() => ({ ok: false, retryable: true, error }));
    }
  }

  /**
   * The logs whose copy on the server doesn't end where this device's offset says, with where it
   * does end; null when the server can't tell (one from before /api/ingest/reconcile, or unreachable).
   */
  async reconcile(files: { tool: string; relativePath: string; offset: number }[]): Promise<{ tool: string; relativePath: string; expectedOffset: number }[] | null> {
    try {
      const res = await this.request("/api/ingest/reconcile", {
        method: "POST",
        timeoutMs: 60_000,
        body: { files: files.map((f) => ({ tool: f.tool, relative_path: f.relativePath, offset: f.offset })) },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { files?: { tool: string; relative_path: string; expected_offset: number }[] };
      return (data.files ?? []).map((f) => ({ tool: f.tool, relativePath: f.relative_path, expectedOffset: f.expected_offset }));
    } catch {
      return null;
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
  async fetchProfileInjection(): Promise<{
    version?: number | null;
    block?: string | null;
    targets?: string[];
    /** Tools the completion check (guard.ts) is on for. */
    guards?: { completion_evidence?: string[] };
  } | null> {
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

  /** One stop the completion check looked at (guard.ts); best effort. */
  async reportGuardEvent(event: Record<string, unknown>): Promise<void> {
    await this.request("/api/learning/guard/events", { method: "POST", body: { events: [event] } }).catch(() => {});
  }

  async reportGuardStatus(results: Record<string, string>): Promise<void> {
    await this.request("/api/learning/guard/status", { method: "POST", body: { results } }).catch(() => {});
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

/** expected_offset from a 409's body ({"detail": {"expected_offset": n}}). */
function expectedOffsetOf(body: string): number | undefined {
  try {
    const detail = (JSON.parse(body) as { detail?: { expected_offset?: unknown } }).detail;
    const n = detail?.expected_offset;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
  } catch {
    return undefined;
  }
}
