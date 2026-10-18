"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  FiX,
  FiVideo,
  FiMusic,
  FiImage,
  FiFileText,
  FiMaximize2,
  FiMinimize2,
  FiFolder,
  FiCopy,
  FiCheck,
  FiExternalLink,
  FiDownload,
  FiChevronLeft,
  FiChevronRight,
  FiPlay,
} from "react-icons/fi";
import { useMediaInspector, type MediaItem } from "./MediaInspectorContext";
import { VideoPlayer, AudioPlayer, ImagePreview, MediaAttachmentCard, resolveMediaUrl, safeDecodePath, getFilenameFromUrl, isLocalFilePath } from "./MediaPreview";
import MarkdownViewer from "./MarkdownViewer";
import { getApiBase, authFetch } from "@/lib/api-client";
import { desktop } from "@/lib/desktop";
import { showInAppToast } from "@/lib/native-notify";

interface MediaInspectorPanelProps {
  /** If provided, custom width for the docked split mode */
  className?: string;
  /** Layout mode: 'docked' for embedded 3rd column, 'overlay' for fixed floating overlay */
  mode?: "docked" | "overlay";
}

export function MediaInspectorPanel({ className = "", mode = "overlay" }: MediaInspectorPanelProps) {
  const inspector = useMediaInspector();
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    if (typeof window !== "undefined") {
      if (window.innerWidth < 1200) return 380;
      if (window.innerWidth < 1440) return 420;
    }
    return 460;
  });
  const [isExpandedFull, setIsExpandedFull] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const isDraggingRef = useRef<boolean>(false);
  const startXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(460);

  if (!inspector || !inspector.isOpen || !inspector.activeMedia) {
    return null;
  }

  const { activeMedia, mediaList, closeInspector, selectIndex, nextMedia, prevMedia } = inspector;
  const currentIndex = mediaList.findIndex((m) => m.id === activeMedia.id);
  const resolved = resolveMediaUrl(activeMedia.url);
  const displayTitle = activeMedia.title || resolved.filename || "媒体预览";
  const ext = displayTitle.split(".").pop()?.toUpperCase() || activeMedia.type.toUpperCase();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(resolved.localPath || activeMedia.url);
      setCopied(true);
      showInAppToast("已复制", resolved.localPath ? "本地文件物理路径已复制" : "媒体链接已复制");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleRevealFolder = () => {
    const d = desktop();
    if (resolved.localPath && d && typeof (d as any).showItemInFolder === "function") {
      (d as any).showItemInFolder(resolved.localPath);
      showInAppToast("已在访达/资源管理器中显示", displayTitle);
    }
  };

  const handleExternalOpen = async () => {
    const d = desktop();
    if (resolved.localPath && d && typeof (d as any).openPath === "function") {
      try {
        const err = await (d as any).openPath(resolved.localPath);
        if (!err) {
          showInAppToast(activeMedia.type === "markdown" ? "已在系统编辑器中打开" : "已在系统程序中打开", displayTitle);
          return;
        }
      } catch (e) {
        console.warn("openPath failed", e);
      }
    }
    if (d && typeof (d as any).openExternal === "function") {
      (d as any).openExternal(resolved.downloadUrl || activeMedia.url);
    } else {
      window.open(resolved.downloadUrl || activeMedia.url, "_blank", "noopener,noreferrer");
    }
  };

  // Resize drag handler
  const handleMouseDown = (e: React.MouseEvent) => {
    isDraggingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = panelWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = startXRef.current - moveEvent.clientX;
      const nextWidth = Math.min(840, Math.max(320, startWidthRef.current + delta));
      setPanelWidth(nextWidth);
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const renderPlayer = () => {
    switch (activeMedia.type) {
      case "video":
        return <VideoPlayer key={activeMedia.url} src={activeMedia.url} title={displayTitle} autoPlay />;
      case "audio":
        return <AudioPlayer key={activeMedia.url} src={activeMedia.url} title={displayTitle} />;
      case "image":
        return <ImagePreview key={activeMedia.url} src={activeMedia.url} alt={displayTitle} />;
      case "markdown":
        return <MarkdownDocViewer key={activeMedia.url || activeMedia.id} item={activeMedia} />;
      default:
        return <MediaAttachmentCard key={activeMedia.url} url={activeMedia.url} title={displayTitle} />;
    }
  };

  const getItemIcon = (type: MediaItem["type"]) => {
    switch (type) {
      case "video":
        return <FiVideo className="w-3.5 h-3.5 text-sky-400" />;
      case "audio":
        return <FiMusic className="w-3.5 h-3.5 text-emerald-400" />;
      case "image":
        return <FiImage className="w-3.5 h-3.5 text-purple-400" />;
      case "markdown":
        return <FiFileText className="w-3.5 h-3.5 text-amber-400" />;
      default:
        return <FiFileText className="w-3.5 h-3.5 text-amber-400" />;
    }
  };

  const isDocked = mode === "docked";

  return (
    <>
      {/* Mobile Backdrop: 仅在移动端抽屉模式生效，纯净暗色半透明，绝无任何模糊滤镜，桌面大屏通过 lg:hidden 彻底隐藏 */}
      <div
        className="fixed inset-0 bg-black/50 z-40 transition-opacity lg:hidden"
        onClick={closeInspector}
      />

      {/* 媒体独立视窗容器: 桌面端为固定第三栏嵌入式展示，移动端为右侧滑出抽屉 */}
      <aside
        className={`bg-[var(--aurora-surface-solid,#0f172a)]/95 backdrop-blur-2xl border-l border-[var(--aurora-border-strong)] transition-all duration-200 select-none overflow-hidden
          lg:relative lg:flex lg:flex-col lg:h-full lg:shrink-0 lg:z-20
          max-lg:fixed max-lg:top-0 max-lg:right-0 max-lg:bottom-0 max-lg:z-50 max-lg:flex max-lg:flex-col max-lg:w-full max-lg:sm:w-[460px] max-lg:max-w-full max-lg:shadow-2xl
          max-lg:pt-[env(safe-area-inset-top,0px)] max-lg:pb-[env(safe-area-inset-bottom,0px)]
          ${className}`}
        style={{
          width: typeof window !== "undefined" && window.innerWidth < 1024 ? "100%" : isExpandedFull ? "min(100%, 960px)" : `${panelWidth}px`,
        }}
      >
        {/* Resize Handle on the left border (桌面大屏停靠模式下可见) */}
        {!isExpandedFull && (
          <div
            onMouseDown={handleMouseDown}
            title="拖拽调节独立窗宽度"
            className="hidden lg:block absolute left-0 top-0 bottom-0 w-2 -ml-1 cursor-col-resize hover:bg-[var(--aurora-accent)]/50 active:bg-[var(--aurora-accent)] transition-colors z-30 group"
          >
            <div className="w-0.5 h-8 bg-white/20 rounded-full mx-auto my-auto relative top-1/2 -translate-y-1/2 group-hover:bg-[var(--aurora-accent)]" />
          </div>
        )}

        {/* Header Bar */}
        <div className="flex items-center justify-between px-3 sm:px-4 py-2.5 sm:py-3 border-b border-[var(--aurora-border)] bg-[var(--aurora-chip)]/40 shrink-0 gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--aurora-accent)]/15 text-[var(--aurora-accent)] shrink-0">
              {getItemIcon(activeMedia.type)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-xs font-semibold text-[var(--aurora-fg1)] truncate" title={displayTitle}>
                  {displayTitle}
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[var(--aurora-chip)] text-[var(--aurora-fg3)] uppercase shrink-0">
                  {ext}
                </span>
              </div>
              <div className="text-[10.5px] text-[var(--aurora-fg3)] flex items-center gap-1.5 mt-0.5 truncate">
                <span className="shrink-0">独立视窗</span>
                {mediaList.length > 1 && (
                  <>
                    <span>•</span>
                    <span className="text-[var(--aurora-accent)] font-medium shrink-0">
                      第 {currentIndex + 1} / {mediaList.length} 个媒体
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Action Tools */}
          <div className="flex items-center gap-1 shrink-0">
            {mediaList.length > 1 && (
              <div className="flex items-center gap-0.5 mr-1 bg-[var(--aurora-chip)] rounded-lg p-0.5 border border-[var(--aurora-border)]">
                <button
                  type="button"
                  onClick={prevMedia}
                  title="上一个媒体"
                  className="p-1 rounded text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-surface)] transition-colors"
                >
                  <FiChevronLeft className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={nextMedia}
                  title="下一个媒体"
                  className="p-1 rounded text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-surface)] transition-colors"
                >
                  <FiChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {resolved.localPath && (
              <button
                type="button"
                onClick={handleRevealFolder}
                title={activeMedia.type === "markdown" ? "在访达/资源管理器中定位" : "在访达中定位原片"}
                className="p-1.5 rounded-lg text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] transition-colors"
              >
                <FiFolder className="w-3.5 h-3.5" />
              </button>
            )}

            <button
              type="button"
              onClick={handleCopy}
              title={copied ? "已复制" : resolved.localPath ? "复制本地路径" : "复制链接"}
              className="p-1.5 rounded-lg text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] transition-colors"
            >
              {copied ? <FiCheck className="w-3.5 h-3.5 text-emerald-400" /> : <FiCopy className="w-3.5 h-3.5" />}
            </button>

            <button
              type="button"
              onClick={handleExternalOpen}
              title={resolved.localPath ? (activeMedia.type === "markdown" ? "在系统编辑器中打开" : "在系统播放器中打开") : "新标签独立打开"}
              className="p-1.5 rounded-lg text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] transition-colors"
            >
              <FiExternalLink className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => setIsExpandedFull((v) => !v)}
              title={isExpandedFull ? "还原视窗宽度" : "最大化视窗"}
              className="p-1.5 rounded-lg text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] transition-colors"
            >
              {isExpandedFull ? <FiMinimize2 className="w-3.5 h-3.5" /> : <FiMaximize2 className="w-3.5 h-3.5" />}
            </button>

            <button
              type="button"
              onClick={closeInspector}
              title="关闭独立窗"
              className="p-1.5 rounded-lg text-[var(--aurora-fg3)] hover:text-red-400 hover:bg-red-500/10 transition-colors ml-0.5"
            >
              <FiX className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scrollable Main Content */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {/* Main Media Player Viewport */}
          <div className="w-full rounded-2xl overflow-hidden shadow-xl border border-[var(--aurora-border)] bg-black/80">
            {renderPlayer()}
          </div>

          {/* If there are multiple media items in this conversation (e.g. 2 videos or more), show Media Playlist */}
          {mediaList.length > 1 && (
            <div className="mt-4 pt-3 border-t border-[var(--aurora-border)]">
              <div className="flex items-center justify-between mb-2.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--aurora-fg1)]">
                  <span>本次对话媒体清单</span>
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-[var(--aurora-accent)]/20 text-[var(--aurora-accent)] font-mono">
                    {mediaList.length}
                  </span>
                </div>
                <span className="text-[11px] text-[var(--aurora-fg3)]">点击任一切换播放</span>
              </div>

              <div className="grid grid-cols-1 gap-2">
                {mediaList.map((item, idx) => {
                  const isCurrent = item.id === activeMedia.id;
                  const itemTitle = item.title || getFilenameFromUrl(item.url);
                  const itemExt = itemTitle.split(".").pop()?.toUpperCase() || item.type.toUpperCase();

                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => selectIndex(idx)}
                      className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left border transition-all ${
                        isCurrent
                          ? "border-[var(--aurora-accent)] bg-[var(--aurora-accent)]/10 shadow-sm shadow-[var(--aurora-accent)]/10"
                          : "border-[var(--aurora-border)] bg-[var(--aurora-chip)]/40 hover:bg-[var(--aurora-chip)] hover:border-[var(--aurora-border-strong)]"
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0 pr-2">
                        <span
                          className={`w-6 h-6 rounded-lg flex items-center justify-center text-xs shrink-0 ${
                            isCurrent
                              ? "bg-[var(--aurora-accent)] text-white"
                              : "bg-[var(--aurora-surface)] text-[var(--aurora-fg3)]"
                          }`}
                        >
                          {isCurrent ? <FiPlay className="w-3 h-3 fill-current ml-0.5" /> : idx + 1}
                        </span>
                        <div className="min-w-0">
                          <div
                            className={`text-xs font-medium truncate ${
                              isCurrent ? "text-[var(--aurora-accent)] font-semibold" : "text-[var(--aurora-fg1)]"
                            }`}
                            title={itemTitle}
                          >
                            {itemTitle}
                          </div>
                          <div className="text-[10px] text-[var(--aurora-fg3)] flex items-center gap-2 mt-0.5">
                            <span className="uppercase">{itemExt}</span>
                            {item.localPath && <span className="truncate max-w-[200px]">本地磁盘文件</span>}
                          </div>
                        </div>
                      </div>

                      <div className="shrink-0 flex items-center">
                        {isCurrent ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-[var(--aurora-accent)]/20 text-[var(--aurora-accent)] animate-pulse">
                            播放中
                          </span>
                        ) : (
                          <span className="text-[11px] text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)]">
                            播放
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Detailed Info Card */}
          {resolved.localPath && (
            <div className="p-3 rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-chip)]/20 text-[11px] text-[var(--aurora-fg3)] space-y-1.5">
              <div className="font-medium text-[var(--aurora-fg2)] flex items-center justify-between">
                <span>本地文件信息</span>
                <span className="text-[10px] font-mono text-emerald-400">已就绪</span>
              </div>
              <div className="font-mono text-[10px] break-all bg-black/20 p-2 rounded-lg border border-white/5 select-text">
                {resolved.localPath}
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function MarkdownDocViewer({ item }: { item: MediaItem }) {
  const [content, setContent] = useState<string>(item.content || "");
  const [loading, setLoading] = useState<boolean>(!item.content);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (item.content) {
      setContent(item.content);
      setLoading(false);
      setError(null);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);

    const loadDoc = async () => {
      try {
        const rawUrl = item.url;
        // Check if it's a document uuid route like /documents/<uuid> or /api/documents/<uuid>
        const docMatch = rawUrl.match(/(?:\/api)?\/documents\/([0-9a-fA-F-]{36})/);
        if (docMatch) {
          const docId = docMatch[1];
          const res = await authFetch(`${getApiBase()}/api/documents/${docId}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (active) {
            setContent(data.content || data.title || "");
            setLoading(false);
          }
          return;
        }

        const decoded = safeDecodePath(rawUrl);
        const filename = getFilenameFromUrl(decoded);
        let fetchUrl = rawUrl;

        let clean = "";
        if (isLocalFilePath(decoded)) {
          clean = decoded.replace(/^file:\/\//, "");
          if (typeof window !== "undefined" && navigator.userAgent.includes("Windows") && clean.startsWith("/") && clean[2] === ":") {
            clean = clean.slice(1);
          }
          const d = desktop();
          // 1. Direct desktop IPC file read: instantaneous, bypasses network, Chromium web security & CORS
          if (d && typeof d.readFile === "function") {
            try {
              const ipcRes = await d.readFile(clean);
              if (ipcRes && typeof ipcRes.content === "string") {
                if (active) {
                  setContent(ipcRes.content);
                  setLoading(false);
                }
                return;
              }
              if (ipcRes?.error) {
                console.warn("[MarkdownDocViewer] desktop readFile returned error:", ipcRes.error);
              }
            } catch (ipcErr) {
              console.warn("[MarkdownDocViewer] desktop readFile threw:", ipcErr);
            }
          }

          if (d && typeof d.toMediaUrl === "function") {
            fetchUrl = d.toMediaUrl(clean);
          } else {
            const resolved = resolveMediaUrl(rawUrl);
            fetchUrl = resolved.playUrl;
          }
        }

        let res: Response | null = null;
        try {
          if (fetchUrl.startsWith("http://") || fetchUrl.startsWith("https://") || fetchUrl.startsWith("/")) {
            res = await authFetch(fetchUrl);
          } else {
            res = await fetch(fetchUrl);
          }
        } catch (fetchErr) {
          // Fallback 1: If custom scheme or direct fetch failed (e.g. memento-media CORS in older client),
          // seamlessly fallback to the device streaming relay API!
          if (isLocalFilePath(decoded) && clean) {
            try {
              const apiBase = getApiBase();
              const relayUrl = `${apiBase}/api/devices/auto/files/stream/${encodeURIComponent(filename)}?path=${encodeURIComponent(clean)}`;
              res = await authFetch(relayUrl);
            } catch {
              // ignore
            }
          }

          if (!res || !res.ok) {
            throw fetchErr;
          }
        }

        if (!res || !res.ok) {
          // Fallback 2: If response was not OK, try streaming relay
          if (isLocalFilePath(decoded) && clean) {
            try {
              const apiBase = getApiBase();
              const relayUrl = `${apiBase}/api/devices/auto/files/stream/${encodeURIComponent(filename)}?path=${encodeURIComponent(clean)}`;
              const relayRes = await authFetch(relayUrl);
              if (relayRes.ok) {
                res = relayRes;
              }
            } catch {
              // ignore
            }
          }
        }

        if (!res || !res.ok) {
          throw new Error(`HTTP ${res ? res.status : 404}`);
        }

        const text = await res.text();
        if (active) {
          setContent(text);
          setLoading(false);
        }
      } catch (err: any) {
        if (active) {
          setError(err?.message || "无法加载文档内容");
          setLoading(false);
        }
      }
    };

    loadDoc();
    return () => {
      active = false;
    };
  }, [item.url, item.content]);

  if (loading) {
    return (
      <div className="p-8 text-center text-xs text-[var(--aurora-fg3)] flex flex-col items-center justify-center gap-2 min-h-[220px]">
        <div className="w-5 h-5 border-2 border-[var(--aurora-accent)] border-t-transparent rounded-full animate-spin" />
        <span>正在载入工作台文档预览...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-center text-xs text-red-400 bg-red-500/10 rounded-xl border border-red-500/20">
        <p className="font-semibold mb-1">文档加载异常</p>
        <p className="opacity-80 font-mono text-[11px] mb-3">{error}</p>
        {item.url && (
          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => {
                const d = desktop();
                const clean = safeDecodePath(item.url).replace(/^file:\/\//, "");
                if (d && typeof (d as any).openPath === "function") {
                  (d as any).openPath(clean);
                } else {
                  window.open(item.url, "_blank");
                }
              }}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-200 text-[11px] font-medium transition-colors cursor-pointer"
            >
              <span>外部打开</span>
              <span>↗</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-5 bg-[var(--aurora-surface-solid)]/95 rounded-xl border border-[var(--aurora-border)] overflow-x-hidden text-left">
      <MarkdownViewer content={content} />
    </div>
  );
}
