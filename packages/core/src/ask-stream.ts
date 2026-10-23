import type { AskRequest, AskStreamEvent } from "./events.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AskStreamOptions {
  baseUrl: string;
  token?: string | null;
  /** fetch with streaming response bodies. Browsers, Node and Electron have it; on React Native pass expo/fetch. */
  fetch?: FetchLike;
  /** The server sends a keepalive every 8 s; this long without a byte means the connection is dead. */
  idleTimeoutMs?: number;
  onEvent: (event: AskStreamEvent) => void;
  /** The run is no longer on the server (finished a while ago, or the server restarted). */
  onRunGone?: () => void;
  /** Called once when following stops, whatever the reason. */
  onDone?: () => void;
  /** Delay helper, replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Plain-language reason a send failed, for showing to the user. */
export class AskStreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AskStreamError";
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function newRequestId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Streams one ask run from the server.
 *
 * The run lives on the server independently of this connection: if the socket
 * drops (network change, app backgrounded), the run and any device task keep
 * going, and this reattaches from the last event id it saw, so nothing is sent
 * or dispatched twice. Only {@link AskStream.stop} ends the run itself.
 */
export class AskStream {
  private conversationId: string | undefined;
  private lastEventId: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly idleTimeoutMs: number;
  private cancelled = false;
  private request: AbortController | undefined;

  private constructor(
    private readonly options: AskStreamOptions,
    conversationId: string | undefined,
    lastEventId: number,
  ) {
    this.conversationId = conversationId;
    this.lastEventId = lastEventId;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
  }

  /** Start a run. Retries the send (with the same request id) until the server has it. */
  static ask(body: AskRequest, options: AskStreamOptions): AskStream {
    const stream = new AskStream(options, undefined, 0);
    void stream.runAsk({ ...body, request_id: body.request_id ?? newRequestId() });
    return stream;
  }

  /** Follow a run that's already going. `after` is the last event id already applied (0 replays it all). */
  static attach(conversationId: string, after: number, options: AskStreamOptions): AskStream {
    const stream = new AskStream(options, conversationId, after);
    void stream.runFollow(true);
    return stream;
  }

  get following(): boolean {
    return !this.cancelled;
  }

  get conversation(): string | undefined {
    return this.conversationId;
  }

  get lastId(): number {
    return this.lastEventId;
  }

  /** Stop receiving; the run keeps going on the server. */
  detach(): void {
    this.cancelled = true;
    this.request?.abort();
  }

  /** Drop the current connection and resume from the last event right away. */
  reconnect(): void {
    if (this.conversationId) this.request?.abort();
  }

  /** Stop the run itself, including any device task it's waiting on. */
  async stop(): Promise<void> {
    const id = this.conversationId;
    this.detach();
    if (!id) return;
    try {
      await this.fetchImpl(`${this.base}/api/ask/conversations/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        headers: this.headers(false),
      });
    } catch {
      // Already finished, or unreachable: nothing left to stop from here.
    }
  }

  private get base(): string {
    return this.options.baseUrl.replace(/\/+$/, "");
  }

  private headers(stream: boolean): Record<string, string> {
    return {
      ...(stream ? { Accept: "text/event-stream" } : {}),
      "Content-Type": "application/json",
      ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
    };
  }

  private async runAsk(body: AskRequest): Promise<void> {
    try {
      let done = false;
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts && !this.cancelled; attempt++) {
        try {
          const response = await this.open(`${this.base}/api/ask`, { method: "POST", body: JSON.stringify(body) });
          if (response.status === 409) {
            this.options.onEvent({ type: "error", message: "这个对话还有任务在运行，请等它结束或先停止" });
            return;
          }
          if (!response.ok) throw new AskStreamError(describeStatus(response.status), response.status);
          done = await this.consume(response);
          break;
        } catch (e) {
          if (this.cancelled) return;
          // The run exists server-side from here on: follow it, never resend.
          if (this.conversationId) break;
          if (isRetryable(e) && attempt < maxAttempts) {
            await this.sleep(1200 * attempt);
            continue;
          }
          this.options.onEvent({ type: "error", message: describeError(e) });
          return;
        }
      }
      if (!done && !this.cancelled && this.conversationId) await this.follow();
    } finally {
      this.cancelled = true;
      this.options.onDone?.();
    }
  }

  private async runFollow(standalone: boolean): Promise<void> {
    try {
      await this.follow();
    } finally {
      if (standalone) {
        this.cancelled = true;
        this.options.onDone?.();
      }
    }
  }

  /** Reattach from the last seen event until the run ends, backing off while the network is down. */
  private async follow(): Promise<void> {
    let failures = 0;
    while (!this.cancelled) {
      try {
        const url = `${this.base}/api/ask/conversations/${encodeURIComponent(this.conversationId!)}/stream?after=${this.lastEventId}`;
        const response = await this.open(url, { method: "GET" });
        if (response.status === 404) {
          this.options.onRunGone?.();
          return;
        }
        if (!response.ok) throw new AskStreamError(describeStatus(response.status), response.status);
        const before = this.lastEventId;
        if (await this.consume(response)) return;
        if (this.lastEventId > before) failures = 0;
      } catch {
        if (this.cancelled) return;
        // An abort from reconnect(): resume at once.
      }
      failures++;
      await this.sleep(Math.min(2 * failures, 15) * 1000);
    }
  }

  private async open(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    this.request = controller;
    return this.fetchImpl(url, { ...init, headers: this.headers(true), signal: controller.signal });
  }

  /** Read one SSE response, dispatching events. Resolves true once the run is done. */
  private async consume(response: Response): Promise<boolean> {
    const reader = response.body?.getReader();
    if (!reader) throw new AskStreamError("服务器没有返回数据流");
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    const controller = this.request;

    const processFrame = (frame: string) => {
      for (const line of frame.split("\n")) {
        if (line.startsWith("id: ")) {
          const id = Number.parseInt(line.slice(4).trim(), 10);
          if (Number.isFinite(id)) this.lastEventId = id;
          continue;
        }
        if (!line.startsWith("data: ")) continue;
        const json = line.slice(6).trim();
        if (!json) continue;
        let event: AskStreamEvent;
        try {
          event = JSON.parse(json) as AskStreamEvent;
        } catch {
          continue; // a single malformed frame
        }
        if (event.type === "conversation_id" && event.id) this.conversationId = event.id;
        if (event.type === "done") done = true;
        this.options.onEvent(event);
      }
    };

    let idle: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        // Aborting the request alone doesn't always wake a pending read; cancel the reader too.
        controller?.abort();
        reader.cancel().catch(() => {});
      }, this.idleTimeoutMs);
    };
    try {
      armIdle();
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        armIdle();
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) processFrame(frame);
        if (done) {
          try {
            await reader.cancel();
          } catch {}
          break;
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) processFrame(buffer);
    } finally {
      if (idle) clearTimeout(idle);
    }
    return done;
  }
}

function describeStatus(status: number): string {
  if (status >= 500) return `服务端暂时繁忙或正在重启升级（HTTP ${status}），请稍候重试`;
  if (status === 401) return "登录已过期，请重新登录";
  return `请求失败（HTTP ${status}）`;
}

function isRetryable(e: unknown): boolean {
  if (e instanceof AskStreamError) return e.status !== undefined && e.status >= 502 && e.status <= 504;
  // fetch rejects with a TypeError when the network is down or the connection dropped.
  return e instanceof TypeError || (e instanceof Error && e.name === "AbortError");
}

function describeError(e: unknown): string {
  if (e instanceof AskStreamError) return e.message;
  if (e instanceof TypeError) return "网络连接不可用，请检查网络后重试";
  return `请求异常：${e instanceof Error ? e.message : String(e)}`;
}
