"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
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
  FiShare2,
  FiEdit3,
  FiEye,
  FiSend,
  FiRotateCcw,
  FiRefreshCw,
  FiSmartphone,
} from "react-icons/fi";
import { useMediaInspector, type MediaItem } from "./MediaInspectorContext";
import { VideoPlayer, AudioPlayer, ImagePreview, MediaAttachmentCard, resolveMediaUrl, safeDecodePath, getFilenameFromUrl, isLocalFilePath } from "./MediaPreview";
import MarkdownViewer from "./MarkdownViewer";
import { WeChatPublishModal } from "./WeChatPublishModal";
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

  const handleShare = async () => {
    const url = resolved.downloadUrl || activeMedia.url;
    if (typeof navigator !== "undefined" && typeof (navigator as any).share === "function") {
      try {
        await (navigator as any).share({
          title: displayTitle,
          text: `分享媒体：${displayTitle}`,
          url,
        });
        return;
      } catch {
        // user cancelled or fallback
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      showInAppToast("已复制分享链接", displayTitle);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
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
      case "video": {
        const subtitleCandidates = mediaList
          .filter((m) => m.url.toLowerCase().endsWith(".srt") || m.url.toLowerCase().endsWith(".vtt"))
          .map((m) => m.url);
        return (
          <VideoPlayer
            key={activeMedia.url}
            src={activeMedia.url}
            title={displayTitle}
            subtitles={subtitleCandidates.length > 0 ? subtitleCandidates : undefined}
            autoPlay
          />
        );
      }
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
      case "subtitle":
        return <FiFileText className="w-3.5 h-3.5 text-indigo-400" />;
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

            <button
              type="button"
              onClick={() => {
                inspector.refreshActiveMedia();
                showInAppToast("已刷新", "正在重新加载最新文件内容");
              }}
              title="重新读取磁盘最新内容 (刷新)"
              className="p-1.5 rounded-lg text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] transition-colors"
            >
              <FiRefreshCw className="w-3.5 h-3.5" />
            </button>

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
              onClick={handleShare}
              title="分享媒体链接"
              className="p-1.5 rounded-lg text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] transition-colors"
            >
              <FiShare2 className="w-3.5 h-3.5" />
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
        <div className="flex-1 overflow-y-auto px-2 sm:px-4 py-2 sm:py-4 space-y-3 sm:space-y-4">
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

const THEME_OPTIONS = [
  { id: "tech", name: "科技蓝", color: "#2563eb", desc: "商务沉稳技术风" },
  { id: "emerald", name: "墨绿雅致", color: "#059669", desc: "自然清新雅致风" },
  { id: "minimalist", name: "黑白极简", color: "#1e293b", desc: "现代高冷极简风" },
  { id: "red", name: "中国红韵", color: "#dc2626", desc: "喜庆醒目红韵风" },
];

function MarkdownDocViewer({ item }: { item: MediaItem }) {
  const inspector = useMediaInspector();
  const [content, setContent] = useState<string>(item.content || "");
  const [originalContent, setOriginalContent] = useState<string>(item.content || "");
  const [loading, setLoading] = useState<boolean>(!item.content);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"preview" | "mobile" | "edit">("preview");
  const [themeId, setThemeId] = useState<string>("tech");
  const [followed, setFollowed] = useState<boolean>(false);
  const [showWechatModal, setShowWechatModal] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [copyingRich, setCopyingRich] = useState<boolean>(false);
  const [reloadTick, setReloadTick] = useState<number>(0);

  const isLocal = isLocalFilePath(item.url);
  const isModified = content !== originalContent;
  const isModifiedRef = useRef(false);
  isModifiedRef.current = isModified;

  // 章节目录快速索引提取
  const headings = useMemo(() => {
    const list: Array<{ raw: string; clean: string }> = [];
    const lines = content.split("\n");
    for (const line of lines) {
      const match = line.match(/^#{2,3}\s+(.+)$/);
      if (match) {
        const raw = match[1].trim();
        let clean = raw.replace(/^[【\[\s#]+|[】\]\s]+$/g, "").replace(/[*_~`]/g, "");
        const colonIdx = clean.search(/[：:]/);
        if (colonIdx > 1 && colonIdx <= 18) {
          clean = clean.slice(0, colonIdx).trim();
        } else if (clean.length > 18) {
          clean = clean.slice(0, 18).trim();
        }
        if (clean.length >= 1) {
          list.push({ raw, clean });
        }
      }
    }
    return list;
  }, [content]);

  const handleScrollToHeading = (clean: string) => {
    if (typeof document === "undefined") return;
    const elements = document.querySelectorAll("h1, h2, h3");
    for (const el of Array.from(elements)) {
      if (el.textContent && (el.textContent.includes(clean) || clean.includes(el.textContent.slice(0, 6)))) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        break;
      }
    }
  };

  // 1. 初始化时尝试载入本地草稿缓存
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = localStorage.getItem(`memento_draft_${safeDecodePath(item.url)}`);
      if (saved && saved !== content && saved.length > 20) {
        setContent(saved);
        showInAppToast("已载入本地草稿", "已为您自动恢复上次编辑的润色版本");
      }
    } catch {
      // ignore
    }
  }, [item.url]);

  // 2. 润色编辑发生变动时自动持久化到 localStorage
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isModified && content.trim()) {
      try {
        localStorage.setItem(`memento_draft_${safeDecodePath(item.url)}`, content);
      } catch {
        // ignore
      }
    }
  }, [content, isModified, item.url]);

  useEffect(() => {
    // 纯文本虚拟稿件且非本地文件时，若外部有 content 则直接使用
    if (item.content && !isLocal && reloadTick === 0) {
      setContent(item.content);
      setOriginalContent(item.content);
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
            const docText = data.content || data.title || "";
            setContent(docText);
            setOriginalContent(docText);
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
                  setOriginalContent(ipcRes.content);
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
          const bustUrl = fetchUrl.includes("?") ? `${fetchUrl}&_t=${Date.now()}` : `${fetchUrl}?_t=${Date.now()}`;
          if (fetchUrl.startsWith("http://") || fetchUrl.startsWith("https://") || fetchUrl.startsWith("/")) {
            res = await authFetch(bustUrl);
          } else {
            res = await fetch(bustUrl, { cache: "no-store" });
          }
        } catch (fetchErr) {
          if (isLocalFilePath(decoded) && clean) {
            try {
              const apiBase = getApiBase();
              const relayUrl = `${apiBase}/api/devices/auto/files/stream/${encodeURIComponent(filename)}?path=${encodeURIComponent(clean)}&_t=${Date.now()}`;
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
          if (isLocalFilePath(decoded) && clean) {
            try {
              const apiBase = getApiBase();
              const relayUrl = `${apiBase}/api/devices/auto/files/stream/${encodeURIComponent(filename)}?path=${encodeURIComponent(clean)}&_t=${Date.now()}`;
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
          setOriginalContent(text);
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
  }, [item.url, item.content, isLocal, inspector?.refreshKey, reloadTick]);

  useEffect(() => {
    const handleFocus = () => {
      // 窗口切回时若当前未进行本地润色修改，自动同步磁盘最新状态
      if (!isModifiedRef.current && isLocal) {
        setReloadTick((t) => t + 1);
      }
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [isLocal]);

  const wordCount = content.trim().length;
  const readingTime = Math.max(1, Math.ceil(wordCount / 400));
  const activeTheme = THEME_OPTIONS.find((t) => t.id === themeId) || THEME_OPTIONS[0];

  const handleCopyContent = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      showInAppToast("已复制 Markdown 全文", `${wordCount} 字`);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleCopyRichText = async () => {
    try {
      setCopyingRich(true);
      const res = await fetch("https://wx.ihasy.com/api/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: content, themeId, extractLinks: true }),
      });
      const data = await res.json();
      if (data.success && data.html) {
        const blob = new Blob([data.html], { type: "text/html" });
        const textBlob = new Blob([content], { type: "text/plain" });
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": blob,
            "text/plain": textBlob,
          }),
        ]);
        showInAppToast("已复制微信富文本", "可在微信公众号后台或笔记中直接 Ctrl+V 粘贴");
      } else {
        throw new Error(data.error || "富文本转换失败");
      }
    } catch (err: unknown) {
      console.warn("copy rich text fallback", err);
      await navigator.clipboard.writeText(content);
      showInAppToast("已复制 Markdown 原文", "富文本服务稍有延迟，已复制全文内容");
    } finally {
      setCopyingRich(false);
    }
  };

  const handleReset = () => {
    setContent(originalContent);
    if (typeof window !== "undefined") {
      try {
        localStorage.removeItem(`memento_draft_${safeDecodePath(item.url)}`);
      } catch {
        // ignore
      }
    }
    showInAppToast("已重置", "已放弃本地草稿并恢复为最初文档内容");
  };

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
    <div className="flex flex-col gap-2.5 text-left">
      {/* 工作台精细化导航与操作栏 */}
      <div className="flex flex-col gap-2 p-2 sm:p-2.5 rounded-2xl bg-[var(--aurora-chip)]/40 border border-[var(--aurora-border)] text-xs select-none shadow-sm">
        {/* Row 1: 核心视窗模式切换 与 动作按钮 */}
        <div className="flex items-center justify-between gap-2">
          {/* 模式选择器 (Segmented Control) */}
          <div className="inline-flex p-0.5 rounded-xl bg-black/20 border border-[var(--aurora-border)]/60 text-xs shrink-0">
            <button
              type="button"
              onClick={() => setViewMode("preview")}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                viewMode === "preview"
                  ? "bg-[var(--aurora-accent)] text-slate-900 shadow-sm font-semibold"
                  : "text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-white/5"
              }`}
            >
              <FiEye className="w-3.5 h-3.5" />
              <span>排版</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode("mobile")}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                viewMode === "mobile"
                  ? "bg-emerald-500 text-slate-900 shadow-sm font-semibold"
                  : "text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-white/5"
              }`}
            >
              <FiSmartphone className="w-3.5 h-3.5" />
              <span>真机</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode("edit")}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                viewMode === "edit"
                  ? "bg-[var(--aurora-accent)] text-slate-900 shadow-sm font-semibold"
                  : "text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-white/5"
              }`}
            >
              <FiEdit3 className="w-3.5 h-3.5" />
              <span>润色</span>
              {isModified && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" title="文本已调整" />
              )}
            </button>
          </div>

          {/* 动作区 */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                setReloadTick((t) => t + 1);
                showInAppToast("已刷新", "已从磁盘重新加载最新文件");
              }}
              title="重新读取磁盘文件"
              className="p-1.5 rounded-lg border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)]/80 text-[var(--aurora-fg2)] hover:text-[var(--aurora-fg1)] hover:bg-white/5 transition-colors cursor-pointer"
            >
              <FiRefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-[var(--aurora-accent)]" : ""}`} />
            </button>

            <button
              type="button"
              onClick={handleCopyContent}
              title="复制 Markdown 全文源码"
              className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)]/80 text-[var(--aurora-fg2)] hover:text-[var(--aurora-fg1)] hover:bg-white/5 transition-colors cursor-pointer text-xs font-medium"
            >
              {copied ? <FiCheck className="w-3.5 h-3.5 text-emerald-400" /> : <FiFileText className="w-3.5 h-3.5" />}
              <span>{copied ? "已复制" : "复制源码"}</span>
            </button>

            <button
              type="button"
              onClick={handleCopyRichText}
              disabled={copyingRich}
              title="复制微信富文本"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors cursor-pointer text-xs font-medium disabled:opacity-50"
            >
              <FiCopy className={`w-3.5 h-3.5 ${copyingRich ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">{copyingRich ? "编译中" : "复制富文本"}</span>
            </button>

            <button
              type="button"
              onClick={() => setShowWechatModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs shadow-md transition-all active:scale-95 cursor-pointer whitespace-nowrap"
            >
              <FiSend className="w-3.5 h-3.5" />
              <span>推送到草稿</span>
            </button>
          </div>
        </div>

        {/* Row 2: 主题色圆点选择器 与 统计元信息 */}
        <div className="flex items-center justify-between text-[11px] text-[var(--aurora-fg3)] pt-1 border-t border-[var(--aurora-border)]/40">
          <div className="flex items-center gap-1.5">
            <span className="text-[10.5px] text-[var(--aurora-fg4)]">主题色彩:</span>
            <div className="flex items-center gap-1">
              {THEME_OPTIONS.map((th) => (
                <button
                  key={th.id}
                  type="button"
                  onClick={() => setThemeId(th.id)}
                  title={`${th.name} (${th.desc})`}
                  className={`w-5 h-5 rounded-full flex items-center justify-center transition-all cursor-pointer ${
                    themeId === th.id
                      ? "ring-2 ring-offset-1 ring-offset-[var(--aurora-surface-solid)] ring-[var(--aurora-accent)] scale-110"
                      : "opacity-60 hover:opacity-100 hover:scale-105"
                  }`}
                >
                  <span className="w-3.5 h-3.5 rounded-full shadow-inner" style={{ backgroundColor: th.color }} />
                </button>
              ))}
            </div>
            <span className="text-[10px] text-[var(--aurora-fg4)] ml-1 font-mono">
              {THEME_OPTIONS.find((t) => t.id === themeId)?.name}
            </span>
          </div>

          <div className="flex items-center gap-2 text-[10.5px] text-[var(--aurora-fg4)] font-mono">
            {isModified && (
              <button
                type="button"
                onClick={handleReset}
                title="放弃修改"
                className="text-amber-400 hover:text-red-400 hover:underline cursor-pointer"
              >
                已修改 · 重置
              </button>
            )}
            <span>{wordCount.toLocaleString()} 字 · 约 {readingTime} 分钟</span>
          </div>
        </div>
      </div>

      {/* 快速章节跳转锚点胶囊导航 */}
      {viewMode !== "edit" && headings.length > 1 && (
        <div className="flex items-center gap-1.5 overflow-x-auto py-1 px-1 text-[11px] no-scrollbar shrink-0 select-none">
          <span className="text-[var(--aurora-fg4)] text-[10px] shrink-0 font-medium">快速导览:</span>
          {headings.map((h: { raw: string; clean: string }, i: number) => (
            <button
              key={i}
              type="button"
              onClick={() => handleScrollToHeading(h.clean)}
              className="px-2 py-0.5 rounded-md bg-[var(--aurora-chip)]/60 hover:bg-[var(--aurora-chip)] text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] border border-[var(--aurora-border)]/50 shrink-0 transition-colors cursor-pointer text-[10.5px]"
            >
              {h.clean}
            </button>
          ))}
        </div>
      )}

      {/* 主体展示区域 */}
      {viewMode === "edit" ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-[11px] text-[var(--aurora-fg3)] px-1">
            <span>正文实时编辑润色中，草稿已自动本地持久化；完成后可切回「排版预览」或「微信真机」检查</span>
            <span className="font-mono text-[10.5px] text-emerald-400">● 实时编辑中</span>
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={22}
            placeholder="在工作台中直接调整与润色正文 Markdown..."
            className="w-full p-4 rounded-xl bg-[var(--aurora-bg)] border border-[var(--aurora-border)] text-[var(--aurora-fg1)] font-mono text-[12.5px] leading-relaxed resize-y focus:outline-none focus:border-[var(--aurora-accent)] transition-colors select-text"
            style={{ minHeight: "420px" }}
          />
        </div>
      ) : viewMode === "mobile" ? (
        <div className="flex justify-center py-4 px-2 bg-gradient-to-b from-black/40 via-black/20 to-black/40 rounded-3xl border border-[var(--aurora-border)]/40 select-text overflow-hidden">
          {/* iPhone 16 Pro 机身模拟容器 */}
          <div className="w-full max-w-[375px] rounded-[48px] overflow-hidden border-[8px] border-slate-800 bg-[#ffffff] text-[#222222] shadow-[0_25px_60px_-15px_rgba(0,0,0,0.7)] flex flex-col transition-all">
            {/* 顶部灵动岛与状态栏 */}
            <div className="pt-3 px-6 pb-2 bg-white flex items-center justify-between text-[11px] font-semibold text-black select-none shrink-0">
              <span className="font-mono">09:41</span>
              {/* 微灵动岛 */}
              <div className="w-24 h-5 bg-black rounded-full flex items-center justify-end pr-2 gap-1.5 shadow-sm">
                <span className="w-2 h-2 rounded-full bg-emerald-500/80 animate-pulse" />
                <span className="w-2.5 h-2.5 rounded-full bg-slate-900 border border-slate-800" />
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                <span>5G</span>
                <span className="w-4 h-2 border border-black rounded-xs inline-block relative after:absolute after:inset-0.5 after:bg-black after:rounded-2xs" />
              </div>
            </div>

            {/* 微信公众号文章顶部导航栏 */}
            <div className="px-4 py-2 border-b border-black/5 flex items-center justify-between text-xs text-slate-800 select-none bg-white shrink-0">
              <div className="flex items-center gap-1 text-[#576b95] font-medium cursor-pointer">
                <span>‹</span>
                <span>公众号</span>
              </div>
              <span className="font-semibold text-xs text-slate-900 truncate max-w-[160px]">
                Memento 心智体
              </span>
              <span className="text-slate-500 tracking-widest font-bold">•••</span>
            </div>

            {/* 文章首部：大标题、作者、发布时间、原创标识 */}
            <div className="px-5 pt-4 pb-2 bg-white text-left shrink-0">
              <h1 className="text-xl font-bold leading-snug tracking-tight text-[#111111]">
                {content.split("\n")[0].replace(/^[#\s]+/, "") || "公众号推文"}
              </h1>
              <div className="text-[12px] text-slate-400 flex items-center gap-2 mt-3 flex-wrap">
                <span className="font-medium text-[#576b95]">Memento</span>
                <span>•</span>
                <span>发表于北京</span>
                <span className="text-[10.5px] px-1.5 py-0.2 rounded bg-emerald-50 text-emerald-700 font-medium border border-emerald-200/60">
                  原创
                </span>
              </div>
            </div>

            {/* 微信公众号官方名片 / 关注条 */}
            <div className="mx-5 my-2 p-2.5 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-2.5 min-w-0">
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-black shadow-sm shrink-0"
                  style={{ backgroundColor: activeTheme.color }}
                >
                  M
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-xs text-slate-900 truncate">Memento 官方</span>
                    <span className="px-1 py-0.2 rounded text-[9px] bg-blue-50 text-blue-600 font-medium border border-blue-200/50">
                      认证
                    </span>
                  </div>
                  <div className="text-[10.5px] text-slate-400 truncate">
                    数字心智孪生体 · 仿生昼夜节律
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setFollowed((v) => !v);
                  showInAppToast(followed ? "已取消关注" : "已关注 Memento 官方公众号", "在真机视口中仿真关注交互");
                }}
                className="px-2.5 py-1 rounded-full text-[11px] font-semibold border text-white shadow-xs shrink-0 transition-transform active:scale-95 cursor-pointer"
                style={{
                  backgroundColor: followed ? "#94a3b8" : activeTheme.color,
                  borderColor: followed ? "#94a3b8" : activeTheme.color,
                }}
              >
                {followed ? "已关注" : "+ 关注"}
              </button>
            </div>

            {/* 2.35:1 官方首图卡片 */}
            <div
              className="mx-5 my-2 rounded-2xl overflow-hidden shadow-md relative text-white p-4 min-h-[120px] flex flex-col justify-end shrink-0 border border-black/5"
              style={{
                background: `linear-gradient(135deg, #090d16 0%, ${activeTheme.color}38 50%, #090d16 100%)`,
                boxShadow: `0 10px 25px -5px ${activeTheme.color}22`,
              }}
            >
              <div className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded-full bg-black/40 backdrop-blur-md text-[9px] text-white/80 font-mono">
                2.35:1 封面预演
              </div>
              <div
                className="text-[10px] font-semibold mb-1"
                style={{ color: activeTheme.color }}
              >
                ★ MEMENTO · 深度心智特稿
              </div>
              <p className="text-sm font-bold text-white leading-snug drop-shadow-md line-clamp-2">
                {content.split("\n")[0].replace(/^[#\s]+/, "") || "公众号推文"}
              </p>
            </div>

            {/* 文章正文 (微信官方标准排版：白底深灰字，15px，1.75行高，CSS变量随所选主题动态注入) */}
            <div
              className="px-5 py-3 overflow-y-auto max-h-[580px] text-[14px] leading-[1.8] text-[#2c3e50] font-sans select-text text-left prose prose-slate max-w-none prose-headings:text-slate-900 prose-p:my-2 prose-blockquote:my-3"
              style={{
                ["--aurora-accent" as any]: activeTheme.color,
                ["--aurora-accent-soft" as any]: `${activeTheme.color}18`,
                ["--aurora-border" as any]: "#e2e8f0",
                ["--aurora-surface-solid" as any]: "#f8fafc",
                ["--aurora-fg1" as any]: "#1e293b",
                ["--aurora-fg2" as any]: "#334155",
                ["--aurora-fg3" as any]: "#64748b",
                ["--aurora-chip" as any]: "#f1f5f9",
              }}
            >
              <MarkdownViewer content={content} />
            </div>

            {/* 微信底部互动工具栏 */}
            <div className="px-5 py-3 border-t border-black/5 bg-[#fafafa] text-[11px] text-slate-500 flex items-center justify-between select-none shrink-0">
              <span className="text-slate-400">阅读 10万+</span>
              <div className="flex items-center gap-4 text-slate-700">
                <span className="hover:text-emerald-600 cursor-pointer">分享 1,280</span>
                <span className="hover:text-emerald-600 cursor-pointer">赞 3,540</span>
                <span className="font-semibold text-emerald-600 flex items-center gap-0.5 cursor-pointer">
                  <span>在看 920</span>
                </span>
              </div>
            </div>

            {/* iPhone 底部安全条 */}
            <div className="h-4 bg-white flex items-center justify-center shrink-0">
              <div className="w-32 h-1 bg-slate-300 rounded-full" />
            </div>
          </div>
        </div>
      ) : (
        <div className="p-4 sm:p-5 bg-[var(--aurora-surface-solid)]/95 rounded-xl border border-[var(--aurora-border)] overflow-x-hidden text-left">
          <MarkdownViewer content={content} />
        </div>
      )}

      {/* 微信公众号官方草稿发布弹层 */}
      <WeChatPublishModal
        isOpen={showWechatModal}
        onClose={() => setShowWechatModal(false)}
        markdown={content}
        defaultTitle={item.title}
        initialThemeId={themeId}
      />
    </div>
  );
}
