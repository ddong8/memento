/**
 * The Memento server's REST API as the MCP server uses it. Authenticates with
 * the device's collector token (exchanged for a JWT, renewed before it expires)
 * or a JWT given directly; when the server rejects the token it re-reads it
 * through `tokenLoader`, so a rotated device token doesn't break every AI tool.
 */
export type Json = Record<string, unknown>;

const JWT_MAX_AGE_MS = 20 * 60 * 60_000; // tokens expire at 24 h

export class RemoteClient {
  readonly baseUrl: string;
  private jwt: string | undefined;
  private jwtAt = 0;

  constructor(
    serverUrl: string,
    private token: string,
    private readonly tokenLoader?: () => Promise<string | undefined>,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.baseUrl = serverUrl.replace(/\/+$/, "");
  }

  private async exchange(token: string): Promise<string> {
    // A JWT works as is.
    const me = await this.fetchImpl(`${this.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (me.ok) return token;
    const res = await this.fetchImpl(`${this.baseUrl}/api/auth/token-exchange`, {
      method: "POST",
      headers: { "X-Collector-Token": token },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { access_token?: string };
      if (data.access_token) return data.access_token;
    }
    if (res.ok || res.status === 401 || res.status === 403) {
      throw new Error(
        `Invalid token: ${this.baseUrl} doesn't accept it. Sign in to the Memento app on this device again (it writes ~/.memento/collector.json); ` +
          "AI tools should start the MCP server bundled with the app, with no --token or MEMENTO_SERVER_TOKEN, so it always uses that sign-in.",
      );
    }
    throw new Error(`${this.baseUrl} returned ${res.status} on sign-in; the server may be unreachable for now, try again shortly.`);
  }

  private async ensureJwt(): Promise<string> {
    if (this.jwt && Date.now() - this.jwtAt < JWT_MAX_AGE_MS) return this.jwt;
    this.jwt = undefined;
    let jwt: string;
    try {
      jwt = await this.exchange(this.token);
    } catch (e) {
      const fresh = await this.tokenLoader?.();
      if (!fresh || fresh === this.token) throw e;
      this.token = fresh;
      jwt = await this.exchange(fresh);
    }
    this.jwt = jwt;
    this.jwtAt = Date.now();
    return jwt;
  }

  private async request<T>(method: string, path: string, options: { params?: Record<string, unknown>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(options.params ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const send = async (jwt: string) =>
      this.fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${jwt}`, ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    let res = await send(await this.ensureJwt());
    if (res.status === 401) {
      this.jwt = undefined; // expired: exchange again once
      res = await send(await this.ensureJwt());
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    return (await res.json()) as T;
  }

  get = <T = Json>(path: string, params?: Record<string, unknown>) => this.request<T>("GET", path, { params });
  post = <T = Json>(path: string, body?: unknown) => this.request<T>("POST", path, { body });
  put = <T = Json>(path: string, body?: unknown) => this.request<T>("PUT", path, { body });

  /** Semantic search first; keyword/title search when that finds nothing (or the embedder is down). */
  async search(query: string, limit = 5, toolFilter?: string, days?: number): Promise<Json[]> {
    try {
      const sem = await this.get<Json>("/api/memory/semantic", { q: query, limit, tool_filter: toolFilter, days });
      if (Array.isArray(sem.results) && sem.results.length) return sem.results as Json[];
    } catch {
      // fall through to keyword search
    }
    const res = await this.get<Json>("/api/search", { q: query, limit, tool: toolFilter, days });
    return Array.isArray(res.results) ? (res.results as Json[]) : [];
  }

  /** The local day's report; the server needs the UTC offset in minutes (east negative, as in JS). */
  getDaily(date: string) {
    return this.get<Json>(`/api/daily/${date}`, { tz_offset: new Date().getTimezoneOffset() });
  }
}
