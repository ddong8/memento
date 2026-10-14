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
} from "react-icons/fi";
import { desktop } from "@/lib/desktop";
import { showInAppToast } from "@/lib/native-notify";
import { getApiBase } from "@/lib/api-client";
import { useMediaInspector } from "./MediaInspectorContext";

export type MediaType = "video" | "audio" | "image" | "pdf" | "markdown" | "unknown";

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "mkv", "m4v", "ogv", "avi", "flv"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus", "wma"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const MARKDOWN_EXTS = new Set(["md", "markdown"]);

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
    const token = typeof window !== "undefined" ? localStorage.getItem("dr_token") : null;
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
    const apiBase = getApiBase();
    const streamUrl = `${apiBase}/api/devices/auto/files/stream/${encodeURIComponent(filename)}?path=${encodeURIComponent(clean)}${tokenParam}`;
    return {
      playUrl: streamUrl,
      downloadUrl: streamUrl,
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

export interface VideoPlayerProps {
  src: string;
  title?: string;
  poster?: string;
  downloadUrl?: string;
  autoPlay?: boolean;
  className?: string;
}

export function VideoPlayer({
  src,
  title,
  poster,
  downloadUrl,
  autoPlay = false,
  className = "",
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [showControls, setShowControls] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [hasError, setHasError] = useState<boolean>(false);
  const [bufferedProgress, setBufferedProgress] = useState<number>(0);
  const [copied, setCopied] = useState<boolean>(false);
  const [showRateMenu, setShowRateMenu] = useState<boolean>(false);
  const [quality, setQuality] = useState<"1080p" | "720p">("1080p");
  const [showQualityMenu, setShowQualityMenu] = useState<boolean>(false);

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

  const [resolved, setResolved] = useState<ResolvedMedia>(() => resolveMediaUrl(activeSrc));
  useEffect(() => {
    setResolved(resolveMediaUrl(activeSrc));
    setHasError(false);
    setIsLoading(true);
  }, [activeSrc]);

  const { playUrl, downloadUrl: resolvedDownload, localPath, filename: resolvedFilename } = resolved;
  const displayTitle = (title && title.includes(".") ? title : "") || resolvedFilename || title || "video-file";
  const finalDownloadUrl = downloadUrl || resolvedDownload || playUrl;

  let downloadFilename = displayTitle;
  const ext = resolvedFilename.split(".").pop();
  if (ext && !downloadFilename.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
    downloadFilename = `${downloadFilename}.${ext}`;
  }

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

  useEffect(() => {
    return () => {
      if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current);
    };
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, []);

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
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setIsMuted(v.muted);
    triggerControlsActivity();
  };

  const changeRate = (rate: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = rate;
    setPlaybackRate(rate);
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

  const toggleFullscreen = async () => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      try {
        await el.requestFullscreen();
        setIsFullscreen(true);
      } catch {
        // ignore
      }
    } else {
      try {
        await document.exitFullscreen();
        setIsFullscreen(false);
      } catch {
        // ignore
      }
    }
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

  return (
    <div
      ref={containerRef}
      onMouseMove={triggerControlsActivity}
      onMouseLeave={() => isPlaying && setShowControls(false)}
      className={`relative group my-4 w-full overflow-hidden rounded-2xl border border-[var(--aurora-border-strong)] bg-black/90 shadow-2xl transition-all duration-300 ${className}`}
      style={{
        boxShadow: "0 12px 36px -8px rgba(0, 0, 0, 0.4), 0 0 0 1px var(--aurora-border-strong)",
      }}
    >
      {/* Top Bar Overlay */}
      <div
        className={`absolute top-0 inset-x-0 z-20 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/80 via-black/40 to-transparent transition-opacity duration-300 ${
          showControls || !isPlaying ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        <div className="flex items-center gap-2.5 min-w-0 pr-2">
          <span className="flex items-center justify-center w-6 h-6 rounded-lg bg-[var(--aurora-accent)]/20 text-[var(--aurora-accent)] text-xs">
            <FiVideo className="w-3.5 h-3.5" />
          </span>
          <span className="text-xs font-medium text-white/90 truncate tracking-wide" title={displayTitle}>
            {displayTitle}
          </span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/10 text-white/60 uppercase">
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
            onClick={handleCopyLink}
            title={copied ? "已复制" : localPath ? "复制本地文件路径" : "复制视频链接"}
            className="p-1.5 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors text-xs"
          >
            {copied ? <FiCheck className="w-3.5 h-3.5 text-emerald-400" /> : <FiCopy className="w-3.5 h-3.5" />}
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
      <div className="relative w-full aspect-video flex items-center justify-center bg-black cursor-pointer" onClick={togglePlay}>
        <video
          ref={videoRef}
          src={playUrl}
          poster={poster}
          autoPlay={autoPlay}
          playsInline
          preload="auto"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onTimeUpdate={() => videoRef.current && setCurrentTime(videoRef.current.currentTime)}
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
            if (videoRef.current) {
              setDuration(videoRef.current.duration);
              setIsLoading(false);
            }
          }}
          onCanPlay={() => setIsLoading(false)}
          onWaiting={() => setIsLoading(true)}
          onPlaying={() => setIsLoading(false)}
          onError={() => {
            setIsLoading(false);
            setHasError(true);
          }}
          className="w-full h-full object-contain"
        />

        {/* Loading Spinner */}
        {isLoading && !hasError && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none z-10 backdrop-blur-xs">
            <div className="w-10 h-10 border-3 border-[var(--aurora-accent)]/30 border-t-[var(--aurora-accent)] rounded-full animate-spin" />
          </div>
        )}

        {/* Big Center Play Button (When Paused) */}
        {!isPlaying && !isLoading && !hasError && (
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
      </div>

      {/* Bottom Floating Controls */}
      <div
        className={`absolute bottom-0 inset-x-0 z-20 px-4 py-3 bg-gradient-to-t from-black/90 via-black/50 to-transparent transition-opacity duration-300 ${
          showControls || !isPlaying ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        {/* Progress Bar Slider with Network Buffered Range */}
        <div className="relative flex items-center group/progress mb-2 cursor-pointer h-3">
          {/* Dual Layer Track: Background + Network Buffered + Current Played */}
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
          </div>
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
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={togglePlay}
              className="p-1.5 rounded-lg text-white hover:text-[var(--aurora-accent)] hover:bg-white/10 transition-colors"
              title={isPlaying ? "暂停" : "播放"}
            >
              {isPlaying ? <FiPause className="w-4 h-4" /> : <FiPlay className="w-4 h-4" />}
            </button>

            {/* Volume Control */}
            <div className="flex items-center gap-1.5 group/vol">
              <button
                type="button"
                onClick={toggleMute}
                className="p-1 rounded text-white/80 hover:text-white hover:bg-white/10 transition-colors"
                title={isMuted ? "取消静音" : "静音"}
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

            {/* PiP Button */}
            <button
              type="button"
              onClick={togglePiP}
              title="画中画模式"
              className="p-1.5 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors"
            >
              <span className="text-[11px] font-mono border border-white/30 px-1 py-0.5 rounded">PiP</span>
            </button>

            {/* Fullscreen Button */}
            <button
              type="button"
              onClick={toggleFullscreen}
              title={isFullscreen ? "退出全屏" : "全屏"}
              className="p-1.5 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors"
            >
              {isFullscreen ? <FiMinimize className="w-4 h-4" /> : <FiMaximize className="w-4 h-4" />}
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
  const [zoom, setZoom] = useState<number>(1);
  const [rotation, setRotation] = useState<number>(0);

  const [resolved, setResolved] = useState<ResolvedMedia>(() => resolveMediaUrl(src));
  useEffect(() => {
    setResolved(resolveMediaUrl(src));
  }, [src]);

  const { playUrl, downloadUrl: resolvedDownload, filename: resolvedFilename } = resolved;
  const displayTitle = alt || resolvedFilename || "image-preview";
  const finalDownloadUrl = resolvedDownload || playUrl;

  const handleOpen = () => {
    setZoom(1);
    setRotation(0);
    setIsOpen(true);
  };

  const handleClose = () => {
    setIsOpen(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    if (isOpen) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  return (
    <>
      <div className={`relative group my-3 inline-block overflow-hidden rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-chip)]/40 shadow-xs cursor-zoom-in transition-all hover:border-[var(--aurora-accent)] ${className}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={playUrl}
          alt={displayTitle}
          loading="lazy"
          onClick={handleOpen}
          className="max-h-96 w-auto object-contain rounded-xl transition-transform duration-300 group-hover:scale-[1.01]"
        />
        <div
          onClick={handleOpen}
          className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white gap-2 pointer-events-none"
        >
          <span className="p-2 rounded-full bg-black/60 backdrop-blur-md">
            <FiZoomIn className="w-4 h-4" />
          </span>
        </div>
      </div>

      {isOpen && (
        <div
          onClick={handleClose}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4 animate-fadeIn"
        >
          {/* Top Bar Controls */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute top-4 inset-x-6 flex items-center justify-between z-10 text-white"
          >
            <span className="text-sm font-medium truncate max-w-md">{displayTitle}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
                className="p-2 rounded-xl bg-white/10 hover:bg-white/20 transition-colors"
                title="放大"
              >
                <FiZoomIn className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
                className="p-2 rounded-xl bg-white/10 hover:bg-white/20 transition-colors"
                title="缩小"
              >
                <FiZoomOut className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setRotation((r) => (r + 90) % 360)}
                className="p-2 rounded-xl bg-white/10 hover:bg-white/20 transition-colors"
                title="顺时针旋转"
              >
                <FiRotateCw className="w-4 h-4" />
              </button>
              <a
                href={finalDownloadUrl}
                download={displayTitle}
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 rounded-xl bg-white/10 hover:bg-white/20 transition-colors"
                title="下载原图"
              >
                <FiDownload className="w-4 h-4" />
              </a>
              <button
                type="button"
                onClick={handleClose}
                className="p-2 rounded-xl bg-white/10 hover:bg-red-500/80 transition-colors ml-2"
                title="关闭 (Esc)"
              >
                <FiX className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Expanded Image */}
          <div onClick={(e) => e.stopPropagation()} className="relative max-w-full max-h-[85vh] overflow-hidden flex items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={playUrl}
              alt={displayTitle}
              style={{
                transform: `scale(${zoom}) rotate(${rotation}deg)`,
                transition: "transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
              }}
              className="max-h-[85vh] max-w-[90vw] object-contain rounded-lg shadow-2xl select-none"
            />
          </div>
        </div>
      )}
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
