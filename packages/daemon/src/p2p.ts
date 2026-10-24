import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";

/**
 * Direct file transfer to a page over WebRTC, so videos and large files on this device reach a browser
 * on the same LAN, or over IPv6 / a punched NAT, without passing through the server (whose public entry
 * is a few Mbps). The server only relays the page's offer and this answer; when no direct path exists
 * the page keeps using the server's relay.
 *
 * Requests on the data channel are JSON text:
 *   {id, op: "stat", path}              → {id, size}
 *   {id, op: "read", path, start, end}  → binary frames [u32 id, big-endian][bytes]…, then {id, done: true}
 *   {id, op: "cancel"}                  stops a read
 *   failures                            → {id, error}
 * File access is what the device already serves the user through the server (task files, media).
 */

type Lib = typeof import("node-datachannel");
type PeerConnection = InstanceType<Lib["PeerConnection"]>;
type DataChannel = ReturnType<PeerConnection["createDataChannel"]>;

const CHUNK = 64 * 1024;
const MAX_READ = 16 * 1024 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const MAX_SESSIONS = 8;
const IDLE_MS = 10 * 60_000;
const GATHER_MS = 2500;

let lib: Lib | null | undefined;

/** node-datachannel is a native module: when it isn't there (or won't load) direct transfer is off. */
async function loadLib(log: (m: string) => void): Promise<Lib | null> {
  if (lib !== undefined) return lib;
  try {
    const mod = (await import("node-datachannel")) as Lib & { default?: Lib };
    lib = mod.default ?? mod;
  } catch (e) {
    log(`Direct (WebRTC) transfer unavailable: ${e instanceof Error ? e.message : e}`);
    lib = null;
  }
  return lib;
}

interface Session {
  pc: PeerConnection;
  lastActive: number;
}

const stripFileScheme = (p: string) => p.replace(/^file:\/\//, "");

export class P2PHost {
  private readonly sessions = new Map<string, Session>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly log: (message: string) => void = () => {}) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  /** The answer to a page's offer, with every candidate gathered (LAN, IPv6, STUN-mapped). */
  async answer(offerSdp: string, iceServers: string[]): Promise<{ sdp?: string; error?: string }> {
    const nd = await loadLib(this.log);
    if (!nd) return { error: "direct transfer is not available on this device" };
    if (this.sessions.size >= MAX_SESSIONS) this.closeOldest();
    const id = randomUUID();
    let pc: PeerConnection;
    try {
      pc = new nd.PeerConnection(`memento-${id.slice(0, 8)}`, { iceServers });
    } catch (e) {
      return { error: `could not open a peer connection: ${e instanceof Error ? e.message : e}` };
    }
    const session: Session = { pc, lastActive: Date.now() };
    this.sessions.set(id, session);
    pc.onStateChange((state) => {
      if (state === "closed" || state === "failed") this.close(id);
    });
    pc.onDataChannel((dc) => this.serve(dc, session));
    const gathered = new Promise<void>((resolve) => {
      pc.onGatheringStateChange((state) => {
        if (state === "complete") resolve();
      });
      // STUN can take a while (or never answer behind some proxies): host candidates are enough on a LAN
      setTimeout(resolve, GATHER_MS);
    });
    try {
      pc.setRemoteDescription(offerSdp, "offer" as never);
    } catch (e) {
      this.close(id);
      return { error: `bad offer: ${e instanceof Error ? e.message : e}` };
    }
    await gathered;
    const local = pc.localDescription();
    if (!local?.sdp) {
      this.close(id);
      return { error: "no answer was generated" };
    }
    return { sdp: local.sdp };
  }

  dispose(): void {
    clearInterval(this.sweeper);
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  private serve(dc: DataChannel, session: Session): void {
    const cancelled = new Set<number>();
    let drained: (() => void) | null = null;
    dc.setBufferedAmountLowThreshold(HIGH_WATER / 2);
    dc.onBufferedAmountLow(() => {
      drained?.();
      drained = null;
    });
    const room = () =>
      dc.bufferedAmount() < HIGH_WATER ? Promise.resolve() : new Promise<void>((resolve) => (drained = resolve));
    const reply = (obj: Record<string, unknown>) => {
      try {
        dc.sendMessage(JSON.stringify(obj));
      } catch {
        // channel closed
      }
    };

    dc.onMessage((msg) => {
      session.lastActive = Date.now();
      if (typeof msg !== "string") return;
      let req: { id?: unknown; op?: unknown; path?: unknown; start?: unknown; end?: unknown };
      try {
        req = JSON.parse(msg) as typeof req;
      } catch {
        return;
      }
      const id = Number(req.id) >>> 0;
      if (req.op === "cancel") {
        cancelled.add(id);
        return;
      }
      const path = stripFileScheme(String(req.path ?? ""));
      if (!path) return reply({ id, error: "no path" });
      if (req.op === "stat") {
        void stat(path)
          .then((st) => (st.isFile() ? reply({ id, size: st.size }) : reply({ id, error: `not a file: ${path}` })))
          .catch((e: NodeJS.ErrnoException) => reply({ id, error: e.code === "ENOENT" ? `File not found: ${path}` : e.message }));
        return;
      }
      if (req.op !== "read") return reply({ id, error: `unknown op ${String(req.op)}` });
      const start = Math.max(0, Number(req.start) || 0);
      const end = Math.min(Number(req.end) || start, start + MAX_READ - 1);
      void (async () => {
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          handle = await open(path, "r");
          let pos = start;
          while (pos <= end && !cancelled.has(id)) {
            const len = Math.min(CHUNK, end - pos + 1);
            const frame = Buffer.allocUnsafe(4 + len);
            frame.writeUInt32BE(id, 0);
            const { bytesRead } = await handle.read(frame, 4, len, pos);
            if (bytesRead <= 0) break;
            await room();
            dc.sendMessageBinary(bytesRead === len ? frame : frame.subarray(0, 4 + bytesRead));
            pos += bytesRead;
            session.lastActive = Date.now();
          }
          reply({ id, done: true });
        } catch (e) {
          reply({ id, error: (e as NodeJS.ErrnoException).code === "ENOENT" ? `File not found: ${path}` : String((e as Error).message ?? e) });
        } finally {
          cancelled.delete(id);
          await handle?.close().catch(() => {});
        }
      })();
    });
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now - s.lastActive > IDLE_MS) this.close(id);
  }

  private closeOldest(): void {
    let oldest: [string, Session] | undefined;
    for (const entry of this.sessions) if (!oldest || entry[1].lastActive < oldest[1].lastActive) oldest = entry;
    if (oldest) this.close(oldest[0]);
  }

  private close(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    try {
      s.pc.close();
    } catch {
      // already closed
    }
  }
}
