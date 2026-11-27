// Object storage for media (images & videos): S3/MinIO or local folder (single-installer mode).
// Wire-compatible with server/server/services/storage_service.py signatures and URL formats.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, resolve } from "node:path";

import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { Settings } from "../config";

export const MEDIA_IMAGE_PREFIX = "/api/media/image/";
export const MEDIA_VIDEO_PREFIX = "/api/media/video/";
export const MEDIA_URL_PERIOD = 7 * 86400;

export function mediaUrlEpoch(now?: number): number {
  return Math.floor((now ?? Date.now() / 1000) / MEDIA_URL_PERIOD);
}

export function mediaKey(pathKey: string): string {
  const clean = pathKey.replace(/^\/+/, "");
  const parts = clean.split("/").filter(Boolean);
  if (!parts.length || parts.some((p) => p === "." || p === ".." || p.includes("\x00") || p.includes("\\"))) {
    throw new Error("Invalid media key");
  }
  const normalized = parts.join("/");
  return normalized.startsWith("images/") ? normalized : `images/${normalized}`;
}

export function videoMediaKey(pathKey: string): string {
  const clean = pathKey.replace(/^\/+/, "");
  const parts = clean.split("/").filter(Boolean);
  if (!parts.length || parts.some((p) => p === "." || p === ".." || p.includes("\x00") || p.includes("\\"))) {
    throw new Error("Invalid video media key");
  }
  const normalized = parts.join("/");
  return normalized.startsWith("videos/") ? normalized : `videos/${normalized}`;
}

function mediaSig(secretKey: string, key: string, exp: number): string {
  return createHmac("sha256", secretKey).update(`media:${key}:${exp}`).digest("hex").slice(0, 32);
}

function shareFileSig(secretKey: string, shareToken: string, deviceId: string, cleanPath: string, exp: number): string {
  return createHmac("sha256", secretKey).update(`share-file:${shareToken}:${deviceId}:${cleanPath}:${exp}`, "utf8").digest("hex").slice(0, 32);
}

function safeHexEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function signShareFileParams(
  secretKey: string,
  shareToken: string,
  deviceId: string,
  cleanPath: string,
  opts: { ttlSeconds?: number; now?: number } = {},
): [number, string] {
  const exp = Math.floor((opts.now ?? Date.now() / 1000) + Math.max(60, opts.ttlSeconds ?? MEDIA_URL_PERIOD));
  return [exp, shareFileSig(secretKey, shareToken, deviceId, cleanPath, exp)];
}

export function shareFileSignatureOk(
  secretKey: string,
  shareToken: string | null | undefined,
  deviceId: string,
  cleanPath: string,
  exp: number | null | undefined,
  sig: string | null | undefined,
  now?: number,
): boolean {
  if (!shareToken || !exp || !sig || exp < (now ?? Date.now() / 1000)) return false;
  return safeHexEqual(shareFileSig(secretKey, shareToken, deviceId, cleanPath, exp), sig);
}

export function signMediaUrl<T>(url: T, secretKey: string, now?: number): T {
  if (typeof url !== "string" || !url.startsWith(MEDIA_IMAGE_PREFIX)) return url;
  const path = url.split("?", 1)[0]!;
  const exp = (mediaUrlEpoch(now) + 2) * MEDIA_URL_PERIOD;
  const key = mediaKey(path.slice(MEDIA_IMAGE_PREFIX.length));
  return `${path}?exp=${exp}&sig=${mediaSig(secretKey, key, exp)}` as T;
}

export function mediaSignatureOk(
  secretKey: string,
  key: string,
  exp: number | null | undefined,
  sig: string | null | undefined,
  now?: number,
): boolean {
  if (!exp || !sig || exp < (now ?? Date.now() / 1000)) return false;
  let normalized: string;
  try {
    normalized = mediaKey(key);
  } catch {
    return false;
  }
  return safeHexEqual(mediaSig(secretKey, normalized, exp), sig);
}

export function signVideoUrl<T>(url: T, secretKey: string, now?: number): T {
  if (typeof url !== "string" || !url.startsWith(MEDIA_VIDEO_PREFIX)) return url;
  const path = url.split("?", 1)[0]!;
  const exp = (mediaUrlEpoch(now) + 2) * MEDIA_URL_PERIOD;
  const key = videoMediaKey(path.slice(MEDIA_VIDEO_PREFIX.length));
  return `${path}?exp=${exp}&sig=${mediaSig(secretKey, key, exp)}` as T;
}

export function videoSignatureOk(
  secretKey: string,
  key: string,
  exp: number | null | undefined,
  sig: string | null | undefined,
  now?: number,
): boolean {
  if (!exp || !sig || exp < (now ?? Date.now() / 1000)) return false;
  let normalized: string;
  try {
    normalized = videoMediaKey(key);
  } catch {
    return false;
  }
  return safeHexEqual(mediaSig(secretKey, normalized, exp), sig);
}

const VIDEO_LINK_RE = /\/api\/media\/video\/[A-Za-z0-9_.\-/]+(?:\?[^\s)"'>]*)?/g;

export function signVideoLinksInText<T>(text: T, secretKey: string, now?: number): T {
  if (typeof text !== "string" || !text.includes(MEDIA_VIDEO_PREFIX)) return text;
  return text.replace(VIDEO_LINK_RE, (raw) => {
    try {
      return signVideoUrl(raw, secretKey, now);
    } catch {
      return raw;
    }
  }) as T;
}

// ---------------------------------------------------------------------------
// S3 & local-folder storage backend
// ---------------------------------------------------------------------------

const s3Clients = new Map<string, S3Client>();
const ensuredBuckets = new Set<string>();

function getS3Client(settings: Settings): S3Client | null {
  if (settings.storageDir) return null;
  if (!settings.s3Endpoint) return null;
  const cacheKey = `${settings.s3Endpoint}|${settings.s3AccessKey}|${settings.s3SecretKey}`;
  const cached = s3Clients.get(cacheKey);
  if (cached) return cached;
  try {
    const client = new S3Client({
      endpoint: settings.s3Endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: settings.s3AccessKey,
        secretAccessKey: settings.s3SecretKey,
      },
      maxAttempts: 2,
    });
    s3Clients.set(cacheKey, client);
    return client;
  } catch {
    return null;
  }
}

async function ensureBucket(settings: Settings, client: S3Client): Promise<boolean> {
  const k = `${settings.s3Endpoint}|${settings.s3Bucket}`;
  if (ensuredBuckets.has(k)) return true;
  try {
    await client.send(new HeadBucketCommand({ Bucket: settings.s3Bucket }));
    ensuredBuckets.add(k);
    return true;
  } catch {
    try {
      await client.send(new CreateBucketCommand({ Bucket: settings.s3Bucket }));
      ensuredBuckets.add(k);
      return true;
    } catch {
      return false;
    }
  }
}

function safeResolveUnder(root: string, key: string): string | null {
  const resolvedRoot = resolve(root);
  const full = resolve(resolvedRoot, key);
  if (full !== resolvedRoot && !full.startsWith(`${resolvedRoot}/`) && !full.startsWith(`${resolvedRoot}\\`)) {
    return null;
  }
  return full;
}

async function localVideoRoot(settings: Settings): Promise<string> {
  const preferred = settings.storageDir || settings.studioLocalVideoDir;
  try {
    await mkdir(preferred, { recursive: true });
    return preferred;
  } catch {
    const fallback = resolve(tmpdir(), "memento_studio_videos");
    await mkdir(fallback, { recursive: true });
    return fallback;
  }
}

function guessMimeFromExt(key: string, fallback: string): string {
  const ext = extname(key).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".avif") return "image/avif";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".m4v") return "video/x-m4v";
  if (ext === ".mp4") return "video/mp4";
  return fallback;
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === "function") {
    return Buffer.from(await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray());
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function uploadBytes(
  settings: Settings,
  key: string,
  data: Buffer,
  contentType = "application/octet-stream",
): Promise<string | null> {
  if (settings.storageDir) {
    const dest = safeResolveUnder(settings.storageDir, key);
    if (!dest) return null;
    try {
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, data);
      await writeFile(`${dest}.ctype`, contentType, "utf8").catch(() => {});
      return key;
    } catch {
      return null;
    }
  }
  const client = getS3Client(settings);
  if (!client) return null;
  await ensureBucket(settings, client);
  try {
    await client.send(new PutObjectCommand({ Bucket: settings.s3Bucket, Key: key, Body: data, ContentType: contentType }));
    return key;
  } catch {
    return null;
  }
}

export async function getBytes(settings: Settings, key: string): Promise<[Buffer | null, string]> {
  if (settings.storageDir) {
    const dest = safeResolveUnder(settings.storageDir, key);
    if (!dest) return [null, ""];
    try {
      const data = await readFile(dest);
      const ctype = await readFile(`${dest}.ctype`, "utf8").catch(() => guessMimeFromExt(key, "application/octet-stream"));
      return [data, ctype.trim() || "application/octet-stream"];
    } catch {
      return [null, ""];
    }
  }
  const client = getS3Client(settings);
  if (!client) return [null, ""];
  try {
    const resp = await client.send(new GetObjectCommand({ Bucket: settings.s3Bucket, Key: key }));
    const data = await streamToBuffer(resp.Body);
    return [data, resp.ContentType || "application/octet-stream"];
  } catch {
    return [null, ""];
  }
}

export async function storeImageB64(settings: Settings, dataUri: string): Promise<string> {
  if (typeof dataUri !== "string" || !dataUri.startsWith("data:image")) return dataUri;
  const idx = dataUri.indexOf(",");
  if (idx < 0) return dataUri;
  try {
    const header = dataUri.slice(0, idx);
    const rawBytes = Buffer.from(dataUri.slice(idx + 1), "base64");
    let ext = "jpg";
    let contentType = "image/jpeg";
    if (header.includes("png")) {
      ext = "png";
      contentType = "image/png";
    } else if (header.includes("webp")) {
      ext = "webp";
      contentType = "image/webp";
    } else if (header.includes("gif")) {
      ext = "gif";
      contentType = "image/gif";
    }
    const h = createHash("sha256").update(rawBytes).digest("hex");
    const key = `images/${h.slice(0, 2)}/${h}.${ext}`;
    const stored = await uploadBytes(settings, key, rawBytes, contentType);
    if (stored) return `${MEDIA_IMAGE_PREFIX}${key}`;
  } catch {
    /* keep original data URI */
  }
  return dataUri;
}

export async function storeVideoBytes(
  settings: Settings,
  userId: string,
  filename: string,
  data: Buffer,
  contentType = "video/mp4",
): Promise<string> {
  let ext = extname(filename || "video.mp4").toLowerCase().replace(/^\./, "");
  if (!["mp4", "webm", "mov", "m4v"].includes(ext)) ext = "mp4";
  const safeUid = String(userId || "anon").replace(/[^A-Za-z0-9_-]/g, "") || "anon";
  const digest = createHash("sha256").update(data).digest("hex").slice(0, 24);
  const key = `videos/u/${safeUid}/${digest}.${ext}`;
  const uploaded = await uploadBytes(settings, key, data, contentType);
  if (!uploaded) {
    const root = await localVideoRoot(settings);
    const dest = safeResolveUnder(root, key);
    if (dest) {
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, data);
    }
  }
  return `${MEDIA_VIDEO_PREFIX}${key}`;
}

export async function headVideoObject(settings: Settings, key: string): Promise<[number | null, string]> {
  const normalized = videoMediaKey(key);
  const client = getS3Client(settings);
  if (client) {
    try {
      const resp = await client.send(new HeadObjectCommand({ Bucket: settings.s3Bucket, Key: normalized }));
      const size = Number(resp.ContentLength ?? 0);
      if (size > 0) return [size, resp.ContentType || "video/mp4"];
    } catch {
      /* fall back to local */
    }
  }
  const root = await localVideoRoot(settings);
  const localPath = safeResolveUnder(root, normalized);
  if (!localPath) return [null, ""];
  try {
    const st = await stat(localPath);
    if (!st.isFile()) return [null, ""];
    return [st.size, guessMimeFromExt(localPath, "video/mp4")];
  } catch {
    return [null, ""];
  }
}

export async function readVideoRange(settings: Settings, key: string, start: number, end: number): Promise<Buffer | null> {
  const normalized = videoMediaKey(key);
  const client = getS3Client(settings);
  if (client) {
    try {
      const resp = await client.send(new GetObjectCommand({ Bucket: settings.s3Bucket, Key: normalized, Range: `bytes=${start}-${end}` }));
      return await streamToBuffer(resp.Body);
    } catch {
      /* fall back to local */
    }
  }
  const root = await localVideoRoot(settings);
  const localPath = safeResolveUnder(root, normalized);
  if (!localPath) return null;
  try {
    const fh = await open(localPath, "r");
    try {
      const len = end - start + 1;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, start);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}
