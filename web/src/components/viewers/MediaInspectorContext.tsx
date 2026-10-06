"use client";

import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { detectMediaType, getFilenameFromUrl, isLocalFilePath, safeDecodePath, type MediaType } from "./MediaPreview";

export interface MediaItem {
  id: string;
  url: string;
  title: string;
  type: MediaType;
  localPath?: string | null;
}

interface MediaInspectorContextType {
  mediaList: MediaItem[];
  activeMedia: MediaItem | null;
  isOpen: boolean;
  openMedia: (item: MediaItem) => void;
  openMediaByUrl: (url: string, title?: string) => void;
  closeInspector: () => void;
  toggleInspector: () => void;
  selectIndex: (index: number) => void;
  nextMedia: () => void;
  prevMedia: () => void;
  registerMedia: (item: { url: string; title?: string; type?: MediaType; localPath?: string | null; id?: string }) => void;
  syncTurnsMedia: (turns: Array<{ content?: string | null; role?: string | null }>) => void;
}

const MediaInspectorContext = createContext<MediaInspectorContextType | null>(null);

/**
 * Scan Markdown string to discover media links (video, audio, image, pdf).
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
  const pathRegex = /(?:^|\s)((\/|file:\/\/|[a-zA-Z]:[/\\])[^\s"'>\)]+\.(mp4|webm|mov|mkv|m4v|mp3|wav|m4a|png|jpg|jpeg|gif|webp|pdf))(?:\s|$)/gi;
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

  const activeMedia = useMemo(() => {
    if (!activeId) return mediaList[0] || null;
    return mediaList.find((m) => m.id === activeId) || mediaList[0] || null;
  }, [mediaList, activeId]);

  const registerMedia = useCallback(
    (item: { url: string; title?: string; type?: MediaType; localPath?: string | null; id?: string }) => {
    setMediaList((prev) => {
      const cleanUrl = safeDecodePath(item.url);
      const existing = prev.find((m) => safeDecodePath(m.url) === cleanUrl);
      if (existing) {
        return prev;
      }
      const newItem: MediaItem = {
        id: item.id || `media-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        url: item.url,
        title: item.title || getFilenameFromUrl(item.url),
        type: item.type || detectMediaType(item.url),
        localPath: isLocalFilePath(item.url) ? safeDecodePath(item.url.replace(/^file:\/\//, "")) : null,
      };
      return [...prev, newItem];
    });
  }, []);

  const openMedia = useCallback((item: MediaItem) => {
    registerMedia(item);
    setActiveId(item.id);
    setIsOpen(true);
  }, [registerMedia]);

  const openMediaByUrl = useCallback((url: string, title?: string) => {
    const cleanUrl = safeDecodePath(url);
    const existing = mediaList.find((m) => safeDecodePath(m.url) === cleanUrl);
    if (existing) {
      setActiveId(existing.id);
      setIsOpen(true);
      return;
    }
    const type = detectMediaType(url);
    const newItem: MediaItem = {
      id: `media-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      url,
      title: title || safeDecodePath(getFilenameFromUrl(url)),
      type,
      localPath: isLocalFilePath(url) ? safeDecodePath(url.replace(/^file:\/\//, "")) : null,
    };
    setMediaList((prev) => [...prev, newItem]);
    setActiveId(newItem.id);
    setIsOpen(true);
  }, [mediaList]);

  const closeInspector = useCallback(() => {
    setIsOpen(false);
  }, []);

  const toggleInspector = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const selectIndex = useCallback((index: number) => {
    if (index >= 0 && index < mediaList.length) {
      setActiveId(mediaList[index].id);
      setIsOpen(true);
    }
  }, [mediaList]);

  const nextMedia = useCallback(() => {
    if (mediaList.length === 0) return;
    const currentIndex = activeMedia ? mediaList.findIndex((m) => m.id === activeMedia.id) : -1;
    const nextIdx = (currentIndex + 1) % mediaList.length;
    setActiveId(mediaList[nextIdx].id);
  }, [mediaList, activeMedia]);

  const prevMedia = useCallback(() => {
    if (mediaList.length === 0) return;
    const currentIndex = activeMedia ? mediaList.findIndex((m) => m.id === activeMedia.id) : 0;
    const prevIdx = (currentIndex - 1 + mediaList.length) % mediaList.length;
    setActiveId(mediaList[prevIdx].id);
  }, [mediaList, activeMedia]);

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
      // Merge discovered with existing, preserving items user opened manually
      const prevMap = new Map(prev.map((m) => [safeDecodePath(m.url), m]));
      for (const d of discovered) {
        if (!prevMap.has(safeDecodePath(d.url))) {
          prevMap.set(safeDecodePath(d.url), d);
        }
      }
      return Array.from(prevMap.values());
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
