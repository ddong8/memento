/**
 * Zero-Config Direct Connect Engine with Happy Eyeballs Heuristics.
 *
 * Provides fully automatic, zero-configuration high-speed direct streaming:
 * 1. Automatically gathers direct IPv6 / LAN candidate endpoints reported by online devices;
 * 2. Concurrently probes candidate endpoints using Happy Eyeballs with race timeouts;
 * 3. Automatically selects the fastest reachable path (LAN or public IPv6);
 * 4. Silently and safely falls back to standard cloud relay when in restricted networks.
 *
 * Users do not need to configure DNS, port forwarding, or domain names manually.
 */

export interface DirectConnectConfig {
  enabled: boolean;          // Whether direct connect is active (default: true)
  autoDiscovery: boolean;    // Fully automatic zero-config discovery (default: true)
  customHost?: string;       // Optional custom domain/host for advanced users
}

export type ProbeState = "untested" | "probing" | "connected" | "failed";

export interface DirectProbeResult {
  state: ProbeState;
  rttMs: number | null;
  activeEndpoint: string | null;
  candidates: string[];
  error?: string;
  checkedAt: number;
}

const STORAGE_KEY = "memento_direct_connect_cfg";
const PROBE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

class DirectConnectManager {
  private config: DirectConnectConfig = {
    enabled: true,
    autoDiscovery: true,
    customHost: "",
  };

  private probeResult: DirectProbeResult = {
    state: "untested",
    rttMs: null,
    activeEndpoint: null,
    candidates: [],
    checkedAt: 0,
  };

  private inFlightProbe: Promise<DirectProbeResult> | null = null;
  private listeners: Set<(result: DirectProbeResult) => void> = new Set();
  private discoveredFromDevices: Set<string> = new Set();

  constructor() {
    this.loadConfig();
    if (typeof window !== "undefined") {
      // Auto re-probe on network change (e.g. WiFi <-> Cellular)
      window.addEventListener("online", () => {
        this.probeResult.checkedAt = 0;
        if (this.config.enabled) {
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
          enabled: true, // Always automatically enabled in zero-config mode
          autoDiscovery: true,
          customHost: (parsed.customHost || parsed.directHost || "").trim().replace(/\/+$/, ""),
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
      customHost: (cfg.customHost !== undefined ? cfg.customHost : this.config.customHost || "").trim().replace(/\/+$/, ""),
    };
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
      } catch {}
    }
    this.probeResult.checkedAt = 0;
    this.notify();
    if (this.config.enabled) {
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
   * Automatically ingest direct candidate endpoints reported by online devices
   */
  public registerDeviceEndpoints(endpoints: string[]) {
    let changed = false;
    for (const ep of endpoints) {
      const clean = (ep || "").trim().replace(/\/+$/, "");
      if (clean && !this.discoveredFromDevices.has(clean)) {
        this.discoveredFromDevices.add(clean);
        changed = true;
      }
    }
    if (changed && this.config.enabled && this.config.autoDiscovery) {
      // Trigger probe with newly discovered endpoints
      this.probe();
    }
  }

  /**
   * Build candidate pool from:
   * 1. Manual customHost (if provided)
   * 2. Auto-discovered endpoints from online devices
   * 3. Local/LAN heuristics (e.g. current hostname on port 8001 / 8443)
   */
  public getCandidates(): string[] {
    const list: string[] = [];
    if (this.config.customHost) {
      list.push(this.config.customHost);
    }
    if (this.config.autoDiscovery) {
      for (const ep of this.discoveredFromDevices) {
        if (!list.includes(ep)) list.push(ep);
      }
      if (typeof window !== "undefined") {
        const { hostname } = window.location;
        if (hostname && hostname !== "localhost" && hostname !== "127.0.0.1" && !hostname.includes(".ihasy.com")) {
          const lanHttp = `http://${hostname}:8001`;
          if (!list.includes(lanHttp)) list.push(lanHttp);
        }
      }
    }
    return list;
  }

  /**
   * Concurrently probe candidate endpoints with Happy Eyeballs race.
   * If any candidate returns 200 within timeout, mark as connected.
   */
  public async probe(customCandidate?: string, timeoutMs = 1200): Promise<DirectProbeResult> {
    if (!this.config.enabled) {
      const res: DirectProbeResult = {
        state: "untested",
        rttMs: null,
        activeEndpoint: null,
        candidates: [],
        checkedAt: Date.now(),
      };
      this.probeResult = res;
      this.notify();
      return res;
    }

    const candidates = customCandidate ? [customCandidate] : this.getCandidates();
    if (candidates.length === 0) {
      const res: DirectProbeResult = {
        state: "untested",
        rttMs: null,
        activeEndpoint: null,
        candidates: [],
        checkedAt: Date.now(),
      };
      this.probeResult = res;
      this.notify();
      return res;
    }

    if (!customCandidate && this.inFlightProbe) {
      return this.inFlightProbe;
    }

    const now = Date.now();
    if (!customCandidate && this.probeResult.checkedAt && now - this.probeResult.checkedAt < PROBE_CACHE_TTL_MS && this.probeResult.state !== "untested") {
      return this.probeResult;
    }

    this.probeResult = {
      ...this.probeResult,
      state: "probing",
      candidates,
    };
    this.notify();

    const runProbe = async (): Promise<DirectProbeResult> => {
      // Happy Eyeballs: test all candidate endpoints concurrently
      const probePromises = candidates.map(async (candidate) => {
        const cleanHost = candidate.trim().replace(/\/+$/, "");
        const t0 = performance.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const res = await fetch(`${cleanHost}/health`, {
            method: "GET",
            signal: controller.signal,
            mode: "cors",
            cache: "no-store",
          });
          clearTimeout(timer);
          if (res.ok) {
            const rtt = Math.max(1, Math.round(performance.now() - t0));
            return { endpoint: cleanHost, rtt };
          }
        } catch {
          // ignore error for individual candidate
        } finally {
          clearTimeout(timer);
        }
        return null;
      });

      const results = await Promise.all(probePromises);
      const successful = results.filter((r): r is { endpoint: string; rtt: number } => r !== null);

      if (successful.length > 0) {
        // Sort by lowest latency
        successful.sort((a, b) => a.rtt - b.rtt);
        const best = successful[0];
        const res: DirectProbeResult = {
          state: "connected",
          rttMs: best.rtt,
          activeEndpoint: best.endpoint,
          candidates,
          checkedAt: Date.now(),
        };
        if (!customCandidate) {
          this.probeResult = res;
          this.notify();
        }
        return res;
      } else {
        const res: DirectProbeResult = {
          state: "failed",
          rttMs: null,
          activeEndpoint: null,
          candidates,
          error: "直连候选均未响应（已自动使用云端中继）",
          checkedAt: Date.now(),
        };
        if (!customCandidate) {
          this.probeResult = res;
          this.notify();
        }
        return res;
      }
    };

    if (customCandidate) {
      return runProbe();
    }

    this.inFlightProbe = runProbe().finally(() => {
      this.inFlightProbe = null;
    });
    return this.inFlightProbe;
  }

  /**
   * Automatically rewrite a media stream URL to hit the proven direct endpoint.
   * If direct connect is not connected, returns the original cloud URL unmodified.
   */
  public rewriteStreamUrl(originalUrl: string): string {
    if (!originalUrl || !this.config.enabled || this.probeResult.state !== "connected" || !this.probeResult.activeEndpoint) {
      return originalUrl;
    }

    try {
      const parsed = new URL(originalUrl, typeof window !== "undefined" ? window.location.href : "http://localhost");
      if (parsed.pathname.includes("/api/devices/") && parsed.pathname.includes("/files/stream")) {
        const directParsed = new URL(this.probeResult.activeEndpoint);
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
