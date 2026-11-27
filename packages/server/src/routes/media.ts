// /api/media: S3 or local-backed images and HTTP 206 video streaming (server/server/api/media.py).
import { Hono } from "hono";

import { currentUser } from "../auth/current-user";
import type { AppEnv } from "../context";
import { HttpError, queryOptionalInt } from "../http";
import {
  getBytes,
  headVideoObject,
  mediaKey,
  mediaSignatureOk,
  readVideoRange,
  videoMediaKey,
  videoSignatureOk,
} from "../services/storage";
import { seesAll } from "../services/visibility";

export const mediaRoutes = new Hono<AppEnv>();

const SAFE_RASTER_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
]);

const SAFE_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
]);

const VIDEO_CHUNK_SIZE = 1024 * 1024; // 1 MiB

export function parseByteRange(rangeHeader: string | undefined, totalSize: number): [number, number] | null {
  if (!rangeHeader || !rangeHeader.toLowerCase().startsWith("bytes=")) return null;
  const spec = rangeHeader.slice(6).split(",", 1)[0]!.trim();
  const dash = spec.indexOf("-");
  if (dash < 0) return null;
  const sRaw = spec.slice(0, dash);
  const eRaw = spec.slice(dash + 1);
  let start: number;
  let end: number;
  if (!sRaw && eRaw) {
    if (!/^\d+$/.test(eRaw)) return null;
    const suffix = Number(eRaw);
    if (suffix <= 0) return null;
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    if (!/^\d+$/.test(sRaw)) return null;
    start = Number(sRaw);
    if (eRaw) {
      if (!/^\d+$/.test(eRaw)) return null;
      end = Number(eRaw);
    } else {
      end = totalSize - 1;
    }
  }
  if (start < 0 || start >= totalSize || end < start) return null;
  return [start, Math.min(end, totalSize - 1)];
}

function wildcardKey(path: string, prefix: string): string {
  const raw = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

mediaRoutes.get("/image/*", async (c) => {
  const { settings } = c.var.deps;
  const key = wildcardKey(c.req.path, "/api/media/image/");
  const exp = queryOptionalInt(c, "exp");
  const sig = c.req.query("sig") ?? null;

  let normalizedKey: string;
  try {
    normalizedKey = mediaKey(key);
  } catch {
    throw new HttpError(400, "Invalid image key");
  }

  if (!mediaSignatureOk(settings.secretKey, key, exp, sig)) {
    const auth = c.req.header("authorization");
    if (!auth) throw new HttpError(403, "Link expired or not signed");
    const user = await currentUser(c);
    const parts = normalizedKey.split("/");
    if (parts.length >= 4 && parts[1] === "u" && parts[2] !== user.id && !seesAll(user, settings)) {
      throw new HttpError(403, "Image access denied");
    }
  }

  const [data, contentType] = await getBytes(settings, normalizedKey);
  if (!data || !data.length) throw new HttpError(404, "Image not found");

  let resolvedType = (contentType || "image/jpeg").split(";", 1)[0]!.trim().toLowerCase();
  const headers: Record<string, string> = {
    "cache-control": "private, max-age=604800, immutable",
    "x-content-type-options": "nosniff",
  };
  if (!SAFE_RASTER_IMAGE_TYPES.has(resolvedType)) {
    headers["content-security-policy"] = "sandbox";
    resolvedType = "application/octet-stream";
  }
  headers["content-type"] = resolvedType;

  return new Response(new Uint8Array(data), { status: 200, headers });
});

mediaRoutes.get("/video/*", async (c) => {
  const { settings } = c.var.deps;
  const key = wildcardKey(c.req.path, "/api/media/video/");
  const exp = queryOptionalInt(c, "exp");
  const sig = c.req.query("sig") ?? null;
  const rangeHeader = c.req.header("range");

  let normalizedKey: string;
  try {
    normalizedKey = videoMediaKey(key);
  } catch {
    throw new HttpError(400, "Invalid video key");
  }

  if (!videoSignatureOk(settings.secretKey, key, exp, sig)) {
    const auth = c.req.header("authorization");
    if (!auth) throw new HttpError(403, "Video link expired or not signed");
    const user = await currentUser(c);
    const parts = normalizedKey.split("/");
    if (parts.length >= 4 && parts[1] === "u" && parts[2] !== user.id && !seesAll(user, settings)) {
      throw new HttpError(403, "Video access denied");
    }
  }

  const [totalSize, contentType] = await headVideoObject(settings, normalizedKey);
  if (!totalSize || totalSize <= 0) throw new HttpError(404, "Video not found");

  let resolvedType = (contentType || "video/mp4").split(";", 1)[0]!.trim().toLowerCase();
  if (!SAFE_VIDEO_TYPES.has(resolvedType)) resolvedType = "video/mp4";

  const baseHeaders: Record<string, string> = {
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=604800, immutable",
    "x-content-type-options": "nosniff",
    "content-type": resolvedType,
  };

  const parsed = parseByteRange(rangeHeader, totalSize);
  if (rangeHeader && parsed === null) {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "content-range": `bytes */${totalSize}` },
    });
  }

  const streamRange = (start: number, end: number) =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        let pos = start;
        try {
          while (pos <= end) {
            const chunkEnd = Math.min(end, pos + VIDEO_CHUNK_SIZE - 1);
            const chunk = await readVideoRange(settings, normalizedKey, pos, chunkEnd);
            if (!chunk || !chunk.length) break;
            controller.enqueue(new Uint8Array(chunk));
            pos += chunk.length;
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

  if (parsed !== null) {
    const [start, end] = parsed;
    const length = end - start + 1;
    return new Response(streamRange(start, end), {
      status: 206,
      headers: {
        ...baseHeaders,
        "content-range": `bytes ${start}-${end}/${totalSize}`,
        "content-length": String(length),
      },
    });
  }

  return new Response(streamRange(0, totalSize - 1), {
    status: 200,
    headers: {
      ...baseHeaders,
      "content-length": String(totalSize),
    },
  });
});
