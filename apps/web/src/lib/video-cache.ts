"use client";

/**
 * Persistent client-side video cache backed by the browser Cache API + an in-memory Blob URL pool.
 *
 * Why browser HTTP cache alone is not enough for `<video>`:
 * - HTML5 `<video>` streams via `206 Partial Content` Range requests, which Chromium/Safari/Electron
 *   frequently refuse to serve from HTTP disk cache across reloads, tab switches, or `<video>` unmounts.
 * - Authenticated or signed URLs carry rotating `token` / `sig` / `exp` query params that fragment HTTP cache keys.
 *
 * Strategy:
 * 1. First play streams immediately via HTTP 206 Range (zero startup delay).
 * 2. Once playback starts (`onPlay`), `cacheVideoInBackground` quietly stores the full video response
 *    in `caches.open(CACHE_NAME)` under a normalized stable key (with ephemeral auth params stripped).
 * 3. Every subsequent play (tab switch, fullscreen portal remount, episode switch, page refresh, or
 *    re-opening in chat/inspector) hits the in-memory Blob URL pool or persistent Cache API immediately
 *    with zero network download.
 */

const CACHE_NAME = "memento-video-cache-v1";
const LRU_STORAGE_KEY = "memento_video_cache_lru_v1";
const MAX_CACHED_VIDEOS = 12;
const MAX_SINGLE_VIDEO_BYTES = 150 * 1024 * 1024; // 150 MB per video
const MAX_TOTAL_CACHE_BYTES = 400 * 1024 * 1024; // 400 MB total

const EPHEMERAL_PARAMS = new Set(["token", "sig", "exp", "_retry", "_t"]);

interface CacheLruEntry {
  key: string;
  size: number;
  at: number;
}

const blobUrlMap = new Map<string, string>();
const inflightMap = new Map<string, Promise<string | null>>();

function hasCacheApi(): boolean {
  return typeof window !== "undefined" && typeof caches !== "undefined" && typeof caches.open === "function";
}

/**
 * Derive a deterministic cache key for a remote video URL by stripping ephemeral auth/retry query params
 * (`token`, `sig`, `exp`, `_retry`, `_t`) and hash fragments while preserving stable identity/version params
 * (`v`, `path`, `task_id`, etc.). Returns null for local/non-cacheable schemes.
 */
export function videoCacheKey(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("file:") ||
    trimmed.startsWith("memento-media://")
  ) {
    return null;
  }

  try {
    const base = typeof window !== "undefined" && window.location?.origin ? window.location.origin : "https://memento.local";
    const parsed = new URL(trimmed, base);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

    const keptParams = new URLSearchParams();
    const sorted = Array.from(parsed.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [k, v] of sorted) {
      if (EPHEMERAL_PARAMS.has(k.toLowerCase())) continue;
      keptParams.append(k, v);
    }

    const qs = keptParams.toString();
    // Always store under a normalized https synthetic origin so Cache API Request keys are always valid
    return `https://memento-video-cache.local${parsed.pathname}${qs ? `?${qs}` : ""}`;
  } catch {
    return null;
  }
}

function readLru(): CacheLruEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LRU_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is CacheLruEntry =>
        item && typeof item.key === "string" && typeof item.size === "number" && typeof item.at === "number"
    );
  } catch {
    return [];
  }
}

function writeLru(entries: CacheLruEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LRU_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // ignore storage quota errors
  }
}

function touchLru(key: string, size?: number): CacheLruEntry[] {
  const now = Date.now();
  const list = readLru();
  const idx = list.findIndex((e) => e.key === key);
  if (idx >= 0) {
    const existing = list[idx];
    list[idx] = { key, size: size ?? existing.size, at: now };
  } else {
    list.push({ key, size: size ?? 0, at: now });
  }
  list.sort((a, b) => a.at - b.at);
  writeLru(list);
  return list;
}

async function pruneCache(cache: Cache, list: CacheLruEntry[]): Promise<void> {
  const sorted = [...list].sort((a, b) => a.at - b.at);
  let totalBytes = sorted.reduce((acc, item) => acc + Math.max(0, item.size), 0);
  let changed = false;

  while (sorted.length > 1 && (sorted.length > MAX_CACHED_VIDEOS || totalBytes > MAX_TOTAL_CACHE_BYTES)) {
    const victim = sorted.shift();
    if (!victim) break;
    totalBytes -= Math.max(0, victim.size);
    changed = true;
    const blobUrl = blobUrlMap.get(victim.key);
    if (blobUrl) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        // ignore
      }
      blobUrlMap.delete(victim.key);
    }
    try {
      await cache.delete(victim.key);
    } catch {
      // ignore
    }
  }

  if (changed) {
    writeLru(sorted);
  }
}

/** Synchronous hit check against the in-memory Blob URL pool (zero-flicker across tab switches & remounts). */
export function peekCachedVideoUrl(rawUrl: string | null | undefined): string | null {
  const key = videoCacheKey(rawUrl);
  if (!key) return null;
  return blobUrlMap.get(key) ?? null;
}

/** Look up a cached video in memory or persistent Cache API and return a playable `blob:` URL. */
export async function getCachedVideoUrl(rawUrl: string | null | undefined): Promise<string | null> {
  const key = videoCacheKey(rawUrl);
  if (!key) return null;

  const mem = blobUrlMap.get(key);
  if (mem) {
    touchLru(key);
    return mem;
  }

  if (!hasCacheApi()) return null;

  try {
    const cache = await caches.open(CACHE_NAME);
    const match = await cache.match(key);
    if (!match) return null;
    const blob = await match.blob();
    if (!blob || blob.size === 0) {
      await cache.delete(key);
      return null;
    }
    const url = URL.createObjectURL(blob);
    blobUrlMap.set(key, url);
    touchLru(key, blob.size);
    return url;
  } catch {
    return null;
  }
}

/**
 * Quietly download and cache the full video in the background after playback starts.
 * Deduplicates concurrent requests for the same normalized key and skips files exceeding size limits.
 */
export function cacheVideoInBackground(rawUrl: string | null | undefined): Promise<string | null> {
  const key = videoCacheKey(rawUrl);
  if (!key || !rawUrl) return Promise.resolve(null);

  const mem = blobUrlMap.get(key);
  if (mem) return Promise.resolve(mem);

  const existing = inflightMap.get(key);
  if (existing) return existing;

  if (!hasCacheApi()) return Promise.resolve(null);

  const task = (async (): Promise<string | null> => {
    try {
      const cache = await caches.open(CACHE_NAME);
      const already = await cache.match(key);
      if (already) {
        const blob = await already.blob();
        if (blob.size > 0) {
          const url = URL.createObjectURL(blob);
          blobUrlMap.set(key, url);
          touchLru(key, blob.size);
          return url;
        }
      }

      const fetchUrl = rawUrl.split("#")[0];
      const headers: Record<string, string> = {};
      try {
        const tok = localStorage.getItem("dr_token");
        if (tok && !fetchUrl.includes("token=")) {
          headers.Authorization = `Bearer ${tok}`;
        }
      } catch {
        // ignore
      }

      const res = await fetch(fetchUrl, {
        method: "GET",
        credentials: "same-origin",
        headers,
      });

      // Only cache complete 200 OK video responses (never 206 partial or error pages)
      if (!res.ok || res.status !== 200) return null;

      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("text/html") || contentType.includes("application/json")) {
        return null;
      }

      const declaredLen = Number(res.headers.get("content-length") || "0");
      if (declaredLen > MAX_SINGLE_VIDEO_BYTES) return null;

      const blob = await res.blob();
      if (!blob || blob.size === 0 || blob.size > MAX_SINGLE_VIDEO_BYTES) return null;

      const storedResponse = new Response(blob, {
        status: 200,
        headers: {
          "Content-Type": blob.type || contentType || "video/mp4",
          "Content-Length": String(blob.size),
        },
      });
      await cache.put(key, storedResponse);

      const url = URL.createObjectURL(blob);
      blobUrlMap.set(key, url);
      const updatedLru = touchLru(key, blob.size);
      await pruneCache(cache, updatedLru);
      return url;
    } catch {
      return null;
    } finally {
      inflightMap.delete(key);
    }
  })();

  inflightMap.set(key, task);
  return task;
}

/** Evict a single video entry from both memory pool and persistent Cache API (e.g. on playback error). */
export async function evictCachedVideo(rawUrl: string | null | undefined): Promise<void> {
  const key = videoCacheKey(rawUrl);
  if (!key) return;

  const blobUrl = blobUrlMap.get(key);
  if (blobUrl) {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {
      // ignore
    }
    blobUrlMap.delete(key);
  }

  writeLru(readLru().filter((e) => e.key !== key));

  if (!hasCacheApi()) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(key);
  } catch {
    // ignore
  }
}

/** Reset in-memory pools (for unit tests). */
export function _resetVideoCacheForTests(): void {
  for (const url of blobUrlMap.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
  blobUrlMap.clear();
  inflightMap.clear();
}
