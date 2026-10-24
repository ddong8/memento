/**
 * Fetches a device's files straight from it over WebRTC instead of through the server, whose public
 * entry is a few Mbps: on the same LAN that runs at LAN speed, elsewhere it connects over IPv6 or a
 * punched NAT. The server only finds the device (files/locate) and relays the offer and answer. The
 * service worker (public/sw.js) hands /p2p/media/… requests to this page, which reads the range on the
 * data channel, so <video> streams and seeks as usual. Any failure leaves the page on the stream URL.
 */
import { authFetch, getApiBase } from "./api-client";

const CONNECT_BUDGET_MS = 4000;
const SESSION_TIMEOUT_MS = 8000;
const FAILED_TTL_MS = 5 * 60_000;
const MAX_RANGE = 2 * 1024 * 1024;
const MAX_WHOLE = 32 * 1024 * 1024;

interface Pending {
  chunks: Uint8Array[];
  resolve: (bytes: Uint8Array) => void;
  reject: (e: Error) => void;
}

interface Session {
  dc: RTCDataChannel;
  nextId: number;
  pending: Map<number, Pending>;
}

interface DirectMedia {
  device: string;
  path: string;
  size: number;
  mime: string;
}

const sessions = new Map<string, Promise<Session>>();
const failedAt = new Map<string, number>();
const media = new Map<string, DirectMedia>();
let listening = false;

const MIME: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf",
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), Math.max(0, ms));
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}

/**
 * A /p2p/media/… URL serving the same file as `streamUrl` (a /api/devices/…/files/stream URL) straight
 * from the device, or null when that isn't possible here and now (no service worker in control, the
 * server has the file itself, no direct path to the device, or it failed recently).
 */
export async function directMediaUrl(streamUrl: string): Promise<string | null> {
  if (typeof window === "undefined" || typeof RTCPeerConnection === "undefined" || !navigator.serviceWorker?.controller) return null;
  let url: URL;
  try {
    url = new URL(streamUrl, window.location.href);
  } catch {
    return null;
  }
  const m = /\/api\/devices\/([^/]+)\/files\/stream(?:\/([^/?]+))?$/.exec(url.pathname);
  const path = url.searchParams.get("path");
  if (!m || !path) return null;
  const filename = decodeURIComponent(m[2] || path.split(/[\\/]/).pop() || "file");
  const deadline = Date.now() + CONNECT_BUDGET_MS;
  let device = "";
  try {
    const res = await withTimeout(
      authFetch(`${getApiBase()}/api/devices/${m[1]}/files/locate?path=${encodeURIComponent(path)}`),
      deadline - Date.now(),
    );
    if (!res.ok) return null;
    const loc = (await res.json()) as { local?: boolean; device?: string; size?: number; ice_servers?: string[] };
    if (loc.local || !loc.device || !loc.size) return null;
    device = loc.device;
    if (Date.now() - (failedAt.get(device) ?? 0) < FAILED_TTL_MS) return null;
    await withTimeout(session(device, loc.ice_servers ?? []), deadline - Date.now());
    listen();
    const key = crypto.randomUUID();
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    media.set(key, { device, path, size: loc.size, mime: MIME[ext] ?? "application/octet-stream" });
    return `/p2p/media/${key}/${encodeURIComponent(filename)}`;
  } catch {
    if (device) failedAt.set(device, Date.now());
    return null;
  }
}

/** The direct path to a device broke mid-play: don't try it again for a while. */
export function markDirectFailed(directUrl: string): void {
  const key = directUrl.split("/")[3] ?? "";
  const m = media.get(key);
  if (m) failedAt.set(m.device, Date.now());
}

function session(device: string, iceServers: string[]): Promise<Session> {
  const existing = sessions.get(device);
  if (existing) return existing;
  const p = withTimeout(connect(device, iceServers), SESSION_TIMEOUT_MS);
  sessions.set(device, p);
  p.catch(() => sessions.delete(device));
  return p;
}

async function connect(device: string, iceServers: string[]): Promise<Session> {
  const pc = new RTCPeerConnection({ iceServers: iceServers.map((urls) => ({ urls })) });
  const dc = pc.createDataChannel("files", { ordered: true });
  dc.binaryType = "arraybuffer";
  const s: Session = { dc, nextId: 1, pending: new Map() };
  const drop = () => {
    sessions.delete(device);
    for (const w of s.pending.values()) w.reject(new Error("direct connection closed"));
    s.pending.clear();
  };
  dc.onmessage = (e) => onMessage(s, e.data);
  dc.onclose = drop;
  // Don't leave a half-open connection behind when no path came up in time
  const giveUp = setTimeout(() => dc.readyState !== "open" && pc.close(), SESSION_TIMEOUT_MS);
  dc.addEventListener("open", () => clearTimeout(giveUp), { once: true });
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      drop();
      pc.close();
    }
  };
  try {
    await pc.setLocalDescription(await pc.createOffer());
    // Send every candidate at once (LAN, IPv6, STUN-mapped): one round trip through the server
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const t = setTimeout(resolve, 2500);
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") (clearTimeout(t), resolve());
      });
    });
    const res = await authFetch(`${getApiBase()}/api/devices/${encodeURIComponent(device)}/p2p/offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: pc.localDescription?.sdp ?? "" }),
    });
    if (!res.ok) throw new Error(`device declined (${res.status})`);
    const { sdp } = (await res.json()) as { sdp: string };
    await pc.setRemoteDescription({ type: "answer", sdp });
    if (dc.readyState !== "open") await new Promise<void>((resolve) => dc.addEventListener("open", () => resolve(), { once: true }));
    return s;
  } catch (e) {
    pc.close();
    throw e;
  }
}

function onMessage(s: Session, data: unknown): void {
  if (typeof data === "string") {
    let msg: { id?: number; done?: boolean; error?: string };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const w = s.pending.get(Number(msg.id));
    if (!w) return;
    s.pending.delete(Number(msg.id));
    if (msg.error) w.reject(new Error(msg.error));
    else {
      const total = w.chunks.reduce((n, c) => n + c.byteLength, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of w.chunks) (out.set(c, at), (at += c.byteLength));
      w.resolve(out);
    }
    return;
  }
  if (data instanceof ArrayBuffer && data.byteLength >= 4) {
    const id = new DataView(data).getUint32(0);
    s.pending.get(id)?.chunks.push(new Uint8Array(data, 4));
  }
}

function read(s: Session, path: string, start: number, end: number): Promise<Uint8Array> {
  const id = s.nextId++;
  return new Promise((resolve, reject) => {
    s.pending.set(id, { chunks: [], resolve, reject });
    s.dc.send(JSON.stringify({ id, op: "read", path, start, end }));
  });
}

/** Answers the service worker's reads for /p2p/media/… with bytes from the device. */
function listen(): void {
  if (listening || !navigator.serviceWorker) return;
  listening = true;
  navigator.serviceWorker.addEventListener("message", (ev: MessageEvent) => {
    const msg = ev.data as { type?: string; key?: string; range?: string } | null;
    const port = ev.ports[0];
    if (!msg || msg.type !== "memento-p2p-read" || !port) return;
    const m = media.get(msg.key ?? "");
    if (!m) return port.postMessage({ missing: true });
    serve(m, msg.range ?? "").then(
      (r) => port.postMessage(r, [r.body]),
      (e: Error) => port.postMessage({ error: e.message }),
    );
  });
  // A listener added this way only gets messages once they're started
  navigator.serviceWorker.startMessages();
}

async function serve(m: DirectMedia, range: string): Promise<{ status: number; headers: Record<string, string>; body: ArrayBuffer }> {
  const s = await sessions.get(m.device);
  if (!s) throw new Error("no direct connection");
  const r = /bytes=(\d*)-(\d*)/.exec(range);
  let start = 0;
  let end = m.size - 1;
  if (r?.[1]) {
    start = Number(r[1]);
    if (r[2]) end = Number(r[2]);
  } else if (r?.[2]) {
    start = Math.max(0, m.size - Number(r[2]));
  }
  // A whole small file in one 200; otherwise ranges of up to 2 MB, which <video> keeps asking for
  const whole = !r && m.size <= MAX_WHOLE;
  if (!whole) end = Math.min(end, start + MAX_RANGE - 1, m.size - 1);
  const bytes = await read(s, m.path, start, end);
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const headers: Record<string, string> = {
    "Content-Type": m.mime,
    "Accept-Ranges": "bytes",
    "Content-Length": String(body.byteLength),
  };
  if (whole) return { status: 200, headers, body };
  headers["Content-Range"] = `bytes ${start}-${start + body.byteLength - 1}/${m.size}`;
  return { status: 206, headers, body };
}
