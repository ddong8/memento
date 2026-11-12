import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";

import { deviceFilePath } from "./file-path.js";

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
      const path = deviceFilePath(String(req.path ?? ""));
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

/** A pull that broke off: how much of the file had arrived, in order, before it did. */
export class DirectPullError extends Error {
  constructor(
    message: string,
    readonly written: number,
  ) {
    super(message);
  }
}

/** No byte for this long: the direct path is gone, the rest goes through the server. */
const PULL_IDLE_MS = 20_000;
const PULL_OPEN_MS = 10_000;

/**
 * The other side of P2PHost, for a device fetching a file from another device directly (a workspace
 * bundle): offers a channel, has `signal` carry the offer to the device holding the file and bring its
 * answer back (through the server: a few KB), with the file's path there when only the server knows it,
 * then reads the file over the channel in order, writing each
 * piece at its offset. Resolves with the size once all of it arrived; a pull that can't connect or
 * breaks off rejects with DirectPullError, saying how much arrived so the rest can come another way.
 */
export async function pullDirect(o: {
  path?: string;
  size: number;
  iceServers: string[];
  signal: (offerSdp: string) => Promise<{ sdp: string; path?: string }>;
  write: (data: Buffer, offset: number) => Promise<unknown>;
  log?: (message: string) => void;
}): Promise<number> {
  const nd = await loadLib(o.log ?? (() => {}));
  if (!nd) throw new DirectPullError("direct transfer is not available on this device", 0);
  let pc: PeerConnection;
  try {
    pc = new nd.PeerConnection(`memento-pull-${randomUUID().slice(0, 8)}`, { iceServers: o.iceServers });
  } catch (e) {
    throw new DirectPullError(`could not open a peer connection: ${e instanceof Error ? e.message : e}`, 0);
  }
  let written = 0;
  try {
    const gathered = new Promise<void>((resolve) => {
      pc.onGatheringStateChange((state) => {
        if (state === "complete") resolve();
      });
      setTimeout(resolve, GATHER_MS);
    });
    const dc = pc.createDataChannel("files");
    const opened = new Promise<void>((resolve, reject) => {
      dc.onOpen(() => resolve());
      dc.onError((err) => reject(new Error(err)));
      setTimeout(() => reject(new Error("no direct path to the other device")), PULL_OPEN_MS);
    });
    await gathered;
    const offer = pc.localDescription();
    if (!offer?.sdp) throw new Error("no offer was generated");
    const answer = await o.signal(offer.sdp);
    const path = answer.path || o.path;
    if (!answer.sdp || !path) throw new Error("the other device gave no answer");
    pc.setRemoteDescription(answer.sdp, "answer" as never);
    await opened;

    // One read per window (the host serves at most MAX_READ a request); frames come in order
    let id = 0;
    while (written < o.size) {
      id += 1;
      const start = written;
      const end = Math.min(o.size, start + MAX_READ) - 1;
      await new Promise<void>((resolve, reject) => {
        let writing: Promise<unknown> = Promise.resolve();
        let idle: NodeJS.Timeout;
        const touch = () => {
          clearTimeout(idle);
          idle = setTimeout(() => reject(new Error("the direct transfer stalled")), PULL_IDLE_MS);
        };
        touch();
        dc.onClosed(() => reject(new Error("the direct channel closed")));
        dc.onMessage((msg) => {
          touch();
          if (typeof msg === "string") {
            let r: { id?: number; done?: boolean; error?: string };
            try {
              r = JSON.parse(msg) as typeof r;
            } catch {
              return;
            }
            if (r.id !== id) return;
            clearTimeout(idle);
            if (r.error) reject(new Error(r.error));
            else if (r.done) void writing.then(() => resolve(), reject);
            return;
          }
          const frame = Buffer.from(msg as ArrayBuffer);
          if (frame.length < 4 || frame.readUInt32BE(0) !== id) return;
          const data = Buffer.from(frame.subarray(4));
          writing = writing.then(async () => {
            await o.write(data, written);
            written += data.length;
          });
          writing.catch((e) => reject(e as Error));
        });
        dc.sendMessage(JSON.stringify({ id, op: "read", path, start, end }));
      });
      if (written <= start) throw new Error("the other device sent nothing");
    }
    return written;
  } catch (e) {
    throw new DirectPullError(e instanceof Error ? e.message : String(e), written);
  } finally {
    try {
      pc.close();
    } catch {
      // already closed
    }
  }
}
