/**
 * Direct Connect Engine with Happy Eyeballs Heuristics for IPv6 / LAN High-Speed Streaming.
 *
 * Automatically detects whether the client is in a network environment capable of reaching
 * the direct IPv6/LAN node. When reachable, media streams are seamlessly routed through the
 * high-bandwidth home broadband uplink; when unreachable or in an IPv4-only network, requests
 * silently fall back to the central cloud API.
 */

export interface DirectConnectConfig {
  enabled: boolean;
  directHost: string; // e.g. "https://direct.ihasy.com:8443" or "http://[240e:...]:8001"
}

export type ProbeState = "untested" | "probing" | "connected" | "failed";

export interface DirectProbeResult {
  state: ProbeState;
  rttMs: number | null;
  error?: string;
  checkedAt: number;
}

const STORAGE_KEY = "memento_direct_connect_cfg";
const PROBE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache before re-verifying

class DirectConnectManager {
  private config: DirectConnectConfig = {
    enabled: false,
    directHost: "",
  };

  private probeResult: DirectProbeResult = {
    state: "untested",
    rttMs: null,
    checkedAt: 0,
  };

  private inFlightProbe: Promise<DirectProbeResult> | null = null;
  private listeners: Set<(result: DirectProbeResult) => void> = new Set();

  constructor() {
    this.loadConfig();
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        // Network environment changed, invalidate cache and probe
        this.probeResult.checkedAt = 0;
        if (this.config.enabled && this.config.directHost) {
          this.probe();
        }
      });
    }
  }

  public loadConfig(): DirectConnectConfig {
    if (typeof window === "undefined") return this.config;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.config = {
          enabled: Boolean(parsed.enabled),
          directHost: (parsed.directHost || "").trim().replace(/\/+$/, ""),
        };
      }
    } catch {
      // ignore
    }
    return this.config;
  }

  public saveConfig(cfg: Partial<DirectConnectConfig>): DirectConnectConfig {
    this.config = {
      ...this.config,
      ...cfg,
      directHost: (cfg.directHost !== undefined ? cfg.directHost : this.config.directHost).trim().replace(/\/+$/, ""),
    };
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
      } catch {}
    }
    // Invalidate probe result on host change
    this.probeResult = {
      state: "untested",
      rttMs: null,
      checkedAt: 0,
    };
    this.notify();
    if (this.config.enabled && this.config.directHost) {
      this.probe();
    }
    return this.config;
  }

  public getConfig(): DirectConnectConfig {
    return { ...this.config };
  }

  public getStatus(): DirectProbeResult {
    return { ...this.probeResult };
  }

  public subscribe(fn: (result: DirectProbeResult) => void): () => void {
    this.listeners.add(fn);
    fn(this.getStatus());
    return () => this.listeners.delete(fn);
  }

  private notify() {
    const current = this.getStatus();
    this.listeners.forEach((fn) => {
      try {
        fn(current);
      } catch {}
    });
  }

  /**
   * Run a fast Happy Eyeballs probe against the direct node's /health or probe endpoint.
   */
  public async probe(customHost?: string, timeoutMs = 1200): Promise<DirectProbeResult> {
    const targetHost = (customHost || this.config.directHost || "").trim().replace(/\/+$/, "");
    if (!targetHost) {
      const res: DirectProbeResult = { state: "untested", rttMs: null, checkedAt: Date.now() };
      if (!customHost) {
        this.probeResult = res;
        this.notify();
      }
      return res;
    }

    if (!customHost && this.inFlightProbe) {
      return this.inFlightProbe;
    }

    const now = Date.now();
    if (!customHost && this.probeResult.checkedAt && now - this.probeResult.checkedAt < PROBE_CACHE_TTL_MS && this.probeResult.state !== "untested") {
      return this.probeResult;
    }

    if (!customHost) {
      this.probeResult = { ...this.probeResult, state: "probing" };
      this.notify();
    }

    const runProbe = async (): Promise<DirectProbeResult> => {
      const t0 = performance.now();
      const probeUrl = `${targetHost}/health`;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const res = await fetch(probeUrl, {
          method: "GET",
          signal: controller.signal,
          mode: "cors",
          cache: "no-store",
        });
        clearTimeout(timer);

        if (res.ok) {
          const rtt = Math.round(performance.now() - t0);
          const result: DirectProbeResult = {
            state: "connected",
            rttMs: Math.max(1, rtt),
            checkedAt: Date.now(),
          };
          if (!customHost) {
            this.probeResult = result;
            this.notify();
          }
          return result;
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? (err.name === "AbortError" ? "连接超时（请检查 IPv6 入站防火墙或 DDNS 解析）" : err.message) : String(err);
        const result: DirectProbeResult = {
          state: "failed",
          rttMs: null,
          error: msg,
          checkedAt: Date.now(),
        };
        if (!customHost) {
          this.probeResult = result;
          this.notify();
        }
        return result;
      } finally {
        if (!customHost) {
          this.inFlightProbe = null;
        }
      }
    };

    if (customHost) {
      return runProbe();
    }

    this.inFlightProbe = runProbe();
    return this.inFlightProbe;
  }

  /**
   * If Direct Connect is enabled and proven connected, rewrite a standard media/device stream URL
   * to directly hit the target IPv6 node host. Otherwise, returns the original cloud URL.
   */
  public rewriteStreamUrl(originalUrl: string): string {
    if (!originalUrl || !this.config.enabled || !this.config.directHost || this.probeResult.state !== "connected") {
      return originalUrl;
    }

    try {
      const parsed = new URL(originalUrl, typeof window !== "undefined" ? window.location.href : "http://localhost");
      // Only rewrite file stream or download routes
      if (parsed.pathname.includes("/api/devices/") && parsed.pathname.includes("/files/stream")) {
        const directParsed = new URL(this.config.directHost);
        parsed.protocol = directParsed.protocol;
        parsed.host = directParsed.host;
        return parsed.toString();
      }
    } catch {
      // Fallback
    }
    return originalUrl;
  }
}

export const directConnect = new DirectConnectManager();
