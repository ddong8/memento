"use client";

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { detectMediaType, getFilenameFromUrl, isLocalFilePath, safeDecodePath, type MediaType } from "./MediaPreview";

export interface MediaItem {
  id: string;
  url: string;
  title: string;
  type: MediaType;
  localPath?: string | null;
  content?: string | null;
}

interface MediaInspectorContextType {
  mediaList: MediaItem[];
  activeMedia: MediaItem | null;
  isOpen: boolean;
  openMedia: (item: MediaItem) => void;
  openMediaByUrl: (url: string, title?: string, content?: string | null) => void;
  closeInspector: () => void;
  toggleInspector: () => void;
  selectIndex: (index: number) => void;
  nextMedia: () => void;
  prevMedia: () => void;
  registerMedia: (item: { url: string; title?: string; type?: MediaType; localPath?: string | null; id?: string; content?: string | null }) => void;
  syncTurnsMedia: (turns: Array<{ content?: string | null; role?: string | null }>) => void;
}

const MediaInspectorContext = createContext<MediaInspectorContextType | null>(null);

/**
 * Scan Markdown string to discover media links (video, audio, image, pdf, markdown).
 */
export function extractMediaFromMarkdown(text: string): Array<{ url: string; title: string; type: MediaType }> {
  const list: Array<{ url: string; title: string; type: MediaType }> = [];
  if (!text) return list;

  const seenUrls = new Set<string>();

  // 1. Markdown link / image syntax: [title](url) or ![alt](url)
  const linkRegex = /!?\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(text)) !== null) {
    const rawTitle = match[1]?.trim();
    const rawUrl = match[2]?.trim();
    if (!rawUrl) continue;
    const cleanUrl = rawUrl.split(" ")[0]; // handle possible markdown titles like (url "title")
    const type = detectMediaType(cleanUrl);
    if (type !== "unknown" && !seenUrls.has(cleanUrl)) {
      seenUrls.add(cleanUrl);
      const decodedTitle = safeDecodePath(rawTitle || getFilenameFromUrl(cleanUrl));
      list.push({ url: cleanUrl, title: decodedTitle || "media-file", type });
    }
  }

  // 2. Direct absolute path or file:// occurrences on a line
  const pathRegex = /(?:^|\s)((\/|file:\/\/|[a-zA-Z]:[/\\])[^\s"'>\)]+\.(mp4|webm|mov|mkv|m4v|mp3|wav|m4a|png|jpg|jpeg|gif|webp|pdf|md|markdown))(?:\s|$)/gi;
  while ((match = pathRegex.exec(text)) !== null) {
    const rawUrl = match[1]?.trim();
    if (rawUrl && !seenUrls.has(rawUrl)) {
      const type = detectMediaType(rawUrl);
      if (type !== "unknown") {
        seenUrls.add(rawUrl);
        list.push({ url: rawUrl, title: safeDecodePath(getFilenameFromUrl(rawUrl)), type });
      }
    }
  }

  return list;
}

export function MediaInspectorProvider({ children }: { children: React.ReactNode }) {
  const [mediaList, setMediaList] = useState<MediaItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState<boolean>(false);

  const userManuallyClosedRef = useRef<boolean>(false);

  const activeMedia = useMemo(() => {
    if (!activeId) return mediaList[0] || null;
    return mediaList.find((m) => m.id === activeId) || mediaList[0] || null;
  }, [mediaList, activeId]);

  const registerMedia = useCallback(
    (item: { url: string; title?: string; type?: MediaType; localPath?: string | null; id?: string; content?: string | null }) => {
      setMediaList((prev) => {
        const cleanUrl = safeDecodePath(item.url);
        const exists = prev.some((m) => safeDecodePath(m.url) === cleanUrl);
        if (exists) {
          return prev; // 引用不变，杜绝无意义重渲染
        }
        const newItem: MediaItem = {
          id: item.id || `media-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          url: item.url,
          title: item.title || getFilenameFromUrl(item.url),
          type: item.type || detectMediaType(item.url),
          localPath: isLocalFilePath(item.url) ? safeDecodePath(item.url.replace(/^file:\/\//, "")) : null,
          content: item.content || null,
        };
        return [...prev, newItem];
      });
    },
    []
  );

  const openMedia = useCallback((item: MediaItem) => {
    userManuallyClosedRef.current = false;
    setMediaList((prev) => {
      const cleanUrl = safeDecodePath(item.url);
      const exists = prev.some((m) => safeDecodePath(m.url) === cleanUrl);
      if (exists) {
        setActiveId(item.id);
        setIsOpen(true);
        return prev;
      }
      setActiveId(item.id);
      setIsOpen(true);
      return [...prev, item];
    });
  }, []);

  const openMediaByUrl = useCallback((url: string, title?: string, content?: string | null) => {
    userManuallyClosedRef.current = false;
    const cleanUrl = safeDecodePath(url);
    setMediaList((prev) => {
      const existing = prev.find((m) => safeDecodePath(m.url) === cleanUrl);
      if (existing) {
        if (content && !existing.content) {
          existing.content = content;
        }
        setActiveId(existing.id);
        setIsOpen(true);
        return prev; // 引用不变
      }
      const type = detectMediaType(url);
      const newItem: MediaItem = {
        id: `media-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        url,
        title: title || safeDecodePath(getFilenameFromUrl(url)),
        type,
        localPath: isLocalFilePath(url) ? safeDecodePath(url.replace(/^file:\/\//, "")) : null,
        content: content || null,
      };
      setActiveId(newItem.id);
      setIsOpen(true);
      return [...prev, newItem];
    });
  }, []);

  const closeInspector = useCallback(() => {
    userManuallyClosedRef.current = true;
    setIsOpen(false);
  }, []);

  const toggleInspector = useCallback(() => {
    setIsOpen((prev) => {
      const next = !prev;
      if (!next) {
        userManuallyClosedRef.current = true;
      } else {
        userManuallyClosedRef.current = false;
      }
      return next;
    });
  }, []);

  const selectIndex = useCallback((index: number) => {
    userManuallyClosedRef.current = false;
    setMediaList((list) => {
      if (index >= 0 && index < list.length) {
        setActiveId(list[index].id);
        setIsOpen(true);
      }
      return list;
    });
  }, []);

  const nextMedia = useCallback(() => {
    setMediaList((list) => {
      if (list.length === 0) return list;
      setActiveId((currId) => {
        const idx = currId ? list.findIndex((m) => m.id === currId) : 0;
        const nextIdx = (idx + 1) % list.length;
        return list[nextIdx].id;
      });
      return list;
    });
  }, []);

  const prevMedia = useCallback(() => {
    setMediaList((list) => {
      if (list.length === 0) return list;
      setActiveId((currId) => {
        const idx = currId ? list.findIndex((m) => m.id === currId) : 0;
        const prevIdx = (idx - 1 + list.length) % list.length;
        return list[prevIdx].id;
      });
      return list;
    });
  }, []);

  const syncTurnsMedia = useCallback((turns: Array<{ content?: string | null; role?: string | null }>) => {
    const discovered: MediaItem[] = [];
    const seen = new Set<string>();

    for (const turn of turns) {
      if (!turn.content) continue;
      const extracted = extractMediaFromMarkdown(turn.content);
      for (const item of extracted) {
        const key = safeDecodePath(item.url);
        if (!seen.has(key)) {
          seen.add(key);
          discovered.push({
            id: `media-turn-${key}`,
            url: item.url,
            title: item.title,
            type: item.type,
            localPath: isLocalFilePath(item.url) ? safeDecodePath(item.url.replace(/^file:\/\//, "")) : null,
          });
        }
      }
    }

    setMediaList((prev) => {
      // 深度比对 discovered 和 prev 是否相同，若完全相同则返回原 prev 引用，彻底杜绝死循环
      let isSame = prev.length === discovered.length;
      if (isSame) {
        for (let i = 0; i < prev.length; i++) {
          if (safeDecodePath(prev[i].url) !== safeDecodePath(discovered[i].url)) {
            isSame = false;
            break;
          }
        }
      }

      // 如果有媒体，且用户未在当前会话显式关闭，自动展开为第三栏视窗 (仅在大屏桌面端自动停靠，移动端不遮挡主对话)
      if (discovered.length > 0) {
        if (!userManuallyClosedRef.current) {
          const isDesktopLarge = typeof window !== "undefined" ? window.innerWidth >= 1024 : true;
          if (isDesktopLarge) {
            setIsOpen(true);
          }
        }
      } else {
        // 当前对话无媒体，重置手动关闭状态并收起第三栏
        userManuallyClosedRef.current = false;
        setIsOpen(false);
      }

      if (isSame) {
        return prev; // 返回同一引用，React 绝对不会重新触发渲染！
      }
      return discovered;
    });
  }, []);

  const value = useMemo(
    () => ({
      mediaList,
      activeMedia,
      isOpen,
      openMedia,
      openMediaByUrl,
      closeInspector,
      toggleInspector,
      selectIndex,
      nextMedia,
      prevMedia,
      registerMedia,
      syncTurnsMedia,
    }),
    [
      mediaList,
      activeMedia,
      isOpen,
      openMedia,
      openMediaByUrl,
      closeInspector,
      toggleInspector,
      selectIndex,
      nextMedia,
      prevMedia,
      registerMedia,
      syncTurnsMedia,
    ]
  );

  return <MediaInspectorContext.Provider value={value}>{children}</MediaInspectorContext.Provider>;
}

export function useMediaInspector() {
  const ctx = useContext(MediaInspectorContext);
  return ctx;
}
