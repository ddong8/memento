"use client";

import { useCallback, useEffect, useState } from "react";
import { getApiBase } from "@/lib/api-client";
import { desktop } from "@/lib/desktop";
import { deviceRelayUrl, fileDevice, foreignPathStyle, onThisDevice } from "@/lib/file-devices";
import { directMediaUrl, markDirectFailed, viaRelay as isRelayed } from "@/lib/p2p";

export type MediaType =
  | "video"
  | "audio"
  | "image"
  | "pdf"
  | "markdown"
  | "subtitle"
  | "presentation"
  | "spreadsheet"
  | "document"
  | "unknown";

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "mkv", "m4v", "ogv", "avi", "flv"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus", "wma"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const MARKDOWN_EXTS = new Set(["md", "markdown"]);
const SUBTITLE_EXTS = new Set(["srt", "vtt"]);
const PRESENTATION_EXTS = new Set(["pptx", "ppt", "key", "potx", "ppsx"]);
const SPREADSHEET_EXTS = new Set(["xlsx", "xls", "csv", "tsv", "ods"]);
const DOCUMENT_EXTS = new Set(["docx", "doc", "rtf", "odt", "txt", "log"]);

/** Convert SRT subtitle format to standard WebVTT format */
export function srtToVtt(srt: string): string {
  if (!srt) return "";
  const normalized = srt.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (normalized.startsWith("WEBVTT")) return normalized;
  // Replace comma in timestamps: 00:00:01,000 --> 00:00:01.000
  const vttTimestamps = normalized.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return `WEBVTT\n\n${vttTimestamps}`;
}

export interface SubtitleCue {
  id: number;
  start: number;
  end: number;
  text: string;
}

/** Parse WebVTT formatted string into structured subtitle cues */
export function parseVttCues(vtt: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  if (!vtt) return cues;
  const blocks = vtt.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  let id = 1;

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})/);
      if (match) {
        const parseSec = (h: string | undefined, m: string, s: string, ms: string) =>
          (parseInt(h || "0", 10) * 3600) + (parseInt(m, 10) * 60) + parseInt(s, 10) + (parseInt(ms, 10) / 1000);
        const start = parseSec(match[1], match[2], match[3], match[4]);
        const end = parseSec(match[5], match[6], match[7], match[8]);
        const text = lines.slice(i + 1).join(" ").replace(/<[^>]+>/g, "").trim();
        if (text) {
          cues.push({ id: id++, start, end, text });
        }
        break;
      }
    }
  }
  return cues;
}

/** Detect media type from URL or file name */
export function detectMediaType(url: string | null | undefined): MediaType {
  if (!url) return "unknown";
  try {
    const clean = url.split("?")[0].split("#")[0].replace(/\\/g, "/").toLowerCase();
    const ext = clean.split(".").pop() || "";
    if (VIDEO_EXTS.has(ext)) return "video";
    if (AUDIO_EXTS.has(ext)) return "audio";
    if (IMAGE_EXTS.has(ext)) return "image";
    if (ext === "pdf") return "pdf";
    if (PRESENTATION_EXTS.has(ext)) return "presentation";
    if (SPREADSHEET_EXTS.has(ext)) return "spreadsheet";
    if (DOCUMENT_EXTS.has(ext)) return "document";
    if (SUBTITLE_EXTS.has(ext)) return "subtitle";
    if (MARKDOWN_EXTS.has(ext) || clean.includes("/documents/") || clean.includes("/artifacts/")) return "markdown";
  } catch {
    // fallback
  }
  return "unknown";
}

/** Format seconds to mm:ss or hh:mm:ss */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/** Safely decode URI-encoded string recursively up to 3 times */
export function safeDecodePath(path: string | null | undefined): string {
  if (!path) return "";
  let decoded = path;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

/** Extract filename from URL or file path */
export function getFilenameFromUrl(url: string): string {
  try {
    const clean = safeDecodePath(url.split("?")[0].split("#")[0]).replace(/\\/g, "/");
    const name = clean.split("/").filter(Boolean).pop();
    return name || "media-file";
  } catch {
    return "media-file";
  }
}

export interface ResolvedMedia {
  playUrl: string;
  downloadUrl: string;
  localPath: string | null;
  filename: string;
  isLocal: boolean;
  /** For a file on one of the user's devices: the server relay that streams it from that device. */
  relayUrl?: string;
}

/** A pattern (`assets/memento_*.png`, `C:\\logs\\*.log`), not one file: nothing to open. */
export function hasWildcard(path: string): boolean {
  return /[*?]/.test(path.replace(/^file:\/\//, "").split(/[?#]/)[0] ?? "");
}

/**
 * Site-root paths of web pages (a fetched page's `/assets/third-parties/azure.png`, `/img/logo.svg`,
 * `/favicon.png`): pictures of that site, not files on any of the user's devices.
 */
const WEB_ASSET_ROOT = /^\/(assets|img|images|static|public|media-assets|article|uploads|wp-content|_next|favicon|apple-touch-icon|logo)[/.\-_]/i;

/** Check if a given string represents a local file path */
export function isLocalFilePath(url: string | null | undefined): boolean {
  if (!url) return false;
  const decoded = safeDecodePath(url.trim());
  if (hasWildcard(decoded)) return false;
  if (decoded.startsWith("file://")) return true;
  // Windows absolute path: e.g. C:\... or C:/...
  if (/^[a-zA-Z]:[/\\]/.test(decoded)) return true;
  // POSIX absolute path
  if (decoded.startsWith("/")) {
    if (
      decoded.startsWith("/api/") ||
      decoded.startsWith("/auth/") ||
      decoded.startsWith("/artifacts/") ||
      decoded.startsWith("/documents/") ||
      decoded.startsWith("/models/") ||
      decoded.startsWith("/icons/") ||
      decoded.startsWith("/static/") ||
      decoded.startsWith("/_next/") ||
      decoded.startsWith("/favicon")
    ) {
      return false;
    }
    if (/^\/(Users|home|private|var|tmp|Volumes|data|data\d+|mnt|root|opt|etc|Library|Applications|dev|System|usr|srv|workspace)\//i.test(decoded)) {
      return true;
    }
    if (WEB_ASSET_ROOT.test(decoded)) return false;
    const lastSlash = decoded.lastIndexOf("/");
    const lastPart = decoded.slice(lastSlash + 1);
    if (lastSlash > 0 && /\.[a-zA-Z0-9]{2,5}$/.test(lastPart)) {
      if (
        !decoded.startsWith("/artifacts/") &&
        !decoded.startsWith("/documents/") &&
        !decoded.startsWith("/notes/") &&
        !decoded.startsWith("/ask/") &&
        !decoded.startsWith("/settings/") &&
        !decoded.startsWith("/projects/") &&
        !decoded.startsWith("/dashboard/")
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * A link as written in a Markdown file, made absolute against the folder of that file (baseDir, a
 * local path). Links with a scheme, absolute paths, anchors and the article's `assets/` pictures stay as
 * they are. A relative link with no folder to resolve it against (`reply-in-chinese.md` in a MEMORY.md
 * read out in a chat) is null: it names no file anyone can open, so it is not offered as one.
 */
export function resolveRelativeLink(href: string, baseDir?: string | null): string | null {
  const raw = href.trim();
  if (!raw) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) && !/^[a-zA-Z]:[/\\]/.test(raw)) return raw; // http:, file:, mailto: …
  if (raw.startsWith("/") || raw.startsWith("#") || raw.startsWith("?") || /^[a-zA-Z]:[/\\]/.test(raw)) return raw;
  if (!baseDir && /^(?:\.\.?\/)*assets\//.test(raw)) return raw;
  if (!baseDir) return null;
  const path = safeDecodePath(raw.split("#")[0].split("?")[0]);
  if (!path) return null;
  const windows = /^[a-zA-Z]:[/\\]/.test(baseDir) || baseDir.startsWith("\\\\");
  const sep = windows ? "\\" : "/";
  const parts = baseDir.replace(/[\\/]+$/, "").split(/[\\/]/);
  for (const seg of path.split(/[\\/]/)) {
    if (seg === "..") {
      if (parts.length > 1) parts.pop();
    } else if (seg && seg !== ".") parts.push(seg);
  }
  const joined = parts.join(sep);
  return windows || joined.startsWith("/") ? joined : `/${joined}`;
}

/** The folder of a local file path. */
export function dirOfPath(path: string): string {
  const clean = safeDecodePath(path).replace(/^file:\/\//, "");
  const i = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return i > 0 ? clean.slice(0, i) : clean.slice(0, i + 1);
}

/**
 * A relayed file's URL straight from its device over WebRTC (lib/p2p) when a direct path comes up, else
 * the relay URL; null while finding out (a few seconds at most, at once when the device recently had no
 * direct path). `fail` goes back to the relay when the direct URL breaks.
 */
export function useDirectSrc(r: ResolvedMedia, enabled = true): { src: string | null; fail: () => void } {
  const relayed = enabled && isRelayed(r);
  const [got, setGot] = useState<{ for: string; url: string } | null>(null);
  useEffect(() => {
    if (!relayed) return;
    let cancelled = false;
    void directMediaUrl(r.playUrl).then((u) => {
      if (!cancelled) setGot({ for: r.playUrl, url: u ?? r.playUrl });
    });
    return () => {
      cancelled = true;
    };
  }, [relayed, r.playUrl]);
  const src = !relayed ? r.playUrl : got?.for === r.playUrl ? got.url : null;
  const fail = useCallback(() => {
    if (src && src.startsWith("/p2p/")) {
      markDirectFailed(src);
      setGot({ for: r.playUrl, url: r.playUrl });
    }
  }, [src, r.playUrl]);
  return { src, fail };
}

/** Resolve media path into a streamable/playable URL and local path */
export function resolveMediaUrl(rawUrl: string | null | undefined): ResolvedMedia {
  if (!rawUrl) {
    return { playUrl: "", downloadUrl: "", localPath: null, filename: "", isLocal: false };
  }
  const decoded = safeDecodePath(rawUrl.trim());
  const filename = getFilenameFromUrl(decoded);

  // Handle relative assets / article paths in markdown articles (e.g. assets/memento_*.png or /article/*.png)
  if (
    decoded.startsWith("assets/") ||
    decoded.startsWith("./assets/") ||
    decoded.startsWith("../assets/") ||
    decoded.startsWith("/article/")
  ) {
    const assetFilename = getFilenameFromUrl(decoded);
    const cdnUrl = `https://mem.ihasy.com/article/${encodeURIComponent(assetFilename)}`;
    return {
      playUrl: cdnUrl,
      downloadUrl: cdnUrl,
      localPath: null,
      filename: assetFilename,
      isLocal: false,
    };
  }

  if (isLocalFilePath(decoded)) {
    let clean = decoded.replace(/^file:\/\//, "");
    if (/^\/[a-zA-Z]:[/\\]/.test(clean)) {
      clean = clean.slice(1);
    }
    // From the device the file came from (the task that read or wrote it), through the server relay
    const device = fileDevice(clean);
    const token = typeof window !== "undefined" ? localStorage.getItem("dr_token") : null;
    const relayUrl = deviceRelayUrl(clean, filename, device, token);
    const d = desktop();
    if (d && typeof d.toMediaUrl === "function") {
      // In the desktop app this computer's files come straight from disk; another device's through the
      // relay. When it isn't known whose it is, the app tries its disk and falls back to the relay itself
      // (older apps can't, so they get the relay for paths that can't be this computer's).
      const here = onThisDevice(device);
      const windows = navigator.userAgent.includes("Windows");
      const mediaUrl =
        here === false || (!d.mediaFallback && here === null && foreignPathStyle(clean, windows))
          ? relayUrl
          : d.mediaFallback
            ? `${d.toMediaUrl(clean)}?remote=${encodeURIComponent(relayUrl)}`
            : d.toMediaUrl(clean);
      return {
        playUrl: mediaUrl,
        downloadUrl: mediaUrl,
        localPath: clean,
        filename,
        isLocal: true,
        relayUrl,
      };
    }
    return {
      playUrl: relayUrl,
      downloadUrl: relayUrl,
      localPath: clean,
      filename,
      isLocal: true,
      relayUrl,
    };
  }

  const trimmed = rawUrl.trim();
  if (trimmed.startsWith("/api/media/") || trimmed.startsWith("/api/studio/")) {
    let base = "";
    try {
      base = getApiBase().replace(/\/+$/, "");
    } catch {
      base = "";
    }
    const resolved = base ? `${base}${trimmed}` : trimmed;
    return {
      playUrl: resolved,
      downloadUrl: resolved,
      localPath: null,
      filename,
      isLocal: false,
    };
  }

  return {
    playUrl: trimmed,
    downloadUrl: trimmed,
    localPath: null,
    filename,
    isLocal: false,
  };
}

/* ========================================================================= */
/*                          1. Video Player Component                        */
/* ========================================================================= */

/**
 * Synchronize native MediaSession metadata and controls for iOS Dynamic Island,
 * Lock Screen widgets, macOS Now Playing, and Android notification controls.
 * Eliminates unsightly white borders by serving 100% full-bleed square artwork.
 */
