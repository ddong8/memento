"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FiPlay,
  FiPause,
  FiVolume2,
  FiVolumeX,
  FiMaximize,
  FiMinimize,
  FiDownload,
  FiExternalLink,
  FiCopy,
  FiCheck,
  FiAlertCircle,
  FiMusic,
  FiVideo,
  FiImage,
  FiFileText,
  FiRotateCw,
  FiZoomIn,
  FiZoomOut,
  FiX,
  FiFolder,
  FiSidebar,
  FiShare2,
  FiSun,
  FiRepeat,
  FiRefreshCw,
  FiLayers,
  FiCamera,
  FiLock,
  FiUnlock,
  FiSearch,
  FiSliders,
} from "react-icons/fi";
import { desktop } from "@/lib/desktop";
import { showInAppToast, triggerHapticFeedback } from "@/lib/native-notify";
import { getApiBase } from "@/lib/api-client";
import { directConnect, DirectProbeResult, DirectConnectConfig } from "@/lib/direct-connect";
import { useMediaInspector } from "./MediaInspectorContext";
import { ImageViewerModal } from "./ImageViewerModal";

export { ImageViewerModal };

export type MediaType = "video" | "audio" | "image" | "pdf" | "markdown" | "subtitle" | "unknown";

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "mkv", "m4v", "ogv", "avi", "flv"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus", "wma"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const MARKDOWN_EXTS = new Set(["md", "markdown"]);
const SUBTITLE_EXTS = new Set(["srt", "vtt"]);

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
    const clean = url.split("?")[0].split("#")[0].toLowerCase();
    const ext = clean.split(".").pop() || "";
    if (VIDEO_EXTS.has(ext)) return "video";
    if (AUDIO_EXTS.has(ext)) return "audio";
    if (IMAGE_EXTS.has(ext)) return "image";
    if (ext === "pdf") return "pdf";
    if (SUBTITLE_EXTS.has(ext)) return "subtitle";
    if (MARKDOWN_EXTS.has(ext) || clean.includes("/documents/") || clean.includes("/artifacts/")) return "markdown";
  } catch {
    // fallback
  }
  return "unknown";
}

/** Format seconds to mm:ss or hh:mm:ss */
function formatTime(seconds: number): string {
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
    const clean = safeDecodePath(url.split("?")[0].split("#")[0]);
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
}

/** Check if a given string represents a local file path */
export function isLocalFilePath(url: string | null | undefined): boolean {
  if (!url) return false;
  const decoded = safeDecodePath(url.trim());
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
    if (/^\/(Users|home|private|var|tmp|Volumes|data|mnt|root|opt|etc|Library|dev|System|usr)\//i.test(decoded)) {
      return true;
    }
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

/** Resolve media path into a streamable/playable URL and local path */
export function resolveMediaUrl(rawUrl: string | null | undefined): ResolvedMedia {
  if (!rawUrl) {
    return { playUrl: "", downloadUrl: "", localPath: null, filename: "", isLocal: false };
  }
  const decoded = safeDecodePath(rawUrl.trim());
  const filename = getFilenameFromUrl(decoded);

  if (isLocalFilePath(decoded)) {
    let clean = decoded.replace(/^file:\/\//, "");
    if (typeof window !== "undefined" && navigator.userAgent.includes("Windows") && clean.startsWith("/") && clean[2] === ":") {
      clean = clean.slice(1);
    }
    const d = desktop();
    if (d && typeof d.toMediaUrl === "function") {
      const mediaUrl = d.toMediaUrl(clean);
      return {
        playUrl: mediaUrl,
        downloadUrl: mediaUrl,
        localPath: clean,
        filename,
        isLocal: true,
      };
    }
    const token = typeof window !== "undefined" ? localStorage.getItem("dr_token") : null;
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
    const apiBase = getApiBase();
    const streamUrl = `${apiBase}/api/devices/auto/files/stream/${encodeURIComponent(filename)}?path=${encodeURIComponent(clean)}${tokenParam}`;
    const finalStreamUrl = directConnect.rewriteStreamUrl(streamUrl);
    return {
      playUrl: finalStreamUrl,
      downloadUrl: finalStreamUrl,
      localPath: clean,
      filename,
      isLocal: true,
    };
  }

  return {
    playUrl: rawUrl.trim(),
    downloadUrl: rawUrl.trim(),
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
function useMediaSessionIntegration({
  mediaRef,
  title,
  poster,
  isPlaying,
  duration,
  currentTime,
  playbackRate = 1,
}: {
  mediaRef: React.RefObject<HTMLMediaElement | null>;
  title?: string;
  poster?: string | null;
  isPlaying: boolean;
  duration: number;
  currentTime: number;
  playbackRate?: number;
}) {
  // 1. Sync title, artist and full-bleed borderless artwork
  useEffect(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator)) return;

    try {
      const getAbsoluteUrl = (path: string) => {
        if (!path) return "";
        if (
          path.startsWith("http://") ||
          path.startsWith("https://") ||
          path.startsWith("blob:") ||
          path.startsWith("data:")
        ) {
          return path;
        }
        return new URL(path.startsWith("/") ? path : `/${path}`, window.location.origin).href;
      };

      const defaultArt512 = getAbsoluteUrl("/memento-artwork-512.png");
      const defaultArt192 = getAbsoluteUrl("/memento-artwork-192.png");

      const art512 = poster ? getAbsoluteUrl(poster) : defaultArt512;
      const art192 = poster ? getAbsoluteUrl(poster) : defaultArt192;

      navigator.mediaSession.metadata = new MediaMetadata({
        title: title || "Memento 媒体",
        artist: "Memento",
        album: "AI 编程记忆",
        artwork: [
          { src: art512, sizes: "512x512", type: "image/png" },
          { src: art192, sizes: "192x192", type: "image/png" },
        ],
      });
    } catch {
      // mediaSession metadata setup failed gracefully
    }
  }, [title, poster]);

  // 2. Sync playback state (playing vs paused)
  useEffect(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
    } catch {
      // ignore
    }
  }, [isPlaying]);

  // 3. Sync position state for native timeline slider on lock screen
  useEffect(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator)) return;
    if (!duration || isNaN(duration) || duration <= 0) return;

    try {
      if (typeof navigator.mediaSession.setPositionState === "function") {
        navigator.mediaSession.setPositionState({
          duration: Math.max(duration, 0),
          playbackRate: playbackRate > 0 ? playbackRate : 1,
          position: Math.min(Math.max(currentTime, 0), duration),
        });
      }
    } catch {
      // ignore
    }
  }, [currentTime, duration, playbackRate]);

  // 4. Hook native hardware and lock screen controls
  useEffect(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator)) return;

    const m = mediaRef.current;
    if (!m) return;

    const safeSetHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // unsupported action ignored
      }
    };

    safeSetHandler("play", () => {
      m.play().catch(() => {});
    });
    safeSetHandler("pause", () => {
      m.pause();
    });
    safeSetHandler("seekto", (details) => {
      if (details.seekTime !== undefined && !isNaN(details.seekTime)) {
        m.currentTime = details.seekTime;
      }
    });
    safeSetHandler("seekbackward", (details) => {
      const offset = details.seekOffset || 10;
      m.currentTime = Math.max(0, m.currentTime - offset);
    });
    safeSetHandler("seekforward", (details) => {
      const offset = details.seekOffset || 10;
      m.currentTime = Math.min(m.duration || Infinity, m.currentTime + offset);
    });

    return () => {
      safeSetHandler("play", null);
      safeSetHandler("pause", null);
      safeSetHandler("seekto", null);
      safeSetHandler("seekbackward", null);
      safeSetHandler("seekforward", null);
    };
  }, [mediaRef]);
}

export interface VideoPlayerProps {
  src: string;
  title?: string;
  poster?: string;
  downloadUrl?: string;
  autoPlay?: boolean;
  className?: string;
  subtitles?: string | string[] | Array<{ src: string; label?: string; lang?: string }>;
}

export function VideoPlayer({
  src,
  title,
  poster,
  downloadUrl,
  autoPlay = false,
  className = "",
  subtitles,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(() => {
    if (typeof window === "undefined") return 1;
    try {
      const saved = localStorage.getItem("memento_media_playback_rate");
      const parsed = saved ? parseFloat(saved) : 1;
      return parsed > 0 && parsed <= 3 ? parsed : 1;
    } catch {
      return 1;
    }
  });
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isPseudoFullscreen, setIsPseudoFullscreen] = useState<boolean>(false);
  const [isLandscapeRotated, setIsLandscapeRotated] = useState<boolean>(false);
  const effectiveFullscreen = isFullscreen || isPseudoFullscreen;
  const [showControls, setShowControls] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [hasError, setHasError] = useState<boolean>(false);
  const [bufferedProgress, setBufferedProgress] = useState<number>(0);
  const [copied, setCopied] = useState<boolean>(false);
  const [showRateMenu, setShowRateMenu] = useState<boolean>(false);
  const [quality, setQuality] = useState<"1080p" | "720p">("1080p");
  const [showQualityMenu, setShowQualityMenu] = useState<boolean>(false);
  const [vttBlobUrl, setVttBlobUrl] = useState<string | null>(null);
  const [hasSubtitles, setHasSubtitles] = useState<boolean>(false);
  const [subtitlesVisible, setSubtitlesVisible] = useState<boolean>(true);
  const [shouldPreload, setShouldPreload] = useState<boolean>(Boolean(autoPlay));
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);

  // Advanced Video Player Enhancements
  const [brightness, setBrightness] = useState<number>(1.0);
  const [fitMode, setFitMode] = useState<"contain" | "cover" | "fill">("contain");
  const [gestureOverlay, setGestureOverlay] = useState<{ type: "brightness" | "volume"; value: number } | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ time: number; x: number; percent: number } | null>(null);
  const [resumeNotice, setResumeNotice] = useState<{ pos: number } | null>(null);
  const [flashAction, setFlashAction] = useState<{ label: string; icon: string; id: number } | null>(null);
  const [isRecovering, setIsRecovering] = useState<boolean>(false);
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [abLoop, setAbLoop] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const [audioBoost, setAudioBoost] = useState<boolean>(false);
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [showTranscript, setShowTranscript] = useState<boolean>(false);
  const [transcriptSearch, setTranscriptSearch] = useState<string>("");
  const [isScreenLocked, setIsScreenLocked] = useState<boolean>(false);
  const [longPressSpeed, setLongPressSpeed] = useState<number | null>(null);
  const [filterMode, setFilterMode] = useState<"normal" | "vivid" | "warm">("normal");

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const flashTimerRef = useRef<NodeJS.Timeout | null>(null);
  const resumeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const gestureHideTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavePosTimeRef = useRef<number>(0);
  const retryCountRef = useRef<number>(0);
  const retryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const touchStartRef = useRef<{
    x: number;
    y: number;
    time: number;
    brightness: number;
    volume: number;
    mode: "none" | "vertical" | "horizontal";
  }>({ x: 0, y: 0, time: 0, brightness: 1.0, volume: 1.0, mode: "none" });

  const triggerFlashAction = useCallback((label: string, icon: string) => {
    setFlashAction({ label, icon, id: Date.now() });
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashAction(null), 500);
  }, []);

  const cycleFitMode = useCallback(() => {
    const modes: Array<"contain" | "cover" | "fill"> = ["contain", "cover", "fill"];
    setFitMode((prev) => {
      const nextIdx = (modes.indexOf(prev) + 1) % modes.length;
      const nextMode = modes[nextIdx];
      const labels = {
        contain: "适应屏幕（原比例）",
        cover: "居中裁剪铺满",
        fill: "拉伸填满全屏",
      };
      triggerFlashAction(labels[nextMode], "📐");
      return nextMode;
    });
  }, [triggerFlashAction]);

  const markPreloadActive = useCallback(() => {
    setShouldPreload(true);
  }, []);

  // Auto-discover companion subtitle file (e.g. 岁末余晖_字幕.srt or *.vtt)
  useEffect(() => {
    let canceled = false;
    let createdUrl: string | null = null;

    const probeSubtitle = async () => {
      const candidates: string[] = [];
      if (typeof subtitles === "string") {
        candidates.push(subtitles);
      } else if (Array.isArray(subtitles)) {
        for (const s of subtitles) {
          if (typeof s === "string") candidates.push(s);
          else if (s?.src) candidates.push(s.src);
        }
      }

      // Only auto-probe companion subtitle files if explicitly configured or if dealing with a clean local file path
      if (candidates.length === 0 && isLocalFilePath(src)) {
        const cleanPath = safeDecodePath(src).replace(/^file:\/\//, "");
        const baseName = cleanPath.replace(/\.[a-zA-Z0-9]+$/, "");
        candidates.push(`${baseName}_字幕.srt`, `${baseName}.vtt`, `${baseName}.srt`);
      }

      for (const cand of candidates) {
        if (canceled) break;
        try {
          const resolvedSub = resolveMediaUrl(cand);
          if (!resolvedSub.playUrl) continue;
          const res = await fetch(resolvedSub.playUrl, { method: "GET" });
          if (res.ok) {
            const rawText = await res.text();
            if (rawText && (rawText.includes("-->") || rawText.includes("WEBVTT"))) {
              const vttContent = srtToVtt(rawText);
              const blob = new Blob([vttContent], { type: "text/vtt;charset=utf-8" });
              createdUrl = URL.createObjectURL(blob);
              if (!canceled) {
                setVttBlobUrl(createdUrl);
                setSubtitleCues(parseVttCues(vttContent));
                setHasSubtitles(true);
                setSubtitlesVisible(true);
              }
              return;
            }
          }
        } catch {
          // try next
        }
      }

      if (!canceled) {
        setHasSubtitles(false);
        setSubtitleCues([]);
        setVttBlobUrl(null);
      }
    };

    probeSubtitle();

    return () => {
      canceled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [src, subtitles]);

  const [autoPoster, setAutoPoster] = useState<string | null>(null);

  // Auto-discover companion cover poster (only for local files on desktop to avoid remote probing storms)
  useEffect(() => {
    if (poster) return;
    const d = desktop();
    // Only probe local companion files in desktop client with native filesystem access
    if (!d || !isLocalFilePath(src)) return;

    let canceled = false;

    const probePoster = async () => {
      const candidates: string[] = [];
      const cleanPath = safeDecodePath(src).replace(/^file:\/\//, "");
      const baseName = cleanPath.replace(/\.[a-zA-Z0-9]+$/, "");
      candidates.push(`${baseName}.jpg`, `${baseName}_cover.jpg`, `${baseName}_封面.jpg`);

      for (const cand of candidates) {
        if (canceled) break;
        try {
          const resolvedImg = resolveMediaUrl(cand);
          if (!resolvedImg.playUrl) continue;
          const res = await fetch(resolvedImg.playUrl, { method: "HEAD" });
          if (res.ok) {
            if (!canceled) {
              setAutoPoster(resolvedImg.playUrl);
            }
            return;
          }
        } catch {
          // ignore
        }
      }
    };

    probePoster();
    return () => {
      canceled = true;
    };
  }, [src, poster]);

  // Mobile Touch Gestures: Double-tap seek, Long-press 2x speed, Vertical Swipe Brightness & Volume
  const [isLongPressing2x, setIsLongPressing2x] = useState<boolean>(false);
  const [seekFeedback, setSeekFeedback] = useState<{ text: string; direction: "left" | "right" } | null>(null);
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastTapRef = useRef<{ time: number; x: number }>({ time: 0, x: 0 });
  const seekFeedbackTimerRef = useRef<NodeJS.Timeout | null>(null);
  const originalRateBeforeLongPressRef = useRef<number>(playbackRate);

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isScreenLocked) {
      triggerFlashAction("屏幕已锁定", "🔒");
      return;
    }
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    const touchX = touch.clientX - rect.left;
    const touchY = touch.clientY - rect.top;

    touchStartRef.current = {
      x: touchX,
      y: touchY,
      time: Date.now(),
      brightness,
      volume,
      mode: "none",
    };

    const now = Date.now();
    const timeDelta = now - lastTapRef.current.time;
    const distDelta = Math.abs(touchX - lastTapRef.current.x);

    if (timeDelta < 320 && distDelta < 70) {
      // Double tap detected!
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      lastTapRef.current = { time: 0, x: 0 };

      const v = videoRef.current;
      if (!v) return;

      if (touchX < rect.width * 0.38) {
        // Rewind 5s
        v.currentTime = Math.max(0, v.currentTime - 5);
        setCurrentTime(v.currentTime);
        setSeekFeedback({ text: "-5秒", direction: "left" });
        triggerFlashAction("-5秒", "⏪");
      } else if (touchX > rect.width * 0.62) {
        // Fast forward 5s
        v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 5);
        setCurrentTime(v.currentTime);
        setSeekFeedback({ text: "+5秒", direction: "right" });
        triggerFlashAction("+5秒", "⏩");
      } else {
        // Center double tap: toggle fullscreen
        toggleFullscreen();
      }

      if (seekFeedbackTimerRef.current) clearTimeout(seekFeedbackTimerRef.current);
      seekFeedbackTimerRef.current = setTimeout(() => setSeekFeedback(null), 850);
      return;
    }

    lastTapRef.current = { time: now, x: touchX };

    // Dynamic long-press: left half 0.5x slow motion, right half 2.0x fast forward
    if (isPlaying) {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = setTimeout(() => {
        const v = videoRef.current;
        if (!v) return;
        originalRateBeforeLongPressRef.current = v.playbackRate;
        const targetRate = touchX < rect.width * 0.45 ? 0.5 : 2.0;
        v.playbackRate = targetRate;
        setLongPressSpeed(targetRate);
        setIsLongPressing2x(true);
        triggerHapticFeedback(18);
      }, 350);
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isScreenLocked) return;
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    const touchX = touch.clientX - rect.left;
    const touchY = touch.clientY - rect.top;

    const dx = touchX - touchStartRef.current.x;
    const dy = touchY - touchStartRef.current.y;

    if (touchStartRef.current.mode === "none") {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
        touchStartRef.current.mode = "vertical";
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      } else if (Math.abs(dx) > 15 && Math.abs(dx) > Math.abs(dy)) {
        touchStartRef.current.mode = "horizontal";
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      }
    }

    if (touchStartRef.current.mode === "vertical") {
      const v = videoRef.current;
      const sensitivity = rect.height * 0.85 || 300;
      const delta = (touchStartRef.current.y - touchY) / sensitivity;

      if (touchStartRef.current.x < rect.width * 0.45) {
        // Left side: Screen brightness
        const nextB = Math.max(0.3, Math.min(1.5, touchStartRef.current.brightness + delta));
        setBrightness(nextB);
        const percent = Math.round(((nextB - 0.3) / 1.2) * 100);
        setGestureOverlay({ type: "brightness", value: percent });
      } else if (touchStartRef.current.x > rect.width * 0.55 && v) {
        // Right side: Volume
        const nextV = Math.max(0, Math.min(1, touchStartRef.current.volume + delta));
        v.volume = nextV;
        setVolume(nextV);
        if (nextV === 0) {
          v.muted = true;
          setIsMuted(true);
        } else if (isMuted) {
          v.muted = false;
          setIsMuted(false);
        }
        setGestureOverlay({ type: "volume", value: Math.round(nextV * 100) });
      }
    }
  };

  const handleTouchEnd = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (isLongPressing2x) {
      const v = videoRef.current;
      if (v) {
        v.playbackRate = originalRateBeforeLongPressRef.current;
      }
      setIsLongPressing2x(false);
      setLongPressSpeed(null);
    }
    if (gestureHideTimerRef.current) clearTimeout(gestureHideTimerRef.current);
    gestureHideTimerRef.current = setTimeout(() => {
      setGestureOverlay(null);
    }, 600);
    touchStartRef.current.mode = "none";
  };

  const handleTouchCancel = handleTouchEnd;

  const inspector = useMediaInspector();
  const isPlayingInInspector = Boolean(
    inspector?.isOpen && inspector?.activeMedia && safeDecodePath(inspector.activeMedia.url) === safeDecodePath(src)
  );

  // Compute active source according to chosen quality (1080p vs 720p stream)
  const activeSrc = React.useMemo(() => {
    if (quality === "720p" && src.toLowerCase().endsWith(".mp4") && !src.toLowerCase().includes("_720p")) {
      return src.replace(/\.mp4$/i, "_720p.mp4");
    }
    return src;
  }, [src, quality]);

  const [directProbe, setDirectProbe] = useState<DirectProbeResult>(() => directConnect.getStatus());
  const [directCfg, setDirectCfg] = useState<DirectConnectConfig>(() => directConnect.getConfig());

  const [resolved, setResolved] = useState<ResolvedMedia>(() => resolveMediaUrl(activeSrc));
  useEffect(() => {
    setDirectCfg(directConnect.getConfig());
    const unsub = directConnect.subscribe((res) => {
      setDirectProbe(res);
      setResolved(resolveMediaUrl(activeSrc));
    });
    if (directConnect.getConfig().enabled && directConnect.getStatus().state === "untested") {
      directConnect.probe();
    }
    return unsub;
  }, [activeSrc]);

  useEffect(() => {
    setResolved(resolveMediaUrl(activeSrc));
    setHasError(false);
    setIsLoading(true);
  }, [activeSrc]);

  // Viewport Intersection Preload Pipeline (instant first frame playback)
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry.isIntersecting) {
          markPreloadActive();
          setShouldPreload(true);
        }
      },
      { threshold: 0.25 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [markPreloadActive]);

  const filteredCues = React.useMemo(() => {
    if (!transcriptSearch.trim()) return subtitleCues;
    const q = transcriptSearch.trim().toLowerCase();
    return subtitleCues.filter((c) => c.text.toLowerCase().includes(q));
  }, [subtitleCues, transcriptSearch]);

  const videoFilterStyle = React.useMemo(() => {
    const parts: string[] = [];
    if (brightness !== 1) parts.push(`brightness(${brightness})`);
    if (filterMode === "vivid") {
      parts.push("contrast(1.24) saturate(1.16) brightness(1.02)");
    } else if (filterMode === "warm") {
      parts.push("sepia(0.25) hue-rotate(-12deg) brightness(0.94) contrast(1.06)");
    }
    return parts.length > 0 ? parts.join(" ") : undefined;
  }, [brightness, filterMode]);

  const { playUrl, downloadUrl: resolvedDownload, localPath, filename: resolvedFilename } = resolved;
  const displayTitle = (title && title.includes(".") ? title : "") || resolvedFilename || title || "video-file";
  const finalDownloadUrl = downloadUrl || resolvedDownload || playUrl;

  let downloadFilename = displayTitle;
  const ext = resolvedFilename.split(".").pop();
  if (ext && !downloadFilename.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
    downloadFilename = `${downloadFilename}.${ext}`;
  }

  const effectivePoster = poster || autoPoster || undefined;

  const videoSrc = React.useMemo(() => {
    if (!playUrl) return "";
    if (playUrl.includes("#")) return playUrl;
    // 仅在无封面且处于 iOS WebKit 环境下追加 #t=0.001 强制首帧渲染
    // 桌面端及 Android 凭借 preload="metadata" 即可原生秒出首帧，避免引发二次 Range Seek
    const isIOS =
      typeof navigator !== "undefined" &&
      (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
    if (!effectivePoster && isIOS) {
      return `${playUrl}#t=0.001`;
    }
    return playUrl;
  }, [playUrl, effectivePoster]);

  // Native MediaSession (Now Playing / Lock Screen / Dynamic Island) Integration
  useMediaSessionIntegration({
    mediaRef: videoRef,
    title: displayTitle,
    poster: effectivePoster,
    isPlaying,
    duration,
    currentTime,
    playbackRate: longPressSpeed || playbackRate,
  });

  const hideControlsTimer = useRef<NodeJS.Timeout | null>(null);

  // Auto-hide controls during playback
  const triggerControlsActivity = useCallback(() => {
    setShowControls(true);
    if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current);
    if (isPlaying) {
      hideControlsTimer.current = setTimeout(() => {
        setShowControls(false);
        setShowRateMenu(false);
      }, 2500);
    }
  }, [isPlaying]);

  const cycleFilterMode = useCallback(() => {
    setFilterMode((prev) => {
      if (prev === "normal") {
        triggerFlashAction("代码对比度提亮", "✨");
        return "vivid";
      }
      if (prev === "vivid") {
        triggerFlashAction("夜间暖光护眼", "🌙");
        return "warm";
      }
      triggerFlashAction("标准原画色彩", "🎨");
      return "normal";
    });
    triggerControlsActivity();
  }, [triggerControlsActivity, triggerFlashAction]);

  useEffect(() => {
    return () => {
      if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current);
    };
  }, []);

  const handleVideoError = useCallback(() => {
    const v = videoRef.current;
    const currentPos = v?.currentTime || currentTime;

    if (retryCountRef.current < 3) {
      retryCountRef.current += 1;
      setIsRecovering(true);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        if (videoRef.current) {
          const baseSrc = videoSrc.replace(/([?&])_retry=\d+/, "").replace(/([?&])_t=\d+/, "");
          const sep = baseSrc.includes("?") ? "&" : "?";
          const retryUrl = `${baseSrc}${sep}_retry=${retryCountRef.current}&_t=${Date.now()}`;
          videoRef.current.src = retryUrl;
          videoRef.current.load();

          const onCanPlayOnce = () => {
            if (videoRef.current) {
              videoRef.current.currentTime = currentPos;
              videoRef.current.play().catch(() => {});
            }
            setIsRecovering(false);
            setHasError(false);
            retryCountRef.current = 0;
            videoRef.current?.removeEventListener("canplay", onCanPlayOnce);
          };
          videoRef.current.addEventListener("canplay", onCanPlayOnce, { once: true });
        }
      }, retryCountRef.current * 1000);
      return;
    }

    setIsLoading(false);
    setIsRecovering(false);
    setHasError(true);
  }, [currentTime, videoSrc]);

  const togglePlay = useCallback(() => {
    markPreloadActive();
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
      triggerFlashAction("播放", "▶");
    } else {
      v.pause();
      triggerFlashAction("暂停", "⏸");
    }
  }, [markPreloadActive, triggerFlashAction]);

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const time = Number(e.target.value);
    v.currentTime = time;
    setCurrentTime(time);
    triggerControlsActivity();
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const val = Number(e.target.value);
    v.volume = val;
    setVolume(val);
    if (val === 0) {
      v.muted = true;
      setIsMuted(true);
    } else if (isMuted) {
      v.muted = false;
      setIsMuted(false);
    }
    triggerControlsActivity();
    triggerFlashAction(`音量 ${Math.round(val * 100)}%`, val === 0 ? "🔇" : "🔊");
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setIsMuted(v.muted);
    triggerControlsActivity();
    triggerFlashAction(v.muted ? "静音" : `音量 ${Math.round(volume * 100)}%`, v.muted ? "🔇" : "🔊");
  };

  const captureFrame = useCallback(async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) return;
    try {
      setIsCapturing(true);
      const canvas = document.createElement("canvas");
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);

      canvas.toBlob(async (blob) => {
        if (!blob) return;
        const timeStr = formatTime(v.currentTime).replace(":", "-");
        const filename = `${displayTitle}_${timeStr}.png`;

        if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
          try {
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
            showInAppToast("已复制截图", `已将 ${formatTime(v.currentTime)} 原画帧复制到剪贴板`);
          } catch {
            // fallback
          }
        }

        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);

        triggerFlashAction("已截取原画帧", "📸");
        setTimeout(() => setIsCapturing(false), 300);
      }, "image/png");
    } catch (e) {
      setIsCapturing(false);
      console.warn("captureFrame failed", e);
    }
  }, [displayTitle, triggerFlashAction]);

  const stepFrame = useCallback((deltaSec: number) => {
    const v = videoRef.current;
    if (!v) return;
    if (!v.paused) v.pause();
    const target = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + deltaSec));
    v.currentTime = target;
    setCurrentTime(target);
    triggerControlsActivity();
    triggerFlashAction(`${deltaSec > 0 ? "+1帧" : "-1帧"} (${formatTime(target)})`, deltaSec > 0 ? "⏭" : "⏮");
  }, [triggerControlsActivity, triggerFlashAction]);

  const toggleAbPoint = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const cur = v.currentTime;
    setAbLoop((prev) => {
      if (prev.a === null) {
        triggerFlashAction(`已设A点: ${formatTime(cur)}`, "🅰️");
        return { a: cur, b: null };
      }
      if (prev.b === null) {
        if (cur > prev.a) {
          triggerFlashAction(`已开启 A-B 循环 (${formatTime(prev.a)} - ${formatTime(cur)})`, "🔁");
          return { a: prev.a, b: cur };
        } else {
          triggerFlashAction(`已重设A点: ${formatTime(cur)}`, "🅰️");
          return { a: cur, b: null };
        }
      }
      triggerFlashAction("已清除 A-B 循环", "⚪");
      return { a: null, b: null };
    });
    triggerControlsActivity();
  }, [triggerControlsActivity, triggerFlashAction]);

  const toggleAudioBoost = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (!audioCtxRef.current) {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          const source = ctx.createMediaElementSource(v);
          const gain = ctx.createGain();
          source.connect(gain);
          gain.connect(ctx.destination);
          audioCtxRef.current = ctx;
          gainNodeRef.current = gain;
        }
      }
      if (audioCtxRef.current?.state === "suspended") {
        audioCtxRef.current.resume();
      }
      setAudioBoost((prev) => {
        const next = !prev;
        if (gainNodeRef.current) {
          gainNodeRef.current.gain.value = next ? 2.0 : 1.0;
        }
        triggerFlashAction(next ? "音量增强 200% (人声提亮)" : "标准音量 100%", next ? "⚡" : "🔉");
        return next;
      });
    } catch (e) {
      console.warn("AudioContext boost failed", e);
    }
  }, [triggerFlashAction]);

  const handleProgressMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const percent = rect.width > 0 ? x / rect.width : 0;
    const time = (duration || 0) * percent;
    setHoverInfo({ time, x, percent });

    const canvas = previewCanvasRef.current;
    const v = videoRef.current;
    if (canvas && v && v.videoWidth && v.videoHeight) {
      try {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        }
      } catch {}
    }
  };

  const handleProgressMouseLeave = () => {
    setHoverInfo(null);
  };

  const changeRate = (rate: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = rate;
    setPlaybackRate(rate);
    try {
      localStorage.setItem("memento_media_playback_rate", String(rate));
    } catch {}
    setShowRateMenu(false);
    triggerControlsActivity();
  };

  const handleQualityChange = (newQ: "1080p" | "720p") => {
    if (newQ === quality) {
      setShowQualityMenu(false);
      return;
    }
    const cur = videoRef.current?.currentTime || 0;
    const playing = isPlaying;
    setQuality(newQ);
    setShowQualityMenu(false);
    triggerControlsActivity();
    setTimeout(() => {
      if (videoRef.current) {
        videoRef.current.currentTime = cur;
        if (playing) videoRef.current.play().catch(() => {});
      }
    }, 150);
  };

  // Sync native fullscreen changes & lock body scroll on pseudo fullscreen
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isNativeFull = Boolean(
        document.fullscreenElement ||
          (document as any).webkitFullscreenElement ||
          (document as any).mozFullScreenElement ||
          (document as any).msFullscreenElement
      );
      setIsFullscreen(isNativeFull);
      if (!isNativeFull && !isPseudoFullscreen) {
        setIsLandscapeRotated(false);
      }
    };

    const v = videoRef.current;
    const onWebkitBegin = () => setIsFullscreen(true);
    const onWebkitEnd = () => setIsFullscreen(false);

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    if (v) {
      v.addEventListener("webkitbeginfullscreen", onWebkitBegin);
      v.addEventListener("webkitendfullscreen", onWebkitEnd);
    }

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
      if (v) {
        v.removeEventListener("webkitbeginfullscreen", onWebkitBegin);
        v.removeEventListener("webkitendfullscreen", onWebkitEnd);
      }
    };
  }, [isPseudoFullscreen]);

  useEffect(() => {
    if (isPseudoFullscreen) {
      const originalOverflow = document.body.style.overflow;
      const originalTouchAction = document.body.style.touchAction;
      document.body.style.overflow = "hidden";
      document.body.style.touchAction = "none";
      return () => {
        document.body.style.overflow = originalOverflow;
        document.body.style.touchAction = originalTouchAction;
      };
    }
  }, [isPseudoFullscreen]);

  const toggleLandscapeRotation = useCallback(() => {
    triggerHapticFeedback();
    setIsLandscapeRotated((prev) => {
      const next = !prev;
      triggerFlashAction(next ? "已切换为横屏满屏" : "已切换为竖屏模式", "🔄");
      try {
        if (screen.orientation && typeof (screen.orientation as any).lock === "function") {
          if (next) {
            (screen.orientation as any).lock("landscape").catch(() => {});
          } else if (typeof (screen.orientation as any).unlock === "function") {
            (screen.orientation as any).unlock();
          }
        }
      } catch {}
      return next;
    });
  }, [triggerFlashAction]);

  const toggleFullscreen = async () => {
    triggerHapticFeedback();
    const v = videoRef.current;
    const el = containerRef.current;
    const isTouchOrMobile =
      typeof window !== "undefined" &&
      (window.innerWidth < 1024 ||
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

    // 如果当前已经是视口全屏，则退出
    if (isPseudoFullscreen) {
      setIsPseudoFullscreen(false);
      setIsLandscapeRotated(false);
      triggerFlashAction("退出全屏", "⛶");
      try {
        if (screen.orientation && typeof (screen.orientation as any).unlock === "function") {
          (screen.orientation as any).unlock();
        }
      } catch {}
      return;
    }

    // 如果已经是原生全屏，则退出
    if (document.fullscreenElement || (document as any).webkitFullscreenElement) {
      try {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if ((document as any).webkitExitFullscreen) {
          await (document as any).webkitExitFullscreen();
        }
        setIsFullscreen(false);
        setIsLandscapeRotated(false);
        triggerFlashAction("退出全屏", "⛶");
        return;
      } catch {
        // ignore
      }
    }

    // 移动端环境（iOS Safari、微信、Android WebView、PWA 等）优先进入视口伪全屏，保留全套自定义控制、字幕与横屏能力
    if (isTouchOrMobile) {
      setIsPseudoFullscreen(true);
      triggerFlashAction("全屏播放", "⛶");
      return;
    }

    // 桌面端环境优先尝试原生 Fullscreen API
    if (el) {
      try {
        if (el.requestFullscreen) {
          await el.requestFullscreen();
          setIsFullscreen(true);
          triggerFlashAction("全屏", "⛶");
          return;
        } else if ((el as any).webkitRequestFullscreen) {
          await (el as any).webkitRequestFullscreen();
          setIsFullscreen(true);
          triggerFlashAction("全屏", "⛶");
          return;
        }
      } catch (err) {
        console.warn("requestFullscreen failed, falling back to pseudo-fullscreen", err);
      }
    }

    // 降级兜底：无缝进入视口伪全屏
    setIsPseudoFullscreen(true);
    triggerFlashAction("全屏播放", "⛶");
  };

  const togglePiP = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await v.requestPictureInPicture();
      }
    } catch {
      // ignore
    }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(localPath || src);
      setCopied(true);
      showInAppToast("已复制", localPath ? "本地路径已复制到剪贴板" : "视频链接已复制到剪贴板");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleExternalOpen = async () => {
    const d = desktop();
    if (localPath && d && typeof (d as any).openPath === "function") {
      try {
        const err = await (d as any).openPath(localPath);
        if (!err) {
          showInAppToast("已在本地播放器打开", displayTitle);
          return;
        }
      } catch (e) {
        console.warn("openPath failed, falling back to openExternal", e);
      }
    }
    if (d && typeof (d as any).openExternal === "function") {
      (d as any).openExternal(finalDownloadUrl);
    } else {
      window.open(finalDownloadUrl, "_blank", "noopener,noreferrer");
    }
  };

  const handleRevealFolder = () => {
    const d = desktop();
    if (localPath && d && typeof (d as any).showItemInFolder === "function") {
      (d as any).showItemInFolder(localPath);
      showInAppToast("已在访达中显示", displayTitle);
    }
  };

  const handleShare = async () => {
    const shareUrl = finalDownloadUrl;
    if (typeof navigator !== "undefined" && typeof (navigator as any).share === "function") {
      try {
        await (navigator as any).share({
          title: displayTitle,
          text: `分享视频：${displayTitle}`,
          url: shareUrl,
        });
        return;
      } catch {
        // user cancelled or fallback
      }
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      showInAppToast("已复制分享链接", displayTitle);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  // Keyboard shortcuts when video container is active
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) {
        return;
      }

      const v = videoRef.current;
      if (!v) return;

      switch (e.key.toLowerCase()) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "arrowleft":
        case "j":
          e.preventDefault();
          v.currentTime = Math.max(0, v.currentTime - 5);
          setCurrentTime(v.currentTime);
          triggerControlsActivity();
          triggerFlashAction("-5秒", "⏪");
          break;
        case "arrowright":
        case "l":
          e.preventDefault();
          v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 5);
          setCurrentTime(v.currentTime);
          triggerControlsActivity();
          triggerFlashAction("+5秒", "⏩");
          break;
        case "arrowup": {
          e.preventDefault();
          const newVol = Math.min(1, volume + 0.1);
          v.volume = newVol;
          setVolume(newVol);
          setIsMuted(false);
          triggerControlsActivity();
          triggerFlashAction(`音量 ${Math.round(newVol * 100)}%`, "🔊");
          break;
        }
        case "arrowdown": {
          e.preventDefault();
          const newVol = Math.max(0, volume - 0.1);
          v.volume = newVol;
          setVolume(newVol);
          if (newVol === 0) setIsMuted(true);
          triggerControlsActivity();
          triggerFlashAction(`音量 ${Math.round(newVol * 100)}%`, newVol === 0 ? "🔇" : "🔊");
          break;
        }
        case "m":
          e.preventDefault();
          toggleMute();
          break;
        case "f":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "escape":
          if (isPseudoFullscreen) {
            e.preventDefault();
            toggleFullscreen();
          }
          break;
        case "c":
          if (hasSubtitles) {
            e.preventDefault();
            setSubtitlesVisible((prev) => {
              const next = !prev;
              if (v.textTracks && v.textTracks.length > 0) {
                for (let i = 0; i < v.textTracks.length; i++) {
                  v.textTracks[i].mode = next ? "showing" : "hidden";
                }
              }
              triggerFlashAction(next ? "开启字幕" : "关闭字幕", "💬");
              return next;
            });
            triggerControlsActivity();
          }
          break;
        case "s":
          e.preventDefault();
          captureFrame();
          break;
        case "[":
          e.preventDefault();
          if (v) {
            const cur = v.currentTime;
            setAbLoop((prev) => {
              triggerFlashAction(`已设A点: ${formatTime(cur)}`, "🅰️");
              return { a: cur, b: prev.b && prev.b > cur ? prev.b : null };
            });
            triggerControlsActivity();
          }
          break;
        case "]":
          e.preventDefault();
          if (v) {
            const cur = v.currentTime;
            setAbLoop((prev) => {
              if (prev.a !== null && cur > prev.a) {
                triggerFlashAction(`已开启 A-B 循环 (${formatTime(prev.a)} - ${formatTime(cur)})`, "🔁");
                return { a: prev.a, b: cur };
              }
              triggerFlashAction(`已设A点: ${formatTime(cur)}`, "🅰️");
              return { a: cur, b: null };
            });
            triggerControlsActivity();
          }
          break;
        case "\\":
          e.preventDefault();
          setAbLoop({ a: null, b: null });
          triggerFlashAction("已清除 A-B 循环", "⚪");
          triggerControlsActivity();
          break;
        case ",":
          e.preventDefault();
          stepFrame(-0.04);
          break;
        case ".":
          e.preventDefault();
          stepFrame(0.04);
          break;
        case "b":
          e.preventDefault();
          toggleAudioBoost();
          break;
        default:
          if (e.key >= "0" && e.key <= "9" && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            const pct = Number(e.key) / 10;
            if (v.duration) {
              v.currentTime = v.duration * pct;
              setCurrentTime(v.currentTime);
              triggerControlsActivity();
            }
          }
          break;
      }
    };

    container.addEventListener("keydown", handleKeyDown);
    return () => container.removeEventListener("keydown", handleKeyDown);
  }, [
    togglePlay,
    toggleMute,
    toggleFullscreen,
    volume,
    hasSubtitles,
    triggerControlsActivity,
    captureFrame,
    stepFrame,
    toggleAudioBoost,
    triggerFlashAction,
    effectiveFullscreen,
    isPseudoFullscreen,
  ]);


  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onMouseMove={triggerControlsActivity}
      onMouseEnter={markPreloadActive}
      onMouseLeave={() => isPlaying && setShowControls(false)}
      className={`relative group w-full overflow-hidden transition-all duration-300 focus:outline-none focus:ring-1 focus:ring-[var(--aurora-accent)]/50 ${
        isPseudoFullscreen
          ? "!fixed !inset-0 !z-[999999] !m-0 !w-screen !h-[100dvh] !max-w-none !max-h-none !rounded-none !border-0 bg-black flex flex-col justify-center items-center"
          : `my-4 rounded-2xl border border-[var(--aurora-border-strong)] bg-black/90 shadow-2xl ${className}`
      }`}
      style={{
        boxShadow: isPseudoFullscreen ? "none" : "0 12px 36px -8px rgba(0, 0, 0, 0.4), 0 0 0 1px var(--aurora-border-strong)",
      }}
    >
      <style
        dangerouslySetInnerHTML={{
          __html: `
            video::cue {
              background-color: rgba(0, 0, 0, 0.78);
              color: #ffffff;
              font-size: 14.5px;
              font-weight: 500;
              line-height: 1.45;
              text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
              padding: 2px 8px;
              border-radius: 4px;
            }
          `,
        }}
      />
      {/* Top Bar Overlay */}
      <div
        className={`absolute top-0 inset-x-0 z-20 flex items-center justify-between px-3 sm:px-4 py-2.5 sm:py-3 bg-gradient-to-b from-black/85 via-black/40 to-transparent transition-opacity duration-300 ${
          effectiveFullscreen ? "pt-[max(0.75rem,env(safe-area-inset-top))]" : ""
        } ${
          !isScreenLocked && (showControls || !isPlaying) ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        <div className="flex items-center gap-2 min-w-0 pr-2">
          {effectiveFullscreen && (
            <button
              type="button"
              onClick={toggleFullscreen}
              title="退出全屏 (ESC)"
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20 active:bg-white/30 text-white text-xs backdrop-blur-md transition-all shrink-0 mr-1"
            >
              <FiMinimize className="w-3.5 h-3.5" />
              <span className="text-[11px] font-medium hidden xs:inline">返回</span>
            </button>
          )}
          <span className="flex items-center justify-center w-6 h-6 rounded-lg bg-[var(--aurora-accent)]/20 text-[var(--aurora-accent)] text-xs shrink-0">
            <FiVideo className="w-3.5 h-3.5" />
          </span>
          <span className="text-xs font-medium text-white/90 truncate tracking-wide" title={displayTitle}>
            {displayTitle}
          </span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/10 text-white/60 uppercase shrink-0">
            {downloadFilename.split(".").pop() || "VIDEO"}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {localPath && (
            <button
              type="button"
              onClick={handleRevealFolder}
              title="在访达/资源管理器中定位文件"
              className="p-1.5 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors text-xs"
            >
              <FiFolder className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={captureFrame}
            title="截取当前原画帧并复制到剪贴板 (快捷键 S)"
            className="p-1.5 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors text-xs flex items-center gap-1"
          >
            <FiCamera className="w-3.5 h-3.5" />
            <span className="hidden sm:inline text-[11px]">截图</span>
          </button>
          <button
            type="button"
            onClick={handleCopyLink}
            title={copied ? "已复制" : localPath ? "复制本地文件路径" : "复制视频链接"}
            className="p-1.5 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors text-xs"
          >
            {copied ? <FiCheck className="w-3.5 h-3.5 text-emerald-400" /> : <FiCopy className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={handleShare}
            title="分享视频链接"
            className="p-1.5 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors text-xs flex items-center gap-1"
          >
            <FiShare2 className="w-3.5 h-3.5" />
            <span className="hidden sm:inline text-[11px]">分享</span>
          </button>
          {inspector && (
            <button
              type="button"
              onClick={() => inspector.openMediaByUrl(src, displayTitle)}
              title={isPlayingInInspector ? "已在右侧独立视窗播放" : "在右侧独立窗播放"}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-all ${
                isPlayingInInspector
                  ? "bg-[var(--aurora-accent)] text-white shadow-xs font-semibold"
                  : "text-white/80 hover:text-white hover:bg-white/10"
              }`}
            >
              <FiSidebar className="w-3.5 h-3.5 text-sky-300" />
              <span className="text-[11px]">独立窗</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleExternalOpen}
            title={localPath ? "在系统本地播放器打开" : "在独立窗口或系统外部打开"}
            className="p-1.5 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors text-xs"
          >
            <FiExternalLink className="w-3.5 h-3.5" />
          </button>
          {hasSubtitles && (
            <button
              type="button"
              onClick={() => {
                setShowTranscript((v) => !v);
                triggerControlsActivity();
              }}
              title={showTranscript ? "收起字幕文稿" : "展开对白文稿快速定位"}
              className={`p-1.5 rounded-lg transition-colors text-xs flex items-center gap-1 ${
                showTranscript
                  ? "bg-[var(--aurora-accent)] text-white shadow-xs font-semibold"
                  : "text-white/70 hover:text-white hover:bg-white/10"
              }`}
            >
              <FiFileText className="w-3.5 h-3.5" />
              <span className="hidden sm:inline text-[11px]">文稿</span>
            </button>
          )}
          {/* Direct Connect Speed Badge (Pure status display, no button click required) */}
          {directCfg.enabled && directProbe.state === "connected" && (
            <div
              title={`已自动命中极速直连通道 (延迟 ${directProbe.rttMs}ms，节点 ${directProbe.activeEndpoint})`}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/25 select-none"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>极速直连 {directProbe.rttMs}ms</span>
            </div>
          )}

          <a
            href={finalDownloadUrl}
            download={downloadFilename}
            target="_blank"
            rel="noopener noreferrer"
            title="下载/导出完整原片视频文件"
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--aurora-accent)] hover:bg-[var(--aurora-accent-hover,var(--aurora-accent))] text-white text-[11px] font-medium transition-all shadow-sm"
          >
            <FiDownload className="w-3 h-3" />
            <span>下载原片</span>
          </a>
        </div>
      </div>

      {/* Main Video Element */}
      <div
        className={`relative w-full flex items-center justify-center bg-black cursor-pointer select-none transition-all duration-300 ${
          effectiveFullscreen
            ? "flex-1 h-full max-h-none w-full"
            : aspectRatio && aspectRatio < 0.9
            ? "max-h-[75vh]"
            : "aspect-video"
        }`}
        style={
          isLandscapeRotated
            ? {
                transform: "rotate(90deg)",
                transformOrigin: "center center",
                width: "100dvh",
                height: "100dvw",
                maxWidth: "100dvh",
                maxHeight: "100dvw",
              }
            : effectiveFullscreen
            ? { height: "100%", width: "100%" }
            : aspectRatio && aspectRatio < 0.9
            ? { aspectRatio: `${aspectRatio}` }
            : undefined
        }
        onClick={() => {
          if (Date.now() - lastTapRef.current.time < 280) return;
          togglePlay();
        }}
        onTouchStart={(e) => {
          markPreloadActive();
          handleTouchStart(e);
        }}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
      >
        <video
          ref={videoRef}
          src={videoSrc}
          poster={effectivePoster}
          autoPlay={autoPlay}
          playsInline
          {...({ "webkit-playsinline": "true", "x-webkit-airplay": "allow" } as any)}
          preload={shouldPreload ? "auto" : "metadata"}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => {
            setIsPlaying(false);
            const posKey = `memento_vpos_${encodeURIComponent(safeDecodePath(src))}`;
            try {
              localStorage.removeItem(posKey);
            } catch {}
            setResumeNotice(null);
          }}
          onTimeUpdate={() => {
            const v = videoRef.current;
            if (!v) return;
            if (abLoop.a !== null && abLoop.b !== null && v.currentTime >= abLoop.b) {
              v.currentTime = abLoop.a;
            }
            setCurrentTime(v.currentTime);
            const now = Date.now();
            if (now - lastSavePosTimeRef.current > 2000) {
              lastSavePosTimeRef.current = now;
              const cur = v.currentTime;
              if (cur > 3 && v.duration && v.duration - cur > 5) {
                try {
                  localStorage.setItem(`memento_vpos_${encodeURIComponent(safeDecodePath(src))}`, String(Math.floor(cur)));
                } catch {}
              }
            }
          }}
          onProgress={() => {
            const v = videoRef.current;
            if (!v || !v.duration) return;
            if (v.buffered.length > 0) {
              for (let i = 0; i < v.buffered.length; i++) {
                if (v.buffered.start(i) <= v.currentTime && v.currentTime <= v.buffered.end(i)) {
                  setBufferedProgress((v.buffered.end(i) / v.duration) * 100);
                  return;
                }
              }
              setBufferedProgress((v.buffered.end(v.buffered.length - 1) / v.duration) * 100);
            }
          }}
          onLoadedMetadata={() => {
            const v = videoRef.current;
            if (v) {
              setDuration(v.duration);
              if (v.videoWidth && v.videoHeight) {
                setAspectRatio(v.videoWidth / v.videoHeight);
              }
              if (playbackRate && playbackRate !== 1) {
                v.playbackRate = playbackRate;
              }
              setIsLoading(false);
              // Resume playback check
              const posKey = `memento_vpos_${encodeURIComponent(safeDecodePath(src))}`;
              try {
                const saved = localStorage.getItem(posKey);
                if (saved) {
                  const pos = parseFloat(saved);
                  if (pos > 3 && (!v.duration || v.duration - pos > 5)) {
                    v.currentTime = pos;
                    setCurrentTime(pos);
                    setResumeNotice({ pos });
                    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
                    resumeTimerRef.current = setTimeout(() => setResumeNotice(null), 5000);
                  }
                }
              } catch {}
            }
          }}
          onCanPlay={() => {
            setIsLoading(false);
            setIsRecovering(false);
          }}
          onWaiting={() => setIsLoading(true)}
          onPlaying={() => {
            setIsLoading(false);
            setIsRecovering(false);
          }}
          onError={handleVideoError}
          className={`w-full h-full transition-all duration-300 ${
            fitMode === "cover" ? "object-cover" : fitMode === "fill" ? "object-fill" : "object-contain"
          }`}
          style={{ filter: videoFilterStyle }}
        >
          {vttBlobUrl && (
            <track
              key={vttBlobUrl}
              kind="subtitles"
              src={vttBlobUrl}
              srcLang="zh"
              label="中文字幕"
              default={subtitlesVisible}
            />
          )}
        </video>

        {/* Shutter Flash Animation for Frame Capture */}
        {isCapturing && (
          <div className="absolute inset-0 bg-white/75 pointer-events-none z-35 animate-out fade-out duration-300" />
        )}

        {/* Breakpoint Resume Notice Banner */}
        {resumeNotice && (
          <div className="absolute top-14 left-4 z-30 flex items-center gap-2 px-3 py-1.5 rounded-xl bg-black/85 border border-white/20 text-white text-xs backdrop-blur-md shadow-2xl animate-in fade-in slide-in-from-top-2 duration-300">
            <span className="text-[var(--aurora-accent)] font-medium">已自动恢复上次播放：{formatTime(resumeNotice.pos)}</span>
            <button
              type="button"
              onClick={() => {
                if (videoRef.current) {
                  videoRef.current.currentTime = 0;
                  setCurrentTime(0);
                }
                setResumeNotice(null);
                showInAppToast("已从头播放", displayTitle);
              }}
              className="px-2 py-0.5 rounded bg-white/15 hover:bg-white/25 text-white text-[11px] font-medium transition-colors"
            >
              从头播放
            </button>
            <button
              type="button"
              onClick={() => setResumeNotice(null)}
              className="p-1 text-white/60 hover:text-white transition-colors"
              title="关闭"
            >
              <FiX className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Center Flash Action Ripple Overlay */}
        {flashAction && (
          <div key={flashAction.id} className="absolute inset-0 flex items-center justify-center pointer-events-none z-30">
            <div className="flex flex-col items-center justify-center w-20 h-20 rounded-2xl bg-black/80 border border-white/20 text-white backdrop-blur-md shadow-2xl animate-in zoom-in-75 fade-in duration-200">
              <span className="text-2xl">{flashAction.icon}</span>
              <span className="text-[11px] font-medium tracking-wide mt-1 text-white/90">{flashAction.label}</span>
            </div>
          </div>
        )}

        {/* Mobile Swipe Brightness / Volume Overlay */}
        {gestureOverlay && (
          <div className="absolute top-1/2 -translate-y-1/2 pointer-events-none z-30 inset-x-0 flex items-center justify-center">
            <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-2xl bg-black/85 border border-white/20 text-white text-xs font-semibold backdrop-blur-md shadow-2xl">
              <span className="text-base">{gestureOverlay.type === "brightness" ? "☀️" : "🔊"}</span>
              <span className="text-white/80">{gestureOverlay.type === "brightness" ? "亮度" : "音量"}</span>
              <div className="w-24 h-1.5 rounded-full bg-white/20 overflow-hidden">
                <div
                  className="h-full bg-[var(--aurora-accent)] rounded-full transition-all duration-75"
                  style={{ width: `${Math.max(0, Math.min(100, gestureOverlay.value))}%` }}
                />
              </div>
              <span className="font-mono text-[11px] text-white/90 min-w-8 text-right">{gestureOverlay.value}%</span>
            </div>
          </div>
        )}

        {/* Auto Recovery / Reconnect Banner */}
        {isRecovering && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 pointer-events-none z-25 backdrop-blur-xs">
            <div className="w-9 h-9 border-3 border-[var(--aurora-accent)]/30 border-t-[var(--aurora-accent)] rounded-full animate-spin mb-2" />
            <div className="text-white text-xs font-medium">网络抖动，正在自愈恢复播放（{retryCountRef.current}/3）...</div>
          </div>
        )}

        {/* Dynamic Long Press Speed Indicator Banner (0.5x Slow / 2.0x Fast) */}
        {isLongPressing2x && (
          <div className="absolute top-4 inset-x-0 flex items-center justify-center pointer-events-none z-30">
            <div className="flex items-center gap-1.5 px-3.5 py-1 rounded-full bg-black/85 border border-amber-400/40 text-white text-xs font-semibold backdrop-blur-md shadow-2xl animate-pulse">
              <span className="text-amber-400 font-bold">
                {longPressSpeed === 0.5 ? "🐢 0.5x" : "⚡ 2.0x"}
              </span>
              <span>{longPressSpeed === 0.5 ? "长按慢放细品中" : "长按倍速播放中"}</span>
            </div>
          </div>
        )}

        {/* Double Tap Seek Feedback Ripple */}
        {seekFeedback && (
          <div
            className={`absolute top-1/2 -translate-y-1/2 pointer-events-none z-30 ${
              seekFeedback.direction === "left" ? "left-6" : "right-6"
            }`}
          >
            <div className="flex flex-col items-center justify-center w-16 h-16 rounded-full bg-black/70 border border-white/20 text-white text-xs font-bold backdrop-blur-md shadow-2xl animate-bounce">
              <span className="text-sm">{seekFeedback.direction === "left" ? "⏪" : "⏩"}</span>
              <span className="text-[11px] font-mono mt-0.5">{seekFeedback.text}</span>
            </div>
          </div>
        )}

        {/* Loading Spinner */}
        {isLoading && !hasError && !isRecovering && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none z-10 backdrop-blur-xs">
            <div className="w-10 h-10 border-3 border-[var(--aurora-accent)]/30 border-t-[var(--aurora-accent)] rounded-full animate-spin" />
          </div>
        )}

        {/* Big Center Play Button (When Paused) */}
        {!isPlaying && !isLoading && !hasError && !isRecovering && (
          <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
            <div className="w-16 h-16 rounded-full bg-white/15 backdrop-blur-md border border-white/20 flex items-center justify-center text-white shadow-2xl transition-transform group-hover:scale-110">
              <FiPlay className="w-7 h-7 ml-1 fill-white" />
            </div>
          </div>
        )}

        {/* Fallback Error Overlay */}
        {hasError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-black/90 z-10 backdrop-blur-xs">
            <FiAlertCircle className="w-12 h-12 text-amber-400 mb-3" />
            <h4 className="text-white font-medium text-sm mb-1">
              {localPath ? "当前环境无法直接硬件解码此格式" : "无法在此环境直接内嵌解码播放"}
            </h4>
            <p className="text-white/60 text-xs max-w-sm mb-4">
              {localPath
                ? `原片位于本地磁盘：${localPath}。若浏览器沙箱不支持此视频编码，您可以直接调用系统播放器无损秒播。`
                : "此格式可能受当前桌面沙箱/浏览器解码器策略限制，您可以直接下载原片并在本地媒体播放器中查看。"}
            </p>
            <div className="flex items-center gap-2.5 flex-wrap justify-center">
              {localPath && desktop() && typeof (desktop() as any).openPath === "function" && (
                <button
                  type="button"
                  onClick={handleExternalOpen}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[var(--aurora-accent)] text-white text-xs font-medium hover:opacity-90 transition-opacity shadow-sm"
                >
                  <FiPlay className="w-4 h-4 fill-white" />
                  <span>在系统播放器中打开</span>
                </button>
              )}
              {localPath && desktop() && typeof (desktop() as any).showItemInFolder === "function" && (
                <button
                  type="button"
                  onClick={handleRevealFolder}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-medium transition-colors"
                >
                  <FiFolder className="w-4 h-4" />
                  <span>在访达中定位</span>
                </button>
              )}
              <a
                href={finalDownloadUrl}
                download={downloadFilename}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-medium transition-colors"
              >
                <FiDownload className="w-4 h-4" />
                <span>下载原片</span>
              </a>
              <button
                type="button"
                onClick={handleExternalOpen}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-medium transition-colors"
              >
                <FiExternalLink className="w-4 h-4" />
                <span>系统外部打开</span>
              </button>
            </div>
          </div>
        )}

        {/* Screen Lock Toggle Button (Mobile & Touch protection) */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsScreenLocked((v) => {
              const next = !v;
              triggerHapticFeedback(next ? [20, 40, 20] : 15);
              triggerFlashAction(next ? "屏幕已锁定防误触" : "屏幕已解锁", next ? "🔒" : "🔓");
              return next;
            });
            triggerControlsActivity();
          }}
          title={isScreenLocked ? "点击解锁屏幕触控" : "点击锁定屏幕防误触"}
          className={`absolute left-3.5 top-1/2 -translate-y-1/2 z-35 p-2 rounded-full backdrop-blur-md border transition-all ${
            isScreenLocked
              ? "bg-amber-500/85 border-amber-300 text-black shadow-2xl scale-110"
              : showControls || !isPlaying
              ? "bg-black/60 border-white/20 text-white/80 hover:text-white"
              : "opacity-0 pointer-events-none"
          }`}
        >
          {isScreenLocked ? <FiLock className="w-4 h-4" /> : <FiUnlock className="w-4 h-4" />}
        </button>

        {/* Interactive Subtitles Transcript Drawer */}
        {showTranscript && hasSubtitles && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-y-0 right-0 w-80 max-w-[85%] z-35 bg-gray-950/95 border-l border-white/15 backdrop-blur-xl flex flex-col shadow-2xl animate-in slide-in-from-right duration-300"
          >
            <div className="flex items-center justify-between px-3.5 py-3 border-b border-white/10 shrink-0">
              <div className="flex items-center gap-2 text-white">
                <FiFileText className="w-4 h-4 text-[var(--aurora-accent)]" />
                <span className="text-xs font-semibold">字幕与发言速览</span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/10 text-white/60">
                  {filteredCues.length} 句
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowTranscript(false)}
                className="p-1 rounded text-white/60 hover:text-white transition-colors"
                title="关闭字幕文稿"
              >
                <FiX className="w-4 h-4" />
              </button>
            </div>

            <div className="p-2.5 border-b border-white/10 shrink-0">
              <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs">
                <FiSearch className="w-3.5 h-3.5 text-white/40 shrink-0" />
                <input
                  type="text"
                  placeholder="搜索对白关键词快速跳跃..."
                  value={transcriptSearch}
                  onChange={(e) => setTranscriptSearch(e.target.value)}
                  className="w-full bg-transparent text-white text-xs placeholder:text-white/30 focus:outline-none"
                />
                {transcriptSearch && (
                  <button
                    type="button"
                    onClick={() => setTranscriptSearch("")}
                    className="text-white/40 hover:text-white text-xs"
                  >
                    <FiX className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {filteredCues.map((cue) => {
                const isActive = currentTime >= cue.start && currentTime <= cue.end;
                return (
                  <button
                    key={cue.id}
                    type="button"
                    onClick={() => {
                      if (videoRef.current) {
                        videoRef.current.currentTime = cue.start;
                        setCurrentTime(cue.start);
                        if (videoRef.current.paused) videoRef.current.play().catch(() => {});
                      }
                      triggerControlsActivity();
                    }}
                    className={`w-full text-left p-2 rounded-lg text-xs transition-all flex flex-col gap-0.5 ${
                      isActive
                        ? "bg-[var(--aurora-accent)]/20 border border-[var(--aurora-accent)]/40 text-white shadow-xs"
                        : "hover:bg-white/5 text-white/75 hover:text-white border border-transparent"
                    }`}
                  >
                    <div className="flex items-center justify-between text-[10px] font-mono opacity-60">
                      <span>{formatTime(cue.start)}</span>
                      {isActive && <span className="text-[var(--aurora-accent)] font-bold">● 正在播放</span>}
                    </div>
                    <div className="line-clamp-2 leading-relaxed tracking-wide">{cue.text}</div>
                  </button>
                );
              })}
              {filteredCues.length === 0 && (
                <div className="py-8 text-center text-xs text-white/40">无匹配字幕内容</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Floating Controls */}
      <div
        className={`absolute bottom-0 inset-x-0 z-20 px-3 sm:px-4 py-2.5 sm:py-3 bg-gradient-to-t from-black/90 via-black/50 to-transparent transition-opacity duration-300 ${
          effectiveFullscreen ? "pb-[max(0.75rem,env(safe-area-inset-bottom))]" : ""
        } ${
          !isScreenLocked && (showControls || !isPlaying) ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        {/* Progress Bar Slider with Network Buffered Range & Hover Time */}
        <div
          className="relative flex items-center group/progress mb-2 cursor-pointer h-3"
          onMouseMove={handleProgressMouseMove}
          onMouseLeave={handleProgressMouseLeave}
        >
          {/* Hover Time Bubble with Canvas Preview */}
          {hoverInfo && duration > 0 && (
            <div
              className="absolute bottom-full mb-2 z-30 pointer-events-none -translate-x-1/2 flex flex-col items-center transition-all duration-75"
              style={{ left: hoverInfo.x }}
            >
              <div className="p-1 rounded-lg bg-black/95 border border-white/25 shadow-2xl backdrop-blur-md flex flex-col items-center">
                <canvas
                  ref={previewCanvasRef}
                  width={128}
                  height={72}
                  className="rounded bg-black/60 object-cover w-32 h-[72px] mb-1"
                />
                <span className="text-[11px] font-mono text-white/90 whitespace-nowrap px-1">
                  {formatTime(hoverInfo.time)}
                </span>
              </div>
              <div className="w-1.5 h-1.5 bg-black/95 rotate-45 border-r border-b border-white/25 -mt-1" />
            </div>
          )}

          {/* Dual Layer Track: Background + Network Buffered + Current Played + A-B Loop */}
          <div className="absolute inset-x-0 h-1.5 group-hover/progress:h-2 rounded-full bg-white/15 overflow-hidden transition-all pointer-events-none">
            {/* Network Buffered Track (浅白指示网络流已缓冲段) */}
            <div
              className="absolute left-0 top-0 bottom-0 bg-white/30 rounded-full transition-all duration-200"
              style={{ width: `${Math.min(100, Math.max(0, bufferedProgress))}%` }}
              title={`网络已缓冲: ${Math.round(bufferedProgress)}%`}
            />
            {/* Current Played Track (主题色高亮已播段) */}
            <div
              className="absolute left-0 top-0 bottom-0 bg-[var(--aurora-accent)] rounded-full transition-all"
              style={{ width: `${(currentTime / (duration || 1)) * 100}%` }}
            />
            {/* A-B Loop Highlight Range */}
            {duration > 0 && abLoop.a !== null && (
              <div
                className="absolute top-0 bottom-0 bg-amber-400/50 rounded-xs transition-all"
                style={{
                  left: `${(abLoop.a / duration) * 100}%`,
                  width: `${(Math.max(0, (abLoop.b ?? currentTime) - abLoop.a) / duration) * 100}%`,
                }}
              />
            )}
          </div>
          {/* A & B Markers */}
          {duration > 0 && abLoop.a !== null && (
            <div
              className="absolute top-1/2 -translate-y-1/2 w-1.5 h-3 bg-amber-400 rounded-xs pointer-events-none z-15 shadow-sm"
              style={{ left: `${(abLoop.a / duration) * 100}%` }}
              title={`A点: ${formatTime(abLoop.a)}`}
            />
          )}
          {duration > 0 && abLoop.b !== null && (
            <div
              className="absolute top-1/2 -translate-y-1/2 w-1.5 h-3 bg-amber-400 rounded-xs pointer-events-none z-15 shadow-sm"
              style={{ left: `${(abLoop.b / duration) * 100}%` }}
              title={`B点: ${formatTime(abLoop.b)}`}
            />
          )}
          <input
            type="range"
            min={0}
            max={duration || 100}
            step={0.1}
            value={currentTime}
            onChange={handleSeek}
            className="relative z-10 w-full h-1.5 group-hover/progress:h-2 appearance-none bg-transparent accent-[var(--aurora-accent)] cursor-pointer"
          />
        </div>

        {/* Buttons Row */}
        <div className="flex items-center justify-between text-white/90">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={togglePlay}
              className="p-1.5 rounded-lg text-white hover:text-[var(--aurora-accent)] hover:bg-white/10 transition-colors"
              title={isPlaying ? "暂停 (空格/K)" : "播放 (空格/K)"}
            >
              {isPlaying ? <FiPause className="w-4 h-4" /> : <FiPlay className="w-4 h-4" />}
            </button>

            {/* Frame Stepping */}
            <div className="hidden sm:flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => stepFrame(-0.04)}
                className="px-1.5 py-0.5 rounded text-[11px] font-mono text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                title="后退一帧 (快捷键 ,)"
              >
                -1帧
              </button>
              <button
                type="button"
                onClick={() => stepFrame(0.04)}
                className="px-1.5 py-0.5 rounded text-[11px] font-mono text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                title="前进一帧 (快捷键 .)"
              >
                +1帧
              </button>
            </div>

            {/* Volume Control & Audio Boost */}
            <div className="flex items-center gap-1.5 group/vol">
              <button
                type="button"
                onClick={toggleMute}
                className="p-1 rounded text-white/80 hover:text-white hover:bg-white/10 transition-colors"
                title={isMuted ? "取消静音 (M)" : "静音 (M)"}
              >
                {isMuted || volume === 0 ? <FiVolumeX className="w-4 h-4" /> : <FiVolume2 className="w-4 h-4" />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                className="w-14 h-1 rounded-lg appearance-none bg-white/30 accent-[var(--aurora-accent)] cursor-pointer"
              />
              <button
                type="button"
                onClick={toggleAudioBoost}
                title={audioBoost ? "关闭 200% 人声音量增强 (快捷键 B)" : "开启 200% 音量与人声清晰度增强 (快捷键 B)"}
                className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold tracking-tight transition-all ${
                  audioBoost
                    ? "bg-amber-400 text-black shadow-xs ring-1 ring-amber-300"
                    : "text-white/50 hover:text-white/90 hover:bg-white/10"
                }`}
              >
                {audioBoost ? "200%" : "BOOST"}
              </button>
            </div>

            {/* Time Stamp */}
            <div className="text-[11px] font-mono text-white/70 tracking-tight">
              <span>{formatTime(currentTime)}</span>
              <span className="mx-1 text-white/40">/</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs">
            {/* Quality Selector (弱网/3M公网可快速切720P流畅流) */}
            {src.toLowerCase().endsWith(".mp4") && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setShowQualityMenu((v) => !v);
                    setShowRateMenu(false);
                  }}
                  className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white/90 text-[11px] font-medium transition-colors flex items-center gap-1"
                  title="切换清晰度（公网3M主机或弱网环境建议切换至720P秒开）"
                >
                  <span>{quality === "1080p" ? "原画" : "流畅"}</span>
                  <span className="text-[9px] opacity-70 font-mono uppercase">{quality}</span>
                </button>
                {showQualityMenu && (
                  <div className="absolute bottom-full mb-1.5 right-0 py-1 rounded-xl bg-gray-950/95 border border-white/15 backdrop-blur-md shadow-2xl flex flex-col min-w-32 z-30">
                    <button
                      type="button"
                      onClick={() => handleQualityChange("1080p")}
                      className={`px-3 py-1.5 text-left text-xs hover:bg-[var(--aurora-accent)]/20 transition-colors flex items-center justify-between gap-2 ${
                        quality === "1080p" ? "text-[var(--aurora-accent)] font-semibold" : "text-white/80"
                      }`}
                    >
                      <span>1080P 原画</span>
                      <span className="text-[10px] opacity-60">内网/高速</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleQualityChange("720p")}
                      className={`px-3 py-1.5 text-left text-xs hover:bg-[var(--aurora-accent)]/20 transition-colors flex items-center justify-between gap-2 ${
                        quality === "720p" ? "text-[var(--aurora-accent)] font-semibold" : "text-white/80"
                      }`}
                    >
                      <span>720P 流畅</span>
                      <span className="text-[10px] text-emerald-400 font-mono">3M秒开</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Speed Selector */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowRateMenu((v) => !v)}
                className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white/90 text-[11px] font-mono transition-colors"
              >
                {playbackRate}x
              </button>
              {showRateMenu && (
                <div className="absolute bottom-full mb-1.5 right-0 py-1 rounded-xl bg-gray-950/95 border border-white/15 backdrop-blur-md shadow-2xl flex flex-col min-w-18 z-30">
                  {[0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => changeRate(r)}
                      className={`px-3 py-1 text-left text-xs hover:bg-[var(--aurora-accent)]/20 transition-colors ${
                        playbackRate === r ? "text-[var(--aurora-accent)] font-semibold" : "text-white/80"
                      }`}
                    >
                      {r}x
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Subtitle CC Button */}
            {hasSubtitles && (
              <button
                type="button"
                onClick={() => {
                  setSubtitlesVisible((v) => {
                    const next = !v;
                    const el = videoRef.current;
                    if (el && el.textTracks && el.textTracks.length > 0) {
                      for (let i = 0; i < el.textTracks.length; i++) {
                        el.textTracks[i].mode = next ? "showing" : "hidden";
                      }
                    }
                    return next;
                  });
                  triggerControlsActivity();
                }}
                title={subtitlesVisible ? "关闭字幕" : "开启中文字幕 (CC)"}
                className={`px-2 py-0.5 rounded text-[11px] font-bold font-mono transition-colors ${
                  subtitlesVisible
                    ? "bg-[var(--aurora-accent)] text-white shadow-xs"
                    : "bg-white/10 hover:bg-white/20 text-white/60"
                }`}
              >
                CC
              </button>
            )}

            {/* PiP Button */}
            <button
              type="button"
              onClick={togglePiP}
              title="画中画模式"
              className="p-1.5 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors"
            >
              <span className="text-[11px] font-mono border border-white/30 px-1 py-0.5 rounded">PiP</span>
            </button>

            {/* A-B Loop Button */}
            <button
              type="button"
              onClick={toggleAbPoint}
              title={
                abLoop.a === null
                  ? "设定 A 点 (快捷键 [)"
                  : abLoop.b === null
                  ? `已设A点 ${formatTime(abLoop.a)}，点击设B点 (快捷键 ])`
                  : `正在 A-B 循环 (${formatTime(abLoop.a)} - ${formatTime(abLoop.b)})，点击清除 (快捷键 \\)`
              }
              className={`p-1.5 rounded-lg transition-colors flex items-center gap-1 ${
                abLoop.a !== null
                  ? "text-amber-400 bg-amber-400/20 font-semibold"
                  : "text-white/80 hover:text-white hover:bg-white/10"
              }`}
            >
              <FiRepeat className="w-3.5 h-3.5" />
              {abLoop.a !== null && (
                <span className="text-[10px] font-mono">
                  {abLoop.b !== null ? "A-B" : "A-"}
                </span>
              )}
            </button>

            {/* Picture Filter Mode Toggle (Normal / Vivid / Warm) */}
            <button
              type="button"
              onClick={cycleFilterMode}
              title={`画质模式：${
                filterMode === "vivid" ? "代码对比度提亮" : filterMode === "warm" ? "夜间暖光护眼" : "标准原画"
              }`}
              className={`p-1.5 rounded-lg transition-colors flex items-center gap-1 ${
                filterMode !== "normal"
                  ? "text-amber-400 bg-amber-400/20 font-semibold shadow-xs"
                  : "text-white/80 hover:text-white hover:bg-white/10"
              }`}
            >
              <FiSliders className="w-4 h-4" />
              {filterMode !== "normal" && (
                <span className="text-[9px] font-mono uppercase">
                  {filterMode === "vivid" ? "Code" : "Eye"}
                </span>
              )}
            </button>

            {/* Aspect Ratio Fill Mode */}
            <button
              type="button"
              onClick={cycleFitMode}
              title={`画面比例：${fitMode === "cover" ? "居中裁剪铺满" : fitMode === "fill" ? "拉伸填满" : "适应原比例"}`}
              className={`p-1.5 rounded-lg transition-colors ${
                fitMode !== "contain" ? "text-[var(--aurora-accent)] bg-white/10" : "text-white/80 hover:text-white hover:bg-white/10"
              }`}
            >
              <FiLayers className="w-4 h-4" />
            </button>

            {/* Fullscreen & Landscape Rotation Buttons */}
            {effectiveFullscreen && (
              <button
                type="button"
                onClick={toggleLandscapeRotation}
                title={isLandscapeRotated ? "切换回竖屏" : "横屏满屏旋转"}
                className={`p-1.5 rounded-lg transition-colors flex items-center gap-1 ${
                  isLandscapeRotated
                    ? "text-[var(--aurora-accent)] bg-white/20 font-semibold"
                    : "text-white/80 hover:text-white hover:bg-white/10"
                }`}
              >
                <FiRotateCw className={`w-4 h-4 transition-transform duration-300 ${isLandscapeRotated ? "rotate-90 text-[var(--aurora-accent)]" : ""}`} />
                <span className="text-[10px] hidden sm:inline">{isLandscapeRotated ? "竖屏" : "横屏"}</span>
              </button>
            )}

            {/* Fullscreen Button */}
            <button
              type="button"
              onClick={toggleFullscreen}
              title={effectiveFullscreen ? "退出全屏" : "全屏"}
              className="p-1.5 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors"
            >
              {effectiveFullscreen ? <FiMinimize className="w-4 h-4" /> : <FiMaximize className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ========================================================================= */
/*                          2. Audio Player Component                        */
/* ========================================================================= */

export interface AudioPlayerProps {
  src: string;
  title?: string;
  downloadUrl?: string;
  className?: string;
}

export function AudioPlayer({ src, title, downloadUrl, className = "" }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [copied, setCopied] = useState<boolean>(false);
  const inspector = useMediaInspector();

  const [resolved, setResolved] = useState<ResolvedMedia>(() => resolveMediaUrl(src));
  useEffect(() => {
    setResolved(resolveMediaUrl(src));
  }, [src]);

  const { playUrl, downloadUrl: resolvedDownload, localPath, filename: resolvedFilename } = resolved;
  const displayTitle = (title && title.includes(".") ? title : "") || resolvedFilename || title || "audio-file";
  const finalDownloadUrl = downloadUrl || resolvedDownload || playUrl;

  let downloadFilename = displayTitle;
  const ext = resolvedFilename.split(".").pop();
  if (ext && !downloadFilename.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
    downloadFilename = `${downloadFilename}.${ext}`;
  }

  // Native MediaSession (Now Playing / Lock Screen / Dynamic Island) Integration
  useMediaSessionIntegration({
    mediaRef: audioRef,
    title: displayTitle,
    poster: null,
    isPlaying,
    duration,
    currentTime,
    playbackRate,
  });

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      a.play().catch(() => {});
    } else {
      a.pause();
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const a = audioRef.current;
    if (!a) return;
    const time = Number(e.target.value);
    a.currentTime = time;
    setCurrentTime(time);
  };

  const toggleRate = () => {
    const a = audioRef.current;
    if (!a) return;
    const nextRate = playbackRate === 1 ? 1.5 : playbackRate === 1.5 ? 2 : 1;
    a.playbackRate = nextRate;
    setPlaybackRate(nextRate);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(localPath || src);
      setCopied(true);
      showInAppToast("已复制", localPath ? "本地路径已复制" : "音频直链已复制");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div
      className={`my-3 p-3.5 rounded-2xl border border-[var(--aurora-border-strong)] bg-[var(--aurora-surface-solid)]/80 backdrop-blur-md shadow-md flex flex-col gap-2.5 max-w-xl ${className}`}
    >
      <audio
        ref={audioRef}
        src={playUrl}
        preload="metadata"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={() => audioRef.current && setCurrentTime(audioRef.current.currentTime)}
        onLoadedMetadata={() => audioRef.current && setDuration(audioRef.current.duration)}
      />

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={togglePlay}
            className="w-10 h-10 rounded-full bg-[var(--aurora-accent)] hover:opacity-90 flex items-center justify-center text-white shrink-0 shadow-md transition-all active:scale-95"
            title={isPlaying ? "暂停" : "播放"}
          >
            {isPlaying ? <FiPause className="w-4 h-4" /> : <FiPlay className="w-4 h-4 ml-0.5" />}
          </button>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-[var(--aurora-fg1)] truncate" title={displayTitle}>
              {displayTitle}
            </div>
            <div className="text-[11px] font-mono text-[var(--aurora-fg3)] flex items-center gap-2 mt-0.5">
              <span>{formatTime(currentTime)}</span>
              <span>/</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={toggleRate}
            className="px-2 py-1 rounded-lg bg-[var(--aurora-chip)] hover:bg-[var(--aurora-border)] text-[var(--aurora-fg2)] text-[11px] font-mono transition-colors"
            title="切换播放倍速"
          >
            {playbackRate}x
          </button>
          {inspector && (
            <button
              type="button"
              onClick={() => inspector.openMediaByUrl(src, displayTitle)}
              title="在右侧独立窗播放"
              className="p-1.5 rounded-lg text-[var(--aurora-fg3)] hover:text-[var(--aurora-accent)] hover:bg-[var(--aurora-chip)] transition-colors"
            >
              <FiSidebar className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className="p-1.5 rounded-lg text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] transition-colors"
            title="复制链接"
          >
            {copied ? <FiCheck className="w-3.5 h-3.5 text-emerald-500" /> : <FiCopy className="w-3.5 h-3.5" />}
          </button>
          <a
            href={finalDownloadUrl}
            download={downloadFilename}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 rounded-lg text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] transition-colors"
            title="下载音频文件"
          >
            <FiDownload className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>

      {/* Progress Bar */}
      <input
        type="range"
        min={0}
        max={duration || 100}
        step={0.1}
        value={currentTime}
        onChange={handleSeek}
        className="w-full h-1.5 rounded-lg appearance-none bg-[var(--aurora-border)] accent-[var(--aurora-accent)] cursor-pointer"
        style={{
          background: `linear-gradient(to right, var(--aurora-accent) ${(currentTime / (duration || 1)) * 100}%, var(--aurora-border) ${(currentTime / (duration || 1)) * 100}%)`,
        }}
      />
    </div>
  );
}

/* ========================================================================= */
/*                          3. Image Lightbox Component                      */
/* ========================================================================= */

export interface ImagePreviewProps {
  src: string;
  alt?: string;
  className?: string;
}

export function ImagePreview({ src, alt, className = "" }: ImagePreviewProps) {
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [resolved, setResolved] = useState<ResolvedMedia>(() => resolveMediaUrl(src));

  useEffect(() => {
    setResolved(resolveMediaUrl(src));
  }, [src]);

  const { playUrl, filename: resolvedFilename } = resolved;
  const displayTitle = alt || resolvedFilename || "image-preview";

  return (
    <>
      <div
        onClick={() => setIsOpen(true)}
        className={`relative group my-3 inline-block overflow-hidden rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-chip)]/40 shadow-xs cursor-zoom-in transition-all hover:border-[var(--aurora-accent)] hover:shadow-md ${className}`}
        title="点击放大查看图片"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={playUrl}
          alt={displayTitle}
          loading="lazy"
          decoding="async"
          className="max-h-96 w-auto object-contain rounded-xl transition-transform duration-300 group-hover:scale-[1.01]"
        />
        <div className="absolute inset-0 bg-black/25 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white pointer-events-none">
          <span className="p-2.5 rounded-full bg-black/70 backdrop-blur-md shadow-lg transform scale-90 group-hover:scale-100 transition-transform">
            <FiZoomIn className="w-4 h-4" />
          </span>
        </div>
      </div>

      <ImageViewerModal
        images={[{ src: playUrl, alt: displayTitle, title: displayTitle }]}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
      />
    </>
  );
}

/* ========================================================================= */
/*                          4. Media Attachment Card                         */
/* ========================================================================= */

export interface MediaAttachmentCardProps {
  url: string;
  title?: string;
}

export function MediaAttachmentCard({ url, title }: MediaAttachmentCardProps) {
  const type = detectMediaType(url);
  const [expanded, setExpanded] = useState<boolean>(true);

  const [resolved, setResolved] = useState<ResolvedMedia>(() => resolveMediaUrl(url));
  const inspector = useMediaInspector();
  useEffect(() => {
    setResolved(resolveMediaUrl(url));
  }, [url]);

  const displayTitle = (title && title.includes(".") ? title : "") || resolved.filename || title || "media-file";
  const finalDownloadUrl = resolved.downloadUrl || url;

  if (type === "video") {
    return (
      <div className="my-3">
        <div className="flex items-center justify-between text-xs text-[var(--aurora-fg3)] mb-1 px-1">
          <div className="flex items-center gap-1.5 font-medium text-[var(--aurora-fg2)]">
            <FiVideo className="w-3.5 h-3.5 text-[var(--aurora-accent)]" />
            <span>视频产物：{displayTitle}</span>
          </div>
          <div className="flex items-center gap-2.5">
            {inspector && (
              <button
                type="button"
                onClick={() => inspector.openMediaByUrl(url, displayTitle)}
                className="text-[var(--aurora-accent)] hover:underline text-[11px] flex items-center gap-1 font-medium"
              >
                <FiSidebar className="w-3 h-3" />
                <span>独立窗播放</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] text-[11px]"
            >
              {expanded ? "收起预览" : "展开播放"}
            </button>
          </div>
        </div>
        {expanded && <VideoPlayer src={url} title={displayTitle} />}
      </div>
    );
  }

  if (type === "audio") {
    return <AudioPlayer src={url} title={displayTitle} />;
  }

  if (type === "image") {
    return <ImagePreview src={url} alt={displayTitle} />;
  }

  // Fallback downloadable file card (PDF, archive, documents)
  return (
    <div className="my-2.5 p-3 rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-chip)]/40 flex items-center justify-between gap-3 max-w-md hover:border-[var(--aurora-accent)]/50 transition-colors">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="p-2 rounded-lg bg-[var(--aurora-accent)]/10 text-[var(--aurora-accent)]">
          <FiFileText className="w-4 h-4" />
        </span>
        <div className="min-w-0">
          <div className="text-xs font-medium text-[var(--aurora-fg1)] truncate" title={displayTitle}>
            {displayTitle}
          </div>
          <div className="text-[10px] text-[var(--aurora-fg3)] uppercase">
            {displayTitle.split(".").pop() || "FILE"} 产物文件
          </div>
        </div>
      </div>
      <a
        href={finalDownloadUrl}
        download={displayTitle}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[var(--aurora-accent)] hover:opacity-90 text-white text-xs font-medium transition-all shrink-0"
      >
        <FiDownload className="w-3.5 h-3.5" />
        <span>下载</span>
      </a>
    </div>
  );
}
