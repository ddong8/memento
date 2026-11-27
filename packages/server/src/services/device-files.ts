// Device file path normalization, RFC 9110 byte-range parsing, and scoped cache helpers (server/server/services/device_files.py).
import { createHash } from "node:crypto";
import { appendFile, open, stat, writeFile } from "node:fs/promises";

import { HttpError } from "../http";

export const SANDBOXED_INLINE_EXTS = new Set([".html", ".htm", ".svg", ".xhtml", ".xml", ".mhtml"]);

export function userCacheScope(user: { id?: string | null } | null | undefined): string {
  return user?.id ? String(user.id) : "anon";
}

export function diskCacheKey(userScope: string, devToken: string, cleanPath: string, totalSize: number): string {
  return createHash("sha256").update(`${userScope}:${devToken}:${cleanPath}:${totalSize}`, "utf8").digest("hex");
}

/** Parse HTTP Range header per RFC 9110. Returns [start, end, statusCode]. */
export function parseByteRange(rangeHeader: string | null | undefined, totalSize: number): [number, number, 200 | 206] {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) {
    return [0, totalSize > 0 ? totalSize - 1 : 0, 200];
  }
  const spec = rangeHeader.slice(6).trim();
  if (spec.includes(",") || !spec.includes("-")) {
    throw new HttpError(400, "Unsupported Range header");
  }
  const dash = spec.indexOf("-");
  const startS = spec.slice(0, dash).trim();
  const endS = spec.slice(dash + 1).trim();
  if (!startS && !endS) throw new HttpError(400, "Empty Range header");
  if (totalSize <= 0) {
    throw new HttpError(416, "Range not satisfiable", { "Content-Range": "bytes */0" });
  }

  let start: number;
  let end: number;
  if (!startS) {
    if (!/^[+-]?\d+$/.test(endS)) throw new HttpError(400, "Invalid Range header");
    const suffix = Number(endS);
    if (suffix <= 0) {
      throw new HttpError(416, "Range not satisfiable", { "Content-Range": `bytes */${totalSize}` });
    }
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    if (!/^[+-]?\d+$/.test(startS) || (endS && !/^[+-]?\d+$/.test(endS))) {
      throw new HttpError(400, "Invalid Range header");
    }
    start = Number(startS);
    end = endS ? Number(endS) : totalSize - 1;
  }

  if (start < 0 || end < 0 || start >= totalSize || start > end) {
    throw new HttpError(416, "Range not satisfiable", { "Content-Range": `bytes */${totalSize}` });
  }
  end = Math.min(end, totalSize - 1);
  return [start, end, 206];
}

export async function fileMatchesSize(filePath: string, expectedSize: number): Promise<boolean> {
  try {
    const st = await stat(filePath);
    return st.isFile() && st.size === expectedSize;
  } catch {
    return false;
  }
}

export async function readLocalSlice(filePath: string, offset: number, length: number): Promise<Buffer> {
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export async function appendPartChunk(partPath: string, chunk: Buffer, firstWrite: boolean): Promise<void> {
  if (firstWrite) await writeFile(partPath, chunk);
  else await appendFile(partPath, chunk);
}

export function cleanDevicePath(rawPath: string): string {
  let clean = rawPath.trim();
  for (let i = 0; i < 3; i++) {
    let unquoted = clean;
    try {
      unquoted = decodeURIComponent(clean);
    } catch {
      break;
    }
    if (unquoted === clean) break;
    clean = unquoted;
  }
  clean = clean.replaceAll("\\", "/");
  if (clean.startsWith("file://")) {
    clean = clean.slice("file://".length);
    if (clean.startsWith("/") && clean.length > 3 && clean[2] === ":") clean = clean.slice(1);
  }
  if (clean.split("/").some((p) => p === "..")) {
    throw new HttpError(400, "Path traversal forbidden");
  }
  return clean;
}
