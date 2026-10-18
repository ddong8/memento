"use client";

import { Suspense, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { getApiBase, authFetch, api, DeviceSummary, AskConversationSummary, ProjectSummary, seedApiEtagCache, invalidateApiCache, type AskConversationDetail, type AgentQuotasResponse, type ProjectDevice } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { Icon, ToolGlyph } from "@/components/aurora/Icon";
import { BrandMark } from "@/components/aurora/BrandMark";
import { Btn, Chip, Glass, GhostInput, TopBar } from "@/components/aurora/primitives";
import { showInAppToast } from "@/lib/native-notify";
import MarkdownViewer, { stripTransientStatusPrefix } from "@/components/viewers/MarkdownViewer";
import { MediaInspectorProvider, useMediaInspector } from "@/components/viewers/MediaInspectorContext";
import { ExecutionTabs, ToolCallItem } from "@/components/ExecutionCard";
import { mergeTaskEvent, type TaskEvent } from "@memento/core";

const MediaInspectorPanel = dynamic(
  () => import("@/components/viewers/MediaInspectorPanel").then((m) => m.MediaInspectorPanel),
  { ssr: false }
);
const AgentQuotaPopover = dynamic(
  () => import("@/components/quota/AgentQuotaPopover").then((m) => m.AgentQuotaPopover),
  { ssr: false }
);
const ShareModal = dynamic(
  () => import("@/components/ShareModal").then((m) => m.ShareModal),
  { ssr: false }
);


import type { AgentCapabilities, AgentModelOption, AgentEffortOption } from "@/lib/api-client";
import { AssistantBubble, UserBubble } from "@/components/ask/bubbles";
import { CONVERSATIONS_CACHE_KEY, CachedAskState, FALLBACK_AGENT_MODELS, LocalConvSnapshot, QUOTAS_CACHE_KEY, SNAPSHOT_KEY, conversationTurnsCache, getCachedConversations, getCachedProjects, getCachedSessions, getImmediateCapabilities, getLocalCachedQuotas, getLocalConvSnapshot, isUuidOrHash, prefetchConversationTurns, resolveSafeProjectName, saveCachedProjects, saveCachedSessions, saveCapabilitiesCache, saveLocalConvSnapshot, saveToRecentConvTurnsCache } from "@/lib/ask/cache";
import { cleanProjectPath, homeDeviceOf, isConcreteDevice, isDeviceOnline, pathWithin, projectPathOn } from "@/lib/ask/devices";
import { ExecutionMode, RunCursor, Source, Turn, compressImageToDataUrl, formatExcerpt, formatRelativeTime, interruptibleSleep, normalizeEpochMs, normalizeIsoTimestamp } from "@/lib/ask/turns";









// Module-level in-memory cache to preserve state when switching menus in-app
let askCache: CachedAskState | null = null;

function AskPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const idParam = searchParams.get("id");
  const initialSnapshotRef = useRef<LocalConvSnapshot | null>(null);
  if (initialSnapshotRef.current === null && !askCache) {
    if (typeof window !== "undefined") {
      const snap = getLocalConvSnapshot();
      if (snap && Boolean(idParam && idParam === snap.id)) {
        initialSnapshotRef.current = snap;
        if (snap.etag && snap.convDetail) {
          seedApiEtagCache(`/api/ask/conversations/${snap.id}?limit=40`, snap.etag, snap.convDetail);
          seedApiEtagCache(`/api/ask/conversations/${snap.id}`, snap.etag, snap.convDetail);
        }
      }
    }
  }
  const initSnap = initialSnapshotRef.current;
  const initialRestoredFromSnapshotRef = useRef<boolean>(Boolean(initSnap));

  const inspector = useMediaInspector();
  const syncTurnsMedia = inspector?.syncTurnsMedia;
  const [turns, setTurns] = useState<Turn[]>(() => askCache?.turns || initSnap?.turns || []);

  const [input, setInput] = useState(() => askCache?.input || "");
  const [streaming, setStreaming] = useState<boolean>(() => Boolean(askCache?.streaming || askCache?.activeRun));
  const [isReconnecting, setIsReconnecting] = useState<boolean>(false);

  // 自动将当前对话所有轮次中的媒体同步至右侧独立视窗列表中（流式输出期间跳过逐帧全量正则扫描，流式结束或会话加载时立即同步）
  useEffect(() => {
    if (streaming) return;
    syncTurnsMedia?.(turns);
  }, [turns, streaming, syncTurnsMedia]);
  const lastSentQuestionRef = useRef<string>(askCache?.activeRun?.question || "");
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>(
    () => askCache?.selectedDevice || initSnap?.selectedDevice || (typeof window !== "undefined" ? localStorage.getItem("memento_last_device") : null) || "auto"
  );
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(
    () => askCache?.executionMode || initSnap?.executionMode || (typeof window !== "undefined" ? (localStorage.getItem("memento_last_execution_mode") as ExecutionMode) : null) || "claude"
  );
  const [cwd, setCwd] = useState<string>(() => askCache?.cwd || initSnap?.cwd || "");
  const [showCwd, setShowCwd] = useState<boolean>(false);
  const pathname = usePathname();
  const prevPathnameRef = useRef<string>(pathname);
  const chatScrollRef = useRef<HTMLDivElement>(null);



  // Agent Context: Model, Project & Session selection
  const [selectedModel, setSelectedModel] = useState<string>(() => askCache?.selectedModel || initSnap?.selectedModel || "");
  /** Run agent tasks in their own git worktree and branch. */
  const [worktreeMode, setWorktreeMode] = useState<boolean>(() => askCache?.worktreeMode ?? initSnap?.worktreeMode ?? false);
  const [selectedEffort, setSelectedEffort] = useState<string>(() => askCache?.selectedEffort || initSnap?.selectedEffort || "");
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(
    () => askCache?.capabilities || getImmediateCapabilities(initSnap?.executionMode || "ai", initSnap?.selectedDevice)
  );
  const [isCustomModel, setIsCustomModel] = useState<boolean>(false);
  const [projects, setProjects] = useState<ProjectSummary[]>(() => askCache?.projects || []);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => askCache?.selectedProjectId || initSnap?.selectedProjectId || "");
  const [selectedProjectTitle, setSelectedProjectTitle] = useState<string>(
    () => askCache?.projectTitle || initSnap?.selectedProjectTitle || ""
  );
  const [sessions, setSessions] = useState<
    Array<{
      session_id: string;
      title: string;
      conversation_id: string;
      message_count: number;
      timestamp: string;
      file_size_bytes?: number;
      estimated_tokens?: number;
      compact_recommended?: boolean;
      device_id?: string | null;
      device_name?: string | null;
      messages?: Array<{
        role: string;
        content: string;
        timestamp?: string;
        raw_type?: string;
        subagent_name?: string;
      }>;
    }>
  >(() => askCache?.sessions || []);
  const [selectedSessionId, setSelectedSessionId] = useState<string>(
    () => (idParam ? (askCache?.selectedSessionId || initSnap?.selectedSessionId || "") : "")
  );
  const [compactMode, setCompactMode] = useState<boolean>(() => askCache?.compactMode || false);
  const [hasMoreTurns, setHasMoreTurns] = useState<boolean>(() => askCache?.hasMoreTurns ?? initSnap?.hasMoreTurns ?? false);
  const [totalTurns, setTotalTurns] = useState<number>(() => askCache?.totalTurns ?? initSnap?.totalTurns ?? (initSnap?.turns?.length || 0));
  const [loadingMoreTurns, setLoadingMoreTurns] = useState<boolean>(false);
  const [loadingSessions, setLoadingSessions] = useState<boolean>(false);
  const [showSessionContext, setShowSessionContext] = useState<boolean>(true);
  const [isConfigCollapsed, setIsConfigCollapsed] = useState<boolean>(false);
  const [attachedImages, setAttachedImages] = useState<
    Array<{ id: string; name: string; dataUrl: string; size: number }>
  >([]);
  const [isDraggingOver, setIsDraggingOver] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastPasteTimeRef = useRef<number>(0);

  const addFilesAsImages = useCallback(async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    const newImgs: Array<{ id: string; name: string; dataUrl: string; size: number }> = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.type.startsWith("image/")) continue;
      try {
        const dataUrl = await compressImageToDataUrl(file);
        newImgs.push({ id: crypto.randomUUID(), name: file.name || "image.png", dataUrl, size: file.size });
      } catch (err) {
        console.error("Failed to compress image:", err);
      }
    }
    if (newImgs.length > 0) {
      setAttachedImages((prev) => {
        const existingUrls = new Set(prev.map((img) => img.dataUrl));
        const toAdd = newImgs.filter((img) => !existingUrls.has(img.dataUrl));
        return [...prev, ...toAdd];
      });
    }
  }, []);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    await addFilesAsImages(e.target.files);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [addFilesAsImages]);

  const removeAttachedImage = useCallback((id: string) => {
    setAttachedImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const handlePaste = useCallback(async (e: React.ClipboardEvent | ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    // 提取所有图片 items
    const rawImageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) rawImageFiles.push(file);
      }
    }
    if (rawImageFiles.length === 0) return;

    // 防抖：400ms 内忽略重复触发（如 React SyntheticEvent 与原生 DOM 事件冒泡重叠）
    const now = Date.now();
    if (now - lastPasteTimeRef.current < 400) {
      e.preventDefault();
      return;
    }
    lastPasteTimeRef.current = now;
    e.preventDefault();

    // Windows 剪贴板常对单次截图同时生成多种格式（如 image/png 与 image/jpeg/bmp），相同字节大小视为同一张图，去重只保留首个
    const imageFiles: File[] = [];
    const seenSizes = new Set<number>();
    for (const file of rawImageFiles) {
      if (seenSizes.has(file.size)) continue;
      seenSizes.add(file.size);
      imageFiles.push(file);
    }

    const newImgs: Array<{ id: string; name: string; dataUrl: string; size: number }> = [];
    for (const file of imageFiles) {
      try {
        const dataUrl = await compressImageToDataUrl(file);
        newImgs.push({
          id: crypto.randomUUID(),
          name: file.name || "pasted_image.png",
          dataUrl,
          size: file.size,
        });
      } catch (err) {
        console.error("Failed to process pasted image:", err);
      }
    }

    if (newImgs.length > 0) {
      setAttachedImages((prev) => {
        const existingUrls = new Set(prev.map((img) => img.dataUrl));
        const toAdd = newImgs.filter((img) => !existingUrls.has(img.dataUrl));
        return [...prev, ...toAdd];
      });
    }
  }, []);

  useEffect(() => {
    const onWindowPaste = (e: ClipboardEvent) => {
      // 若焦点在输入框/文本域内，已有 GhostInput 自身的 onPaste 处理，避免冒泡至 window 二次触发
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.defaultPrevented) return;

      const items = e.clipboardData?.items;
      if (!items) return;
      let hasImage = false;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          hasImage = true;
          break;
        }
      }
      if (hasImage) {
        handlePaste(e);
      }
    };
    window.addEventListener("paste", onWindowPaste);
    return () => window.removeEventListener("paste", onWindowPaste);
  }, [handlePaste]);

  const projectsRef = useRef<ProjectSummary[]>([]);
  projectsRef.current = projects;
  const selectedDeviceRef = useRef<string>(selectedDevice);
  selectedDeviceRef.current = selectedDevice;
  const cwdRef = useRef<string>(cwd);
  cwdRef.current = cwd;
  const autoPinnedRef = useRef<string>("");
  const executionModeRef = useRef<ExecutionMode>(executionMode);
  executionModeRef.current = executionMode;
  // loadProjectsForMode, for handleSelectProject (declared before it) to reload the list for a pinned device
  const loadProjectsRef = useRef<((mode: ExecutionMode, targetDev?: string, preferredTitle?: string) => Promise<void>) | null>(null);
  // Every list load takes a ticket; a reply to an older ticket (an earlier device, tool or project) is dropped
  const projectsReqRef = useRef(0);
  const sessionsReqRef = useRef(0);
  const capsReqRef = useRef(0);
  const selectedProjectIdRef = useRef<string>("");
  selectedProjectIdRef.current = selectedProjectId;
  const selectedProjectTitleRef = useRef<string>("");
  selectedProjectTitleRef.current = selectedProjectTitle;

  useEffect(() => {
    try {
      const saved = localStorage.getItem("memento_ask_config_collapsed");
      if (saved !== null) {
        setIsConfigCollapsed(saved === "true");
      } else if (typeof window !== "undefined" && window.innerWidth < 768) {
        setIsConfigCollapsed(true);
      }
    } catch {}
  }, []);

  const toggleConfigCollapsed = useCallback(() => {
    setIsConfigCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("memento_ask_config_collapsed", String(next));
      } catch {}
      return next;
    });
  }, []);

  // Conversation history state
  const [conversations, setConversations] = useState<AskConversationSummary[]>(() => askCache?.conversations || getCachedConversations());
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    () => askCache?.activeConversationId || (idParam ? (initSnap?.id || idParam) : null)
  );
  const activeConversationIdRef = useRef<string | null>(
    askCache?.activeConversationId || (idParam ? (initSnap?.id || idParam) : null)
  );
  const streamingRef = useRef<boolean>(Boolean(askCache?.streaming || askCache?.activeRun));
  const isRestoringRef = useRef<boolean>(false);
  const isNewChatModeRef = useRef<boolean>(false);
  const lastRestoredIdRef = useRef<string | null>(askCache?.activeConversationId || null);
  const isUnmountedRef = useRef<boolean>(false);
  const userCancelledRef = useRef<boolean>(false);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("memento_active_chat_change", { detail: { id: activeConversationId } })
      );
    }
  }, [activeConversationId]);

  const [historyOpen, setHistoryOpen] = useState<boolean>(false);
  const [historySearchQuery, setHistorySearchQuery] = useState<string>("");
  const [editingConvId, setEditingConvId] = useState<string | null>(null);
  const [editingConvTitle, setEditingConvTitle] = useState<string>("");
  const promptHistoryIdxRef = useRef<number>(-1);
  const promptDraftRef = useRef<string>("");
  const [showScrollBottom, setShowScrollBottom] = useState<boolean>(false);
  const [loadingHistory, setLoadingHistory] = useState<boolean>(false);
  const [quotaOpen, setQuotaOpen] = useState<boolean>(false);
  const [quotasData, setQuotasData] = useState<AgentQuotasResponse | null>(() => askCache?.quotasData || getLocalCachedQuotas(initSnap?.selectedDevice || selectedDevice));
  const [shareModalOpen, setShareModalOpen] = useState<boolean>(false);
  const [shareTargetId, setShareTargetId] = useState<string>("");
  const [shareTitle, setShareTitle] = useState<string>("");
  const [batchSelectMode, setBatchSelectMode] = useState<boolean>(false);
  const [selectedConvIds, setSelectedConvIds] = useState<Set<string>>(new Set());
  const [selectTurnsMode, setSelectTurnsMode] = useState<boolean>(false);
  const [selectedTurnIndices, setSelectedTurnIndices] = useState<number[]>([]);
  const [moreMenuOpen, setMoreMenuOpen] = useState<boolean>(false);

  const filteredConversations = useMemo(() => {
    const q = historySearchQuery.trim().toLowerCase();
    const list = !q
      ? conversations
      : conversations.filter((c) => {
          const matchTitle = (c.title || "").toLowerCase().includes(q);
          const matchDev = (c.device_id || "").toLowerCase().includes(q);
          const matchId = (c.id || "").toLowerCase().includes(q);
          return matchTitle || matchDev || matchId;
        });

    return [...list].sort((a, b) => {
      const aPinned = a.config?.pinned ? 1 : 0;
      const bPinned = b.config?.pinned ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      const aTime = a.updated_at ? new Date(a.updated_at).getTime() : 0;
      const bTime = b.updated_at ? new Date(b.updated_at).getTime() : 0;
      return bTime - aTime;
    });
  }, [conversations, historySearchQuery]);

  useEffect(() => {
    let cancelled = false;
    // Switching devices shows that device's last numbers (or none) until fresh ones arrive
    setQuotasData(getLocalCachedQuotas(selectedDevice));
    const fetchQuotas = async (force = false) => {
      if (!force && typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (!force && typeof window !== "undefined" && !window.location.pathname.startsWith("/ask")) return;
      try {
        const res = await api.getAgentQuotas(selectedDevice);
        if (!cancelled && res) {
          setQuotasData(res);
          try {
            const k = isConcreteDevice(selectedDevice) ? `${QUOTAS_CACHE_KEY}_${selectedDevice}` : QUOTAS_CACHE_KEY;
            localStorage.setItem(k, JSON.stringify(res));
          } catch {}
        }
      } catch {
        // ignore
      }
    };
    void fetchQuotas(true);
    const interval = setInterval(() => void fetchQuotas(false), 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedDevice]);

  const getModeQuotaSummary = (mode: ExecutionMode): { label: string; percent?: number; isPro?: boolean } | null => {
    if (mode === "antigravity") {
      const agy = quotasData?.tools?.antigravity;
      return {
        label: agy?.remaining_percent != null ? `${Math.round(agy.remaining_percent)}%` : "可用",
        percent: agy?.remaining_percent != null ? agy.remaining_percent : undefined,
        isPro: true,
      };
    }
    if (mode === "claude") {
      const c = quotasData?.tools?.claude_code;
      return {
        label: c?.remaining_percent != null ? `${Math.round(c.remaining_percent)}%` : (c?.tier || "PRO"),
        percent: c?.remaining_percent != null ? c.remaining_percent : undefined,
        isPro: (c?.tier || "PRO").toUpperCase().includes("PRO"),
      };
    }
    if (mode === "codex") {
      const cx = quotasData?.tools?.codex;
      return {
        label: cx?.tier || (cx?.plan_name ? cx.plan_name.replace("ChatGPT ", "") : "PLUS"),
        percent: cx?.remaining_percent != null ? cx.remaining_percent : undefined,
        isPro: (cx?.tier || "PRO").toUpperCase().includes("PRO") || (cx?.tier || "").toUpperCase().includes("PLUS"),
      };
    }
    if (mode === "workbuddy") {
      const wb = quotasData?.tools?.workbuddy;
      return {
        label: wb?.tier || "CN",
        percent: wb?.remaining_percent != null ? wb.remaining_percent : undefined,
        isPro: true,
      };
    }
    return null;
  };

  // Sync state continuously into in-memory cache so switching tabs/menus retains all data
  useEffect(() => {
    askCache = {
      activeConversationId,
      turns,
      input,
      conversations,
      selectedDevice,
      cwd,
      executionMode,
      selectedModel,
      selectedEffort,
      worktreeMode,
      selectedProjectId,
      selectedSessionId,
      compactMode,
      projects,
      sessions,
      capabilities,
      scrollTop: askCache?.scrollTop ?? 0,
      hasMoreTurns,
      totalTurns,
      activeRun: askCache?.activeRun,
      streaming,
      quotasData,
    };
  }, [
    activeConversationId,
    turns,
    conversations,
    selectedDevice,
    cwd,
    executionMode,
    selectedModel,
    selectedEffort,
    worktreeMode,
    selectedProjectId,
    selectedSessionId,
    compactMode,
    projects,
    sessions,
    capabilities,
    hasMoreTurns,
    totalTurns,
    streaming,
  ]);

  // Snapshot exact scroll position on unmount so switching away preserves position
  useEffect(() => {
    return () => {
      if (chatScrollRef.current && askCache) {
        askCache.scrollTop = chatScrollRef.current.scrollTop;
      }
    };
  }, []);

  // Sources drawer state
  const [sourcesOpen, setSourcesOpen] = useState<boolean>(false);
  const [selectedSources, setSelectedSources] = useState<Source[]>([]);

  const handleSourcesClick = useCallback((sources: Source[]) => {
    setSelectedSources(sources);
    setSourcesOpen(true);
    setHistoryOpen(false);
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const val = e.target.value;
    promptHistoryIdxRef.current = -1;
    setInput(val);
    if (askCache) {
      askCache.input = val;
    }
  }, []);

  const { t, locale } = useI18n();
  const isZh = locale.startsWith("zh");

  const openSingleShare = useCallback((convId: string, title?: string) => {
    setShareTargetId(convId);
    setShareTitle(title || (isZh ? "对话分享" : "Conversation Share"));
    setShareModalOpen(true);
  }, [isZh]);

  const openBatchShare = useCallback(() => {
    if (selectedConvIds.size === 0) return;
    const ids = Array.from(selectedConvIds);
    setShareTargetId(ids.join(","));
    setShareTitle(isZh ? `批量对话分享 (${ids.length}条)` : `Batch Conversations (${ids.length})`);
    setShareModalOpen(true);
  }, [selectedConvIds, isZh]);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollSettleTimersRef = useRef<NodeJS.Timeout[]>([]);
  const pendingScrollToBottomRef = useRef<boolean>(false);
  const lastStreamActivityRef = useRef<number>(Date.now());

  const scrollConversationToBottom = useCallback((instant = true) => {
    scrollSettleTimersRef.current.forEach(clearTimeout);
    scrollSettleTimersRef.current = [];

    const doScroll = () => {
      if (chatScrollRef.current && chatScrollRef.current.scrollHeight > 0) {
        chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
        if (askCache) {
          askCache.scrollTop = chatScrollRef.current.scrollTop;
        }
      }
      if (bottomRef.current) {
        try {
          bottomRef.current.scrollIntoView({
            behavior: instant ? "auto" : "smooth",
            block: "end",
          });
        } catch {}
      }
    };

    // 阶段1：立即执行首次滚动尝试
    doScroll();

    // 阶段2：连续 5 帧 requestAnimationFrame 跟踪（对抗 React 18 异步调度与挂载）
    let frames = 0;
    const rafStep = () => {
      doScroll();
      frames++;
      if (frames < 5) {
        requestAnimationFrame(rafStep);
      }
    };
    requestAnimationFrame(rafStep);

    // 阶段3：阶梯定时器持续校准（对抗 Markdown AST 解析与布局动态展开）
    const delays = [30, 80, 160, 300, 500, 800, 1200];
    delays.forEach((ms) => {
      const timer = setTimeout(() => {
        doScroll();
      }, ms);
      scrollSettleTimersRef.current.push(timer);
    });
  }, []);

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      scrollSettleTimersRef.current.forEach(clearTimeout);
    };
  }, []);

  // When returning from another menu (e.g. /memory, /inbox, /daily, /profile) back to AI Deacon:
  // Instantly restore exact scroll position (0ms) within the kept-alive DOM container
  useEffect(() => {
    const prev = prevPathnameRef.current;
    prevPathnameRef.current = pathname;
    const isNowAsk = pathname === "/ask" || pathname.startsWith("/ask/");
    const wasNotAsk = !prev || !prev.startsWith("/ask");

    if (isNowAsk && wasNotAsk) {
      if (streamingRef.current || askCache?.streaming) {
        scrollConversationToBottom(true);
      } else {
        const targetScroll = askCache?.scrollTop;
        if (typeof targetScroll === "number" && targetScroll > 0 && chatScrollRef.current) {
          chatScrollRef.current.scrollTop = targetScroll;
          requestAnimationFrame(() => {
            if (chatScrollRef.current) {
              chatScrollRef.current.scrollTop = targetScroll;
            }
          });
        }
      }
    }
  }, [pathname, scrollConversationToBottom]);

  // RAF-batched streaming: accumulate updates, flush once per frame
  const turnsRef = useRef<Turn[]>([]);
  const rafIdRef = useRef<number>(0);
  const turnsDirtyRef = useRef(false);

  const [historyFilterDevice, setHistoryFilterDevice] = useState<boolean>(false);

  // Load conversation list
  const loadConversations = useCallback(async (filterDev?: boolean) => {
    try {
      if (conversations.length === 0) {
        setLoadingHistory(true);
      }
      const shouldFilter = filterDev !== undefined ? filterDev : historyFilterDevice;
      const devId = (shouldFilter && selectedDevice && selectedDevice !== "auto" && selectedDevice !== "ask_only")
        ? selectedDevice
        : undefined;
      const list = await api.listAskConversations(devId);
      const safeList = list || [];
      setConversations(safeList);
      try {
        localStorage.setItem(CONVERSATIONS_CACHE_KEY, JSON.stringify(safeList.slice(0, 60)));
      } catch {}

      // Idle prefetch: warm top recent conversations in background for true 0ms clicks
      if (typeof window !== "undefined") {
        const prefetchRecent = () => {
          safeList.slice(0, 4).forEach((item) => {
            if (!conversationTurnsCache.has(item.id)) {
              void prefetchConversationTurns(item.id);
            }
          });
        };
        if ("requestIdleCallback" in window) {
          (window as any).requestIdleCallback(prefetchRecent, { timeout: 2500 });
        } else {
          setTimeout(prefetchRecent, 800);
        }
      }
    } catch (e) {
      console.error("Failed to load ask conversations:", e);
    } finally {
      setLoadingHistory(false);
    }
  }, [historyFilterDevice, selectedDevice, conversations.length]);

  // Declared further down; loadConversation reaches it through this ref.
  const attachRunRef = useRef<((convId: string, question: string, baseTurns: Turn[]) => Promise<void>) | null>(null);

  // Helper to persist updated configuration for current conversation if one is active
  const persistCurrentConfig = useCallback((patch: Record<string, any>) => {
    const convId = activeConversationIdRef.current;
    if (!convId || streamingRef.current || isRestoringRef.current) return;
    api.updateAskConversation(convId, patch).catch(() => {});
  }, []);

  const normalizeDeviceId = useCallback(
    (devStr?: string | null) => {
      if (!devStr || devStr === "auto" || devStr === "ask_only" || devStr === "all") return devStr || "auto";
      const clean = devStr
        .trim()
        .replace(/\s*\([^)]*\)\s*$/, "")
        .replace(/\.local$/i, "")
        .toLowerCase();
      const found = devices.find(
        (d) =>
          d.device_id === devStr ||
          d.id === devStr ||
          d.name === devStr ||
          d.name?.toLowerCase() === clean ||
          d.name
            ?.replace(/\s*\([^)]*\)\s*$/, "")
            .replace(/\.local$/i, "")
            .toLowerCase() === clean
      );
      return found ? found.device_id : devStr;
    },
    [devices]
  );

  // Defensive extraction helper to infer executionMode, model, effort, project, session, cwd, device from turns
  const inferConfigFromTurns = useCallback((turnsList: Turn[]) => {
    const res: {
      executionMode?: ExecutionMode;
      deviceId?: string;
      cwd?: string;
      projectId?: string;
      sessionId?: string;
      model?: string;
      effort?: string;
    } = {};

    for (let i = turnsList.length - 1; i >= 0; i--) {
      const turn = turnsList[i];
      const calls = turn.toolCalls || (turn as any).tool_calls || [];
      for (let j = calls.length - 1; j >= 0; j--) {
        const call = calls[j];
        if (!call) continue;

        let args: Record<string, any> = {};
        if (typeof call.args === "object" && call.args !== null) {
          args = call.args as Record<string, any>;
        } else if (typeof call.args === "string") {
          try { args = JSON.parse(call.args); } catch {}
        }

        let resObj: Record<string, any> = {};
        if (typeof call.result === "object" && call.result !== null) {
          resObj = call.result as Record<string, any>;
        } else if (typeof call.result === "string") {
          try { resObj = JSON.parse(call.result); } catch {}
        }

        let callObj: Record<string, any> = {};
        if (typeof (call as any).call === "object" && (call as any).call !== null) {
          callObj = (call as any).call as Record<string, any>;
        }

        const binary = (
          (args.binary as string) ||
          ((call as any).binary as string) ||
          (callObj.binary as string) ||
          (resObj.binary as string) ||
          ""
        ).toLowerCase().trim();

        const action = (
          (resObj.action as string) ||
          (args.action as string) ||
          (call.name === "run_on_device" ? "shell" : call.name) ||
          ""
        ).toLowerCase().trim();

        const name = (call.name || callObj.name || "").toLowerCase().trim();
        const cmd = (
          (args.command as string) ||
          (args.prompt as string) ||
          (callObj.command as string) ||
          ((call as any).command as string) ||
          ""
        ).toLowerCase().trim();

        let detectedMode: ExecutionMode | undefined;
        if (binary.includes("claude") || name === "claude" || cmd.includes("[claude")) {
          detectedMode = "claude";
        } else if (binary.includes("codex") || name === "codex" || cmd.includes("[codex")) {
          detectedMode = "codex";
        } else if (binary.includes("agy") || binary.includes("antigravity") || name === "antigravity" || cmd.includes("[antigravity") || cmd.includes("[agy")) {
          detectedMode = "antigravity";
        } else if (binary.includes("workbuddy") || name === "workbuddy" || cmd.includes("[workbuddy")) {
          detectedMode = "workbuddy";
        } else if (action === "shell" || ["bash", "sh", "zsh"].includes(binary) || cmd.includes("[shell")) {
          detectedMode = "shell";
        }

        if (detectedMode && !res.executionMode) {
          res.executionMode = detectedMode;
        }

        const pid = (args.project_id as string) || (callObj.project_id as string) || (resObj.project_id as string);
        if (pid && !res.projectId) {
          res.projectId = String(pid);
        }

        const sid = (resObj.session_id as string) || (args.session_id as string) || (callObj.session_id as string);
        if (sid && !res.sessionId) {
          res.sessionId = String(sid);
        }

        const mod = (args.model as string) || (callObj.model as string);
        if (mod && !res.model) {
          res.model = String(mod);
        }

        const eff = (args.effort as string) || (callObj.effort as string);
        if (eff && !res.effort) {
          res.effort = String(eff);
        }

        const tcCwd = (args.cwd as string) || (callObj.cwd as string);
        if (tcCwd && !res.cwd) {
          res.cwd = String(tcCwd);
        }

        const devCandidates = [
          resObj.device_id as string,
          resObj.device_name as string,
          call.device_name,
          args.device_id as string,
          callObj.device_name as string,
        ];
        for (const cand of devCandidates) {
          const trimmed = typeof cand === "string" ? cand.trim() : "";
          if (trimmed && !["auto", "ask_only", "all"].includes(trimmed.toLowerCase())) {
            if (!res.deviceId) {
              res.deviceId = trimmed;
            }
            break;
          }
        }

        if (res.executionMode && res.sessionId && res.projectId && res.deviceId) {
          return res;
        }
      }
    }
    return res;
  }, []);

  // Load single conversation
  const loadConversation = useCallback(async (id: string, options?: { limit?: number; preserveScroll?: boolean; force?: boolean }) => {
    if (!id || (streamingRef.current && !options?.force)) return;
    isNewChatModeRef.current = false;
    const limitToUse = options?.limit !== undefined ? options.limit : 40;
    const preserveScroll = options?.preserveScroll ?? false;
    isRestoringRef.current = true;
    lastRestoredIdRef.current = id;
    try {
      if (options?.force) {
        invalidateApiCache(`/api/ask/conversations/${id}`);
        abortRef.current?.abort();
        abortRef.current = null;
        streamingRef.current = false;
        setStreaming(false);
        if (askCache) {
          askCache.streaming = false;
          askCache.activeRun = null;
        }
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event("memento_wake_stream"));
        }
      }

      // 0ms Zero-Latency Navigation: If we have cached turns for this conversation, render immediately!
      const cachedConv = conversationTurnsCache.get(id);
      if (cachedConv && cachedConv.turns && cachedConv.turns.length > 0) {
        turnsRef.current = cachedConv.turns;
        setTurns(cachedConv.turns);
        activeConversationIdRef.current = id;
        setActiveConversationId(id);
        if (cachedConv.config?.executionMode) {
          setExecutionMode(cachedConv.config.executionMode);
        }
        if (cachedConv.config?.model !== undefined) {
          setSelectedModel(cachedConv.config.model);
        }
        if (cachedConv.config?.effort !== undefined) {
          setSelectedEffort(cachedConv.config.effort);
        }
        if (cachedConv.config?.cwd) {
          setCwd(cachedConv.config.cwd);
        }
        if (cachedConv.config?.selectedProjectId) {
          setSelectedProjectId(cachedConv.config.selectedProjectId);
        }
        if (cachedConv.config?.selectedProjectTitle) {
          setSelectedProjectTitle(cachedConv.config.selectedProjectTitle);
        }
        if (cachedConv.config?.selectedSessionId) {
          setSelectedSessionId(cachedConv.config.selectedSessionId);
        }
        if (cachedConv.config?.selectedDevice) {
          setSelectedDevice(cachedConv.config.selectedDevice);
        }
        setHistoryOpen(false);
        setSourcesOpen(false);
        if (!preserveScroll) {
          pendingScrollToBottomRef.current = true;
          scrollConversationToBottom(true);
        }
      }

      // Concurrently query active run status and conversation turns for instant presentation
      const [runInfo, data] = await Promise.all([
        authFetch(`${getApiBase()}/api/ask/conversations/${id}/run`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        api.getAskConversation(id, limitToUse),
      ]);
      activeConversationIdRef.current = data.id;
      setActiveConversationId(data.id);
      window.history.replaceState(null, "", `/ask?id=${data.id}`);
      try {
        localStorage.setItem("memento_last_ask_conv_id", data.id);
      } catch {}

      // 1. Device, cwd, and turns
      let targetDev = data.device_id || data.config?.device_id || "";
      let targetCwd = data.cwd || data.config?.cwd || "";
      const loadedTurns = data.turns || [];
      const hasMore = Boolean(data.has_more);
      const total = data.total_turns ?? loadedTurns.length;
      setHasMoreTurns(hasMore);
      setTotalTurns(total);

      if (askCache && (askCache.activeConversationId !== data.id || !preserveScroll)) {
        delete askCache.scrollTop;
      }
      turnsRef.current = loadedTurns;
      setTurns(loadedTurns);
      if (!preserveScroll) {
        pendingScrollToBottomRef.current = true;
        scrollConversationToBottom(true);
      }
      setHistoryOpen(false);
      setSourcesOpen(false);

      // Instantly attach live stream if task is still running on server
      if (runInfo && !runInfo.done && !runInfo.cancelled) {
        attachRunRef.current?.(data.id, runInfo.question || "", loadedTurns);
      } else {
        streamingRef.current = false;
        setStreaming(false);
        if (askCache) {
          askCache.streaming = false;
          askCache.activeRun = null;
        }
      }

      // 2. Execution mode, model, effort, project, session
      let targetMode = ((data.execution_mode || data.config?.execution_mode || "ai") as ExecutionMode);
      let targetModel = data.model || data.config?.model || "";
      let targetEffort = data.effort || data.config?.effort || "";
      let targetProjId = data.project_id || data.config?.project_id || "";
      let targetSessionId = data.session_id || data.config?.session_id || "";

      // Defensive infer if returned mode was generic "ai" or deviceId/cwd/sessionId was missing/'auto'
      const needsInfer =
        targetMode === "ai" ||
        !targetMode ||
        !targetDev ||
        targetDev === "auto" ||
        !targetProjId ||
        !targetSessionId ||
        !targetCwd;
      if (needsInfer) {
        const inferred = inferConfigFromTurns(loadedTurns);
        const prevMode = targetMode;
        const prevDev = targetDev;
        if ((targetMode === "ai" || !targetMode) && inferred.executionMode) targetMode = inferred.executionMode;
        if (!targetProjId && inferred.projectId) targetProjId = inferred.projectId;
        if (!targetSessionId && inferred.sessionId) targetSessionId = inferred.sessionId;
        if (!targetModel && inferred.model) targetModel = inferred.model;
        if (!targetEffort && inferred.effort) targetEffort = inferred.effort;
        if (!targetCwd && inferred.cwd) targetCwd = inferred.cwd;
        if ((!targetDev || targetDev === "auto") && inferred.deviceId) targetDev = inferred.deviceId;

        // Persist inferred configuration back to server DB if repaired
        if (targetMode !== prevMode || (targetDev && targetDev !== "auto" && targetDev !== prevDev)) {
          api.updateAskConversation(data.id, {
            execution_mode: targetMode,
            project_id: targetProjId,
            session_id: targetSessionId,
            model: targetModel,
            effort: targetEffort,
            cwd: targetCwd,
            device_id: targetDev,
          }).catch(() => {});
        }
      }

      const devToUse = normalizeDeviceId(targetDev) || "auto";
      setSelectedDevice(devToUse);
      if (targetCwd) {
        setCwd(targetCwd);
        setShowCwd(true);
      } else {
        setCwd("");
      }

      setExecutionMode(targetMode);
      setSelectedModel(targetModel);
      setIsCustomModel(Boolean(targetModel && !FALLBACK_AGENT_MODELS[targetMode]?.some((m) => m.id === targetModel)));
      setSelectedEffort(targetEffort);

      const isWorktree = Boolean(data.worktree ?? data.config?.worktree ?? false);
      setWorktreeMode(isWorktree);

      setCompactMode(false);

      const incomingProjTitle = data.project_title || "";
      if (incomingProjTitle && !isUuidOrHash(incomingProjTitle)) {
        setSelectedProjectTitle(incomingProjTitle);
        selectedProjectTitleRef.current = incomingProjTitle;
      }

      saveLocalConvSnapshot({
        id: data.id,
        turns: loadedTurns,
        executionMode: targetMode,
        selectedModel: targetModel,
        selectedEffort: targetEffort,
        cwd: targetCwd,
        selectedDevice: devToUse,
        selectedProjectId: targetProjId,
        selectedProjectTitle: incomingProjTitle || selectedProjectTitleRef.current,
        selectedSessionId: targetSessionId,
        worktreeMode: isWorktree,
        hasMoreTurns: hasMore,
        totalTurns: total,
        etag: data._etag,
        convDetail: data,
      });
      saveToRecentConvTurnsCache(data.id, loadedTurns, data);

      // 3. Project and Session restoration
      if (["codex", "claude", "antigravity", "workbuddy"].includes(targetMode)) {
        const toolMap: Record<string, string> = {
          codex: "codex",
          claude: "claude_code",
          antigravity: "antigravity",
          workbuddy: "workbuddy",
        };
        const toolId = toolMap[targetMode];
        if (toolId) {
          try {
            const devForQuery = isConcreteDevice(devToUse) ? devToUse : undefined;
            const projTicket = ++projectsReqRef.current;
            const sessTicket = ++sessionsReqRef.current;
            // 0ms instant hydration from this device's cache
            setProjects(getCachedProjects(toolId, devForQuery));
            if (targetProjId) {
              const cachedSess = getCachedSessions(targetProjId, devForQuery);
              if (cachedSess.length > 0) {
                setSessions(cachedSess);
                setSelectedSessionId(targetSessionId);
              }
            }
            let projList = await api.listProjects(toolId, devForQuery);
            if (projTicket !== projectsReqRef.current) return;
            if (targetProjId && (!projList || !projList.some((p) => p.id === targetProjId))) {
              try {
                const single = await api.getProject(targetProjId);
                if (single && single.id) {
                  projList = [...(projList || []), single];
                  if (single.title && !isUuidOrHash(single.title)) {
                    setSelectedProjectTitle(single.title);
                    selectedProjectTitleRef.current = single.title;
                  }
                }
              } catch {}
            }
            const projs = projList || [];
            setProjects(projs);
            saveCachedProjects(toolId, devForQuery, projs);

            let matchedProj = targetProjId ? projs.find((p) => p.id === targetProjId) : undefined;
            if (!matchedProj && targetCwd) {
              const cleanCwd = targetCwd.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
              const folderName = cleanCwd.split("/").filter(Boolean).pop();
              matchedProj = projs.find((p) => {
                if (!p.source_path) return false;
                const sp = p.source_path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
                if (sp === cleanCwd) return true;
                if (sp.endsWith(cleanCwd) || cleanCwd.endsWith(sp)) return true;
                if (sp.includes(cleanCwd) || cleanCwd.includes(sp)) return true;
                if (folderName && (p.title?.toLowerCase() === folderName || p.slug?.toLowerCase() === folderName)) return true;
                return false;
              });
            }

            if (matchedProj && matchedProj.title && !isUuidOrHash(matchedProj.title)) {
              setSelectedProjectTitle(matchedProj.title);
              selectedProjectTitleRef.current = matchedProj.title;
            }

            const effectiveProjId = matchedProj ? matchedProj.id : targetProjId;
            if (effectiveProjId) {
              setSelectedProjectId(effectiveProjId);
              selectedProjectIdRef.current = effectiveProjId;
              if (effectiveProjId !== targetProjId) {
                saveLocalConvSnapshot({
                  id: data.id,
                  turns: loadedTurns,
                  executionMode: targetMode,
                  selectedModel: targetModel,
                  selectedEffort: targetEffort,
                  cwd: targetCwd,
                  selectedDevice: devToUse,
                  selectedProjectId: effectiveProjId,
                  selectedProjectTitle: selectedProjectTitleRef.current,
                  selectedSessionId: targetSessionId,
                  worktreeMode: isWorktree,
                  hasMoreTurns: hasMore,
                  totalTurns: total,
                  etag: data._etag,
                  convDetail: data,
                });
              }
              const cachedSess = getCachedSessions(effectiveProjId, devForQuery);
              if (cachedSess.length > 0) {
                setSessions(cachedSess);
              }
              setLoadingSessions(cachedSess.length === 0);
              try {
                const res = await api.getProjectConversations(effectiveProjId, 0, 50, "desc", devForQuery);
                if (sessTicket !== sessionsReqRef.current) return;
                const sessList = res?.sessions || [];
                setSessions(sessList);
                saveCachedSessions(effectiveProjId, devForQuery, sessList);
                setSelectedSessionId(targetSessionId);
                // A conversation saved without a device runs where its session ran
                const ranOn = sessList.find((x) => (x.session_id || x.conversation_id) === targetSessionId)?.device_id;
                const pinned = ranOn ? normalizeDeviceId(ranOn) : "";
                if (!devForQuery && isConcreteDevice(pinned)) {
                  setSelectedDevice(pinned);
                  selectedDeviceRef.current = pinned;
                  const folder = targetCwd || projectPathOn(matchedProj, pinned);
                  if (folder) {
                    setCwd(folder);
                    setShowCwd(true);
                  }
                  api.updateAskConversation(data.id, { device_id: pinned, ...(folder ? { cwd: folder } : {}) }).catch(() => {});
                }
              } catch (e) {
                if (sessTicket !== sessionsReqRef.current) return;
                console.error("Failed to restore project sessions:", e);
                setSessions([]);
                setSelectedSessionId(targetSessionId);
              } finally {
                if (sessTicket === sessionsReqRef.current) setLoadingSessions(false);
              }
            } else {
              setSelectedProjectId("");
              selectedProjectIdRef.current = "";
              setSessions([]);
              setSelectedSessionId(targetSessionId);
            }
          } catch (e) {
            console.error("Failed to load projects for mode:", e);
            setProjects([]);
            setSelectedProjectId("");
            selectedProjectIdRef.current = "";
            setSessions([]);
            setSelectedSessionId(targetSessionId);
          }
        }
      } else {
        setProjects([]);
        setSelectedProjectId("");
        selectedProjectIdRef.current = "";
        setSessions([]);
        setSelectedSessionId("");
      }
    } catch (e) {
      console.error("Failed to load conversation:", e);
    } finally {
      setTimeout(() => {
        isRestoringRef.current = false;
      }, 600);
    }
  }, [inferConfigFromTurns, normalizeDeviceId]);

  // Load full history for long conversation
  const loadAllHistoryTurns = useCallback(async () => {
    const currentId = activeConversationIdRef.current;
    if (!currentId || loadingMoreTurns) return;
    setLoadingMoreTurns(true);
    try {
      const scrollEl = chatScrollRef.current;
      const prevScrollHeight = scrollEl?.scrollHeight || 0;
      const prevScrollTop = scrollEl?.scrollTop || 0;

      const data = await api.getAskConversation(currentId, 0);
      if (data.id === activeConversationIdRef.current && data.turns) {
        setTurns(data.turns);
        setHasMoreTurns(false);
        setTotalTurns(data.turns.length);

        requestAnimationFrame(() => {
          if (scrollEl) {
            const newScrollHeight = scrollEl.scrollHeight;
            scrollEl.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
          }
        });
      }
    } catch (e) {
      console.error("Failed to load all history turns:", e);
    } finally {
      setLoadingMoreTurns(false);
    }
  }, [loadingMoreTurns]);

  // Start fresh chat
  const startNewChat = useCallback(() => {
    isNewChatModeRef.current = true;
    abortRef.current?.abort();
    streamingRef.current = false;
    setStreaming(false);
    activeConversationIdRef.current = null;
    setActiveConversationId(null);
    lastRestoredIdRef.current = null;
    setSelectedSessionId("");
    setSelectedProjectId("");
    selectedProjectIdRef.current = "";
    setSelectedProjectTitle("");
    selectedProjectTitleRef.current = "";
    setSessions([]);
    setCwd("");
    setShowCwd(false);
    setCompactMode(false);
    turnsRef.current = [];
    setTurns([]);
    setInput("");

    // 采用当前系统与用户最新偏好配置，清除历史会话的私有绑定
    const latestMode = (typeof window !== "undefined" ? (localStorage.getItem("memento_last_execution_mode") as ExecutionMode) : null) || "claude";
    setExecutionMode(latestMode);
    executionModeRef.current = latestMode;
    const latestDev = (typeof window !== "undefined" ? localStorage.getItem("memento_last_device") : null) || "auto";
    setSelectedDevice(latestDev);
    selectedDeviceRef.current = latestDev;
    setSelectedModel("");
    setIsCustomModel(false);
    setSelectedEffort("");
    setWorktreeMode(false);

    try {
      router.replace("/ask");
    } catch {}
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", "/ask");
    }
    try {
      localStorage.removeItem("memento_last_ask_conv_id");
      localStorage.removeItem(SNAPSHOT_KEY);
      localStorage.removeItem("memento_last_conv_snapshot_v2");
    } catch {}
    setHasMoreTurns(false);
    setTotalTurns(0);
    askCache = null;
    setHistoryOpen(false);
    setSourcesOpen(false);
  }, [router]);

  const [exportingMd, setExportingMd] = useState(false);

  const handleExportMarkdown = useCallback(() => {
    if (!turns || turns.length === 0) return;
    setExportingMd(true);

    const activeConv = conversations.find((c) => c.id === activeConversationIdRef.current);
    const title = activeConv?.title || (turns[0]?.content ? turns[0].content.trim().slice(0, 30) : "Memento 执行研报");
    const dateStr = new Date().toISOString().slice(0, 10);
    const lines: string[] = [
      `# ${title}`,
      `> 导出时间: ${new Date().toLocaleString()} | 模式: ${executionMode} | 设备: ${selectedDevice || "auto"} | 总轮次: ${turns.length}`,
      "",
      "---",
      "",
    ];

    turns.forEach((t, i) => {
      if (t.role === "user") {
        lines.push(`### 👤 用户提问 #${Math.floor(i / 2) + 1}`);
        lines.push("");
        lines.push(t.content || "");
        if (t.images && t.images.length > 0) {
          lines.push(`\n*(包含 ${t.images.length} 张图片附件)*`);
        }
        lines.push("");
      } else {
        const modelLabel = t.model ? ` [${t.model}]` : t.execution_mode && t.execution_mode !== "ai" ? ` [${t.execution_mode}]` : "";
        const durLabel = t.duration_ms ? ` (${(t.duration_ms / 1000).toFixed(1)}s)` : "";
        lines.push(`### 🤖 AI 执事回复 #${Math.floor(i / 2) + 1}${modelLabel}${durLabel}`);
        lines.push("");
        if (t.thinking && t.thinking.trim()) {
          lines.push(`<details><summary>🧠 思考过程 (${t.thinking.trim().length} 字)</summary>\n`);
          lines.push(t.thinking.trim());
          lines.push("\n</details>\n");
        }
        if (t.toolCalls && t.toolCalls.length > 0) {
          lines.push("#### 🛠️ 设备执行记录");
          t.toolCalls.forEach((call, cidx) => {
            const cmd = (call.args?.command as string) || (call.args?.prompt as string) || call.name;
            lines.push(`- **步骤 ${cidx + 1}**: \`${call.name}\` (${call.device_name || "auto"})`);
            if (cmd) {
              lines.push("  ```bash");
              lines.push(`  ${cmd}`);
              lines.push("  ```");
            }
            if (call.result?.stdout) {
              lines.push("  <details><summary>点击查看终端输出</summary>\n");
              lines.push("  ```text");
              lines.push(call.result.stdout.slice(0, 4000));
              lines.push("  ```\n  </details>");
            }
          });
          lines.push("");
        }
        lines.push("#### 📋 总结与分析");
        lines.push("");
        lines.push(t.content || "任务执行完成。");
        lines.push("");
        lines.push("---");
        lines.push("");
      }
    });

    const mdContent = lines.join("\n");
    const blob = new Blob([mdContent], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const cleanFileName = title.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 40) || "memento-export";
    a.download = `${cleanFileName}-${dateStr}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setTimeout(() => setExportingMd(false), 1200);
  }, [turns, conversations, executionMode, selectedDevice]);

  // Rename conversation
  const renameConversation = useCallback(
    async (id: string, newTitle: string) => {
      const trimmed = newTitle.trim();
      if (!trimmed) {
        setEditingConvId(null);
        return;
      }
      try {
        await api.updateAskConversation(id, { title: trimmed });
        setConversations((prev) =>
          prev.map((c) => (c.id === id ? { ...c, title: trimmed } : c))
        );
      } catch (err) {
        console.error("Failed to rename conversation:", err);
      } finally {
        setEditingConvId(null);
      }
    },
    []
  );

  // Toggle pin conversation
  const togglePinConversation = useCallback(
    async (e: React.MouseEvent, id: string, currentPinned?: boolean) => {
      e.stopPropagation();
      const nextPinned = !currentPinned;
      setConversations((prev) =>
        prev.map((c) =>
          c.id === id
            ? { ...c, config: { ...(c.config || {}), pinned: nextPinned } }
            : c
        )
      );
      try {
        await api.updateAskConversation(id, { pinned: nextPinned });
      } catch (err) {
        console.error("Failed to toggle pin state:", err);
      }
    },
    []
  );

  // Delete conversation
  const deleteConversation = useCallback(
    async (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      if (!window.confirm(t.ask.deleteConfirm)) return;
      try {
        await api.deleteAskConversation(id);
        setConversations((prev) => prev.filter((c) => c.id !== id));
        if (activeConversationIdRef.current === id) {
          startNewChat();
        }
      } catch (e) {
        console.error("Failed to delete conversation:", e);
      }
    },
    [startNewChat, t.ask.deleteConfirm]
  );

  // Fetch online/registered devices
  useEffect(() => {
    authFetch(`${getApiBase()}/api/devices`)
      .then((r) => r.json())
      .then((d: DeviceSummary[]) => {
        setDevices(d || []);
      })
      .catch(() => setDevices([]));
  }, []);

  // Normalize selectedDevice once devices load; a conversation stuck on 'auto' takes the device its turns ran on.
  // The device picked is never changed to match the folder: the folder follows the device.
  useEffect(() => {
    if (selectedDevice && !["auto", "ask_only", "all"].includes(selectedDevice)) {
      const norm = normalizeDeviceId(selectedDevice);
      if (norm && norm !== selectedDevice) {
        setSelectedDevice(norm);
        return;
      }
    }

    if (selectedDevice === "auto") {
      if (turns.length > 0) {
        const inferred = inferConfigFromTurns(turns);
        if (inferred.deviceId) {
          const norm = normalizeDeviceId(inferred.deviceId);
          // Once per conversation and device: choosing auto again afterwards stays auto
          const pinKey = `${activeConversationIdRef.current}|${norm}`;
          if (norm && norm !== "auto" && autoPinnedRef.current !== pinKey) {
            autoPinnedRef.current = pinKey;
            setSelectedDevice(norm);
            persistCurrentConfig({ device_id: norm });
            return;
          }
        }
      }
    }
  }, [devices, turns, selectedDevice, normalizeDeviceId, inferConfigFromTurns, persistCurrentConfig]);

  // Check URL params (?id=... or ?q=...)
  const qParam = searchParams.get("q");
  const deviceParam = searchParams.get("device");
  const modeParam = searchParams.get("mode") as ExecutionMode | null;
  const initialSentRef = useRef(false);

  const loadConversationRef = useRef(loadConversation);
  loadConversationRef.current = loadConversation;
  const loadConversationsRef = useRef(loadConversations);
  loadConversationsRef.current = loadConversations;

  useEffect(() => {
    // If not currently on the /ask route (e.g. view is kept alive in background),
    // do NOT trigger checkAndRestore or re-fetch conversations!
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/ask")) {
      return;
    }

    if (conversations.length === 0) {
      loadConversationsRef.current();
    }

    const checkAndRestore = async () => {
      // 若处于明确的新建对话模式且无显式 URL 参数，彻底阻断任何自动恢复！
      if (isNewChatModeRef.current && !idParam && !qParam) {
        return;
      }
      if (idParam || qParam) {
        isNewChatModeRef.current = false;
      }

      // Determine target conversation ID:
      // 1) Explicit URL idParam
      // 2) Stored in localStorage from last session
      // 3) Currently active in askCache
      let resolvedTargetId = idParam;
      if (!resolvedTargetId && !qParam) {
        if (typeof window !== "undefined") {
          resolvedTargetId = localStorage.getItem("memento_last_ask_conv_id") || askCache?.activeConversationId || null;
        }
        if (!resolvedTargetId) {
          try {
            const recent = await api.getRecentActiveConversation();
            // 只有当服务端存在真正未结束的活跃后台任务 (active_run: true) 时才无缝挂接，绝不可把已结束的旧历史会话强加回填给新建态！
            if (recent && recent.id && recent.active_run) {
              resolvedTargetId = recent.id;
            }
          } catch {}
        }
      }

      isUnmountedRef.current = false;
      userCancelledRef.current = false;

      // Check for any active runs: start with in-memory askCache.activeRun
      let activeRunToAttach: any = askCache?.activeRun
        ? {
            conversation_id: askCache.activeRun.convId,
            question: askCache.activeRun.question,
            started_at: askCache.activeRun.startedAt,
          }
        : null;

      try {
        const runsRes = await authFetch(`${getApiBase()}/api/ask/runs`);
        if (runsRes.ok) {
          const activeRuns = await runsRes.json();
          if (Array.isArray(activeRuns)) {
            const serverMatch = resolvedTargetId
              ? activeRuns.find((r: any) => r.conversation_id === resolvedTargetId && !r.done && !r.cancelled)
              : null;
            if (serverMatch) {
              activeRunToAttach = serverMatch;
            } else if (resolvedTargetId && activeRunToAttach && activeRunToAttach.conversation_id === resolvedTargetId) {
              // Server confirmed this run is NO LONGER running!
              activeRunToAttach = null;
              streamingRef.current = false;
              setStreaming(false);
              if (askCache) {
                askCache.streaming = false;
                askCache.activeRun = null;
              }
            } else if (!activeRunToAttach && !idParam && activeRuns[0] && !activeRuns[0].done && !activeRuns[0].cancelled) {
              activeRunToAttach = activeRuns[0];
              resolvedTargetId = activeRunToAttach.conversation_id;
            }
          }
        }
      } catch (err) {
        console.error("Failed to check active runs:", err);
      }

      if (!resolvedTargetId) return;

      // If an active run is currently ongoing on the server: MUST reattach live stream!
      if (activeRunToAttach) {
        const targetConvId = activeRunToAttach.conversation_id || resolvedTargetId;
        activeConversationIdRef.current = targetConvId;
        setActiveConversationId(targetConvId);
        lastRestoredIdRef.current = targetConvId;
        initialRestoredFromSnapshotRef.current = false;
        streamingRef.current = true;
        setStreaming(true);
        if (askCache) {
          askCache.streaming = true;
          askCache.activeRun = {
            convId: targetConvId,
            question: activeRunToAttach.question || "",
            startedAt: normalizeEpochMs(activeRunToAttach.started_at),
          };
        }
        if (!idParam) {
          window.history.replaceState(null, "", `/ask?id=${targetConvId}`);
        }
        try {
          localStorage.setItem("memento_last_ask_conv_id", targetConvId);
        } catch {}

        let baseTurns = (activeConversationIdRef.current === targetConvId && turns.length > 0)
          ? turns
          : (askCache && askCache.activeConversationId === targetConvId && askCache.turns.length > 0 ? askCache.turns : []);
        try {
          const data = await api.getAskConversation(targetConvId, 40);
          if (data.turns && data.turns.length > 0 && (baseTurns.length === 0 || baseTurns.some((t) => !t.created_at))) {
            baseTurns = data.turns;
          }
          const incomingDev = data.device_id || data.config?.device_id;
          if (incomingDev && incomingDev !== "auto") {
            setSelectedDevice(normalizeDeviceId(incomingDev));
          }
          const incomingCwd = data.cwd || data.config?.cwd;
          if (incomingCwd) {
            setCwd(incomingCwd);
            setShowCwd(true);
          }
          const incomingMode = (data.execution_mode || data.config?.execution_mode) as ExecutionMode | undefined;
          if (incomingMode) setExecutionMode(incomingMode);
          const incomingModel = data.model || data.config?.model;
          if (incomingModel) setSelectedModel(incomingModel);
          const incomingEffort = data.effort || data.config?.effort;
          if (incomingEffort) setSelectedEffort(incomingEffort);
          const incomingProj = data.project_id || data.config?.project_id;
          if (incomingProj) {
            setSelectedProjectId(incomingProj);
            selectedProjectIdRef.current = incomingProj;
          }
          const incomingSess = data.session_id || data.config?.session_id;
          if (incomingSess) setSelectedSessionId(incomingSess);
        } catch {}
        attachRunRef.current?.(targetConvId, activeRunToAttach.question || "", baseTurns);
        pendingScrollToBottomRef.current = true;
        scrollConversationToBottom(true);
        return;
      }

      let forceJumpToBottom = false;
      try {
        const pendingJump = localStorage.getItem("memento_pending_jump_conv_id");
        if (pendingJump && pendingJump === resolvedTargetId) {
          forceJumpToBottom = true;
          localStorage.removeItem("memento_pending_jump_conv_id");
        }
        const sp = new URLSearchParams(window.location.search);
        if (sp.get("scroll") === "bottom") {
          forceJumpToBottom = true;
          window.history.replaceState(null, "", `/ask?id=${resolvedTargetId}`);
        }
      } catch {}

      if (forceJumpToBottom) {
        initialRestoredFromSnapshotRef.current = false;
        loadConversationRef.current(resolvedTargetId, { limit: 40, preserveScroll: false, force: true });
        return;
      }

      if (streamingRef.current) return;

      if (
        lastRestoredIdRef.current === resolvedTargetId &&
        activeConversationIdRef.current === resolvedTargetId &&
        !initialRestoredFromSnapshotRef.current &&
        !turns.some((t) => !t.created_at)
      ) {
        return;
      }

      // If already cached in memory (and not just hydrated from localStorage snapshot) with complete turns and no active background run: keep in-memory state!
      if (
        !initialRestoredFromSnapshotRef.current &&
        askCache &&
        askCache.activeConversationId === resolvedTargetId &&
        askCache.turns.length > 0 &&
        turns.length > 0 &&
        !turns.some((t) => !t.created_at)
      ) {
        lastRestoredIdRef.current = resolvedTargetId;
        const targetScroll = askCache.scrollTop;
        if (typeof targetScroll === "number" && targetScroll > 0 && chatScrollRef.current) {
          chatScrollRef.current.scrollTop = targetScroll;
          requestAnimationFrame(() => {
            if (chatScrollRef.current) {
              chatScrollRef.current.scrollTop = targetScroll;
            }
          });
        }
        return;
      }

      const preserveScroll = initialRestoredFromSnapshotRef.current;
      initialRestoredFromSnapshotRef.current = false;
      // Load conversation fresh from DB to ensure runtime mode, project, and session are properly restored!
      loadConversationRef.current(resolvedTargetId, { limit: 40, preserveScroll });
    };

    checkAndRestore();
  }, [idParam, qParam, scrollConversationToBottom]);

  // Support instantaneous chat navigation / switching via notifications or banners
  useEffect(() => {
    const handleSwitchChat = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const targetId = detail?.id;
      if (!targetId) return;

      // 0ms Zero-Latency Return: If we are already on this conversation (e.g. returning from Dynamic Island or Live Activity)
      if (activeConversationIdRef.current === targetId) {
        if (!window.location.pathname.startsWith("/ask")) {
          const pushFn = (window as any).__memento_client_push;
          if (typeof pushFn === "function") {
            pushFn(`/ask?id=${encodeURIComponent(targetId)}`);
          }
        }
        if (!detail?.preserveScroll) {
          pendingScrollToBottomRef.current = true;
          scrollConversationToBottom(true);
        }
        return;
      }

      lastRestoredIdRef.current = null;
      loadConversation(targetId, {
        force: detail?.forceReload ?? false,
        preserveScroll: detail?.scrollToBottom === false,
      });
    };
    window.addEventListener("memento_switch_chat", handleSwitchChat);

    (window as any).__memento_open_chat = (id: string) => {
      if (!id) return;
      try {
        localStorage.setItem("memento_last_ask_conv_id", id);
      } catch {}
      // 0ms Zero-Latency: If already active
      if (activeConversationIdRef.current === id) {
        if (!window.location.pathname.startsWith("/ask")) {
          const pushFn = (window as any).__memento_client_push;
          if (typeof pushFn === "function") {
            pushFn(`/ask?id=${encodeURIComponent(id)}&scroll=bottom`);
          }
        }
        pendingScrollToBottomRef.current = true;
        scrollConversationToBottom(true);
        return;
      }
      lastRestoredIdRef.current = null;
      if (!window.location.pathname.startsWith("/ask")) {
        const pushFn = (window as any).__memento_client_push;
        if (typeof pushFn === "function") {
          pushFn(`/ask?id=${encodeURIComponent(id)}&scroll=bottom`);
        }
      } else {
        window.history.pushState(null, "", `/ask?id=${encodeURIComponent(id)}`);
      }
      loadConversation(id, { force: false, preserveScroll: false });
    };

    (window as any).__memento_navigate = (url: string) => {
      if (url.includes("/ask")) {
        try {
          const parsed = new URL(url, window.location.origin);
          const id = parsed.searchParams.get("id");
          if (id) {
            try {
              localStorage.setItem("memento_last_ask_conv_id", id);
            } catch {}
            // 0ms Zero-Latency: If already on this conversation (e.g. tapping Dynamic Island)
            if (activeConversationIdRef.current === id) {
              if (!window.location.pathname.startsWith("/ask")) {
                const pushFn = (window as any).__memento_client_push;
                if (typeof pushFn === "function") {
                  pushFn(`/ask?id=${encodeURIComponent(id)}${parsed.searchParams.get("scroll") === "bottom" ? "&scroll=bottom" : ""}`);
                }
              }
              if (parsed.searchParams.get("scroll") === "bottom") {
                pendingScrollToBottomRef.current = true;
                scrollConversationToBottom(true);
              }
              return;
            }
            lastRestoredIdRef.current = null;
            if (!window.location.pathname.startsWith("/ask")) {
              const pushFn = (window as any).__memento_client_push;
              if (typeof pushFn === "function") {
                pushFn(`/ask?id=${encodeURIComponent(id)}&scroll=bottom`);
              } else {
                window.location.href = url;
                return;
              }
            } else {
              window.history.pushState(null, "", `/ask?id=${encodeURIComponent(id)}`);
            }
            loadConversation(id, { force: false, preserveScroll: false });
            return;
          }
        } catch {}
      }
      const pushFn = (window as any).__memento_client_push;
      if (typeof pushFn === "function" && url.startsWith(window.location.origin)) {
        pushFn(url.slice(window.location.origin.length) || "/");
        return;
      }
      window.location.href = url;
    };
    return () => {
      window.removeEventListener("memento_switch_chat", handleSwitchChat);
    };
  }, [loadConversation, scrollConversationToBottom]);

  // Follow the stream as tokens land & handle conversation switching auto-scroll
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitialScrollMountRef = useRef<boolean>(true);
  useEffect(() => {
    // 1. 切换会话或新加载会话：全速多阶段锁定滚动到最新位置
    if (pendingScrollToBottomRef.current) {
      pendingScrollToBottomRef.current = false;
      scrollConversationToBottom(true);
      return;
    }

    // 2. 跨菜单切回同一会话时保留阅读位置；若是全新挂载但无缓存位置则自动落到最新位置
    if (isInitialScrollMountRef.current) {
      isInitialScrollMountRef.current = false;
      const targetScroll = askCache?.scrollTop;
      if (typeof targetScroll === "number" && targetScroll > 0 && chatScrollRef.current) {
        chatScrollRef.current.scrollTop = targetScroll;
        requestAnimationFrame(() => {
          if (chatScrollRef.current) chatScrollRef.current.scrollTop = targetScroll;
        });
        return;
      }
      if (turns.length > 0) {
        scrollConversationToBottom(true);
        return;
      }
    }

    // 3. 流式生成过程中的防抖自动跟踪滚动（如果用户向上翻阅查看历史则锁定视图，不强行滚底）
    if (!streamingRef.current) return;
    if (scrollTimerRef.current) return;
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      if (streamingRef.current && chatScrollRef.current) {
        const el = chatScrollRef.current;
        const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distFromBottom > 160) return;
        el.scrollTop = el.scrollHeight;
        if (bottomRef.current) {
          bottomRef.current.scrollIntoView({ behavior: "auto", block: "end" });
        }
      }
    }, 80);
  }, [turns, activeConversationId, scrollConversationToBottom]);

  // Abort local reader if the user navigates away mid-answer, but preserve activeRun in askCache
  useEffect(() => {
    return () => {
      isUnmountedRef.current = true;
      if (streamingRef.current && activeConversationIdRef.current) {
        if (askCache) {
          askCache.streaming = true;
          askCache.activeRun = {
            convId: activeConversationIdRef.current,
            question: lastSentQuestionRef.current || "",
            startedAt: normalizeEpochMs(askCache.activeRun?.startedAt),
          };
        }
      }
      abortRef.current?.abort();
    };
  }, []);

  // Active Run Watchdog: continuously safeguards background task state across tabs and network drops
  useEffect(() => {
    let isMounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const checkServerRun = async (forceRefreshWhenIdle = false) => {
      const convId = activeConversationIdRef.current;
      if (!convId || !isMounted) return;
      if (!forceRefreshWhenIdle && typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      // When /ask is kept alive in background (user is on another menu route) and not streaming,
      // skip redundant per-conversation /run polling since ActiveRunsMonitor already polls globally.
      if (
        !forceRefreshWhenIdle &&
        typeof window !== "undefined" &&
        !window.location.pathname.startsWith("/ask") &&
        !streamingRef.current
      ) {
        return;
      }

      try {
        const runRes = await authFetch(`${getApiBase()}/api/ask/conversations/${convId}/run`);
        if (!isMounted) return;

        if (runRes.ok) {
          const run = await runRes.json();
          if (!isMounted) return;

          if (run && !run.done && !run.cancelled) {
            // Task is STILL running on server
            if (!streamingRef.current) {
              streamingRef.current = true;
              setStreaming(true);
              if (askCache) {
                askCache.streaming = true;
                askCache.activeRun = {
                  convId,
                  question: run.question || "",
                  startedAt: normalizeEpochMs(run.started_at),
                };
              }
            }

            // If local SSE reader is dead or aborted, or was zombie in background (> 5s no activity on resume), reattach to stream
            const isStreamZombie = forceRefreshWhenIdle && (Date.now() - lastStreamActivityRef.current > 5000);
            if (!abortRef.current || abortRef.current.signal.aborted || isStreamZombie) {
              if (isStreamZombie && abortRef.current) {
                try {
                  abortRef.current.abort();
                } catch {}
              }
              attachRunRef.current?.(convId, run.question || "", turnsRef.current);
              pendingScrollToBottomRef.current = true;
              scrollConversationToBottom(true);
            }
          } else if (run && run.done) {
            // Task has completed on server
            const isStreamActive = streamingRef.current && (Date.now() - lastStreamActivityRef.current < 8000) && (!abortRef.current?.signal.aborted);
            if (isStreamActive) {
              // The SSE stream is actively receiving frames from the server.
              // Do NOT abort it or race with final delta/done frames still in transit!
              return;
            }
            if (streamingRef.current || forceRefreshWhenIdle) {
              if (abortRef.current) {
                try {
                  abortRef.current.abort();
                } catch {}
              }
              const wasStreaming = streamingRef.current;
              invalidateApiCache(`/api/ask/conversations/${convId}`);
              const data = await api.getAskConversation(convId, 40).catch(() => null);
              if (isMounted && data?.turns) {
                const prevLast = turnsRef.current[turnsRef.current.length - 1];
                const nextLast = data.turns[data.turns.length - 1];
                if (prevLast?.content?.trim() && !nextLast?.content?.trim()) {
                  nextLast.content = prevLast.content;
                }
                if (prevLast?.toolCalls?.length && (!nextLast?.toolCalls || nextLast.toolCalls.length === 0)) {
                  nextLast.toolCalls = prevLast.toolCalls;
                }
                const changed =
                  wasStreaming ||
                  data.turns.length !== turnsRef.current.length ||
                  (nextLast?.content || "") !== (prevLast?.content || "") ||
                  Boolean(nextLast?.created_at) !== Boolean(prevLast?.created_at);
                turnsRef.current = data.turns;
                setTurns(data.turns);
                if (changed) {
                  pendingScrollToBottomRef.current = true;
                  scrollConversationToBottom(true);
                }
              }
              streamingRef.current = false;
              setStreaming(false);
              if (askCache) {
                askCache.streaming = false;
                askCache.activeRun = null;
              }
              if (typeof window !== "undefined") {
                window.dispatchEvent(
                  new CustomEvent("memento_ask_done", {
                    detail: { conversation_id: convId },
                  })
                );
              }
            }
          }
        } else if (runRes.status === 404 && (streamingRef.current || forceRefreshWhenIdle)) {
          // No active run on server
          const isStreamActive = streamingRef.current && (Date.now() - lastStreamActivityRef.current < 8000) && (!abortRef.current?.signal.aborted);
          if (isStreamActive) {
            return;
          }
          if (abortRef.current) {
            try {
              abortRef.current.abort();
            } catch {}
          }
          const wasStreaming = streamingRef.current;
          invalidateApiCache(`/api/ask/conversations/${convId}`);
          const data = await api.getAskConversation(convId, 40).catch(() => null);
          if (isMounted && data?.turns) {
            const prevLast = turnsRef.current[turnsRef.current.length - 1];
            const nextLast = data.turns[data.turns.length - 1];
            if (prevLast?.content?.trim() && !nextLast?.content?.trim()) {
              nextLast.content = prevLast.content;
            }
            if (prevLast?.toolCalls?.length && (!nextLast?.toolCalls || nextLast.toolCalls.length === 0)) {
              nextLast.toolCalls = prevLast.toolCalls;
            }
            const changed =
              wasStreaming ||
              data.turns.length !== turnsRef.current.length ||
              (nextLast?.content || "") !== (prevLast?.content || "") ||
              Boolean(nextLast?.created_at) !== Boolean(prevLast?.created_at);
            turnsRef.current = data.turns;
            setTurns(data.turns);
            if (changed) {
              pendingScrollToBottomRef.current = true;
              scrollConversationToBottom(true);
            }
          }
          streamingRef.current = false;
          setStreaming(false);
          if (askCache) {
            askCache.streaming = false;
            askCache.activeRun = null;
          }
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("memento_ask_done", {
                detail: { conversation_id: convId },
              })
            );
          }
        }
      } catch {
        // Network errors are ignored; next tick will retry
      }
    };

    const schedule = () => {
      if (!isMounted) return;
      const delay = streamingRef.current ? 3000 : 15000;
      timer = setTimeout(async () => {
        await checkServerRun(false);
        schedule();
      }, delay);
    };

    schedule();

    // Recheck immediately when window regains visibility from background or wakes
    const onWake = () => {
      void checkServerRun(true);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        onWake();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWake);
    window.addEventListener("memento_wake_stream", onWake);
    window.addEventListener("memento_app_active", onWake);

    return () => {
      isMounted = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("memento_wake_stream", onWake);
      window.removeEventListener("memento_app_active", onWake);
    };
  }, [activeConversationId, scrollConversationToBottom]);

  // Mobile swipe down on chat area to dismiss keyboard smoothly
  const touchStartY = useRef<number | null>(null);
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
  }, []);
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartY.current === null) return;
    const currentY = e.touches[0].clientY;
    const deltaY = currentY - touchStartY.current;
    if (deltaY > 35) {
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
        (active as HTMLElement).blur();
      }
      touchStartY.current = null;
    }
  }, []);

  // Voice Input (Speech-to-Text) with real-time recognition & smart mobile fallback
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [speechHint, setSpeechHint] = useState<string | null>(null);
  const speechHintTimer = useRef<NodeJS.Timeout | null>(null);
  const recognitionRef = useRef<any>(null);
  const inputElRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = inputElRef.current;
    if (!el) return;
    if (!input) {
      if (el.style.height !== "20px") el.style.height = "20px";
      if (el.style.overflowY !== "hidden") el.style.overflowY = "hidden";
      return;
    }
    // Fast path: short single-line input without newline never wraps, avoiding synchronous scrollHeight layout thrashing on every keystroke
    if (!input.includes("\n") && input.length < 22 && el.style.height === "20px") {
      return;
    }
    el.style.height = "20px";
    const nextHeight = Math.min(Math.max(el.scrollHeight, 20), 160);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > 160 ? "auto" : "hidden";
  }, [input]);

  const toggleVoiceInput = useCallback(() => {
    // 1. Instant tactile feedback
    if (typeof window !== "undefined" && (window as any).__memento_haptic) {
      try {
        (window as any).__memento_haptic("medium");
      } catch {}
    }

    if (isRecordingVoice) {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {}
      }
      setIsRecordingVoice(false);
      return;
    }

    const isIOSDevice =
      typeof navigator !== "undefined" &&
      (/iPad|iPhone|iPod/.test(navigator.userAgent || "") ||
        (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1));

    const isMobileShell =
      typeof window !== "undefined" &&
      (!!(window as any).ReactNativeWebView ||
        (typeof navigator !== "undefined" && navigator.userAgent.includes("MementoMobile")));

    // On iOS or within Mobile App, Apple strictly restricts third-party webviews from running
    // Web Speech API (always throwing service-not-allowed).
    // Instead of failing with a permission warning, immediately focus the input synchronously
    // to bring up the iOS keyboard with the Apple Neural Engine dictation microphone.
    if (isIOSDevice || isMobileShell) {
      inputElRef.current?.focus();
      setTimeout(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      }, 80);
      const msg = isZh
        ? "已为您呼出键盘，点击键盘右下角「麦克风」🎤 即可开始语音吩咐！"
        : "Keyboard opened. Tap the mic 🎤 on your keyboard to dictate.";
      showInAppToast(isZh ? "🎙️ 语音吩咐已就绪" : "Voice Input Ready", msg);
      setSpeechHint(msg);
      if (speechHintTimer.current) clearTimeout(speechHintTimer.current);
      speechHintTimer.current = setTimeout(() => setSpeechHint(null), 5000);
      return;
    }

    const SpeechRecognition =
      typeof window !== "undefined"
        ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
        : null;

    if (!SpeechRecognition) {
      inputElRef.current?.focus();
      const msg = isZh
        ? "当前环境暂不支持浏览器内置语音转录，请直接键入文本"
        : "Speech recognition not supported in this browser.";
      showInAppToast(isZh ? "🎙️ 提示" : "Notice", msg);
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.lang = isZh ? "zh-CN" : "en-US";
      recognition.continuous = false;
      recognition.interimResults = true;

      recognition.onstart = () => {
        setIsRecordingVoice(true);
        setSpeechHint(null);
      };

      recognition.onresult = (event: any) => {
        let transcript = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        if (transcript) {
          setInput((prev) => {
            const trimmed = prev.trim();
            const nextVal = trimmed ? `${trimmed} ${transcript}` : transcript;
            if (askCache) {
              askCache.input = nextVal;
            }
            return nextVal;
          });
        }
      };

      recognition.onerror = (e: any) => {
        console.warn("Speech recognition error:", e);
        setIsRecordingVoice(false);
        const errType = e?.error;
        if (errType === "not-allowed" || errType === "service-not-allowed") {
          inputElRef.current?.focus();
          const fallbackMsg = isZh
            ? "未开启麦克风权限：请在浏览器设置中允许麦克风访问"
            : "Microphone blocked. Please grant microphone access in browser settings.";
          showInAppToast(isZh ? "🎙️ 麦克风提示" : "Microphone Notice", fallbackMsg);
          setSpeechHint(fallbackMsg);
          if (speechHintTimer.current) clearTimeout(speechHintTimer.current);
          speechHintTimer.current = setTimeout(() => setSpeechHint(null), 5000);
        }
      };

      recognition.onend = () => {
        setIsRecordingVoice(false);
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err) {
      console.warn("Failed to start speech recognition:", err);
      setIsRecordingVoice(false);
      inputElRef.current?.focus();
      const fallbackMsg = isZh
        ? "已为您呼出键盘，点击键盘右下角「麦克风」🎤 即可开始语音吩咐！"
        : "Keyboard opened. Tap the mic 🎤 on your keyboard to dictate.";
      showInAppToast(isZh ? "🎙️ 语音吩咐已就绪" : "Voice Input Ready", fallbackMsg);
      setSpeechHint(fallbackMsg);
      if (speechHintTimer.current) clearTimeout(speechHintTimer.current);
      speechHintTimer.current = setTimeout(() => setSpeechHint(null), 5000);
    }
  }, [isRecordingVoice, isZh]);

  useEffect(() => {
    if (deviceParam) {
      setSelectedDevice(deviceParam);
    }
  }, [deviceParam]);

  useEffect(() => {
    if (modeParam && ["ai", "claude", "codex", "antigravity", "workbuddy", "shell"].includes(modeParam)) {
      setExecutionMode(modeParam);
    }
  }, [modeParam]);

  // Load dynamic agent capabilities (models, default configs, reasoning effort)
  const [isRefreshingCaps, setIsRefreshingCaps] = useState<boolean>(false);
  const reloadCapabilities = useCallback(async (manual = false) => {
    if (executionMode === "ai" || executionMode === "shell") {
      setCapabilities(null);
      return;
    }
    // 1. Zero-latency synchronous cache check & immediate application (0ms)
    const immediate = getImmediateCapabilities(executionMode, selectedDevice);
    if (immediate) {
      setCapabilities(immediate);
    }
    if (manual) {
      setIsRefreshingCaps(true);
      showInAppToast(
        isZh ? "已即时同步最新模型" : "Models Synced",
        isZh ? `已就绪 ${immediate?.models?.length || 0} 个可用模型 (零延迟)` : `Ready with ${immediate?.models?.length || 0} models`
      );
    }
    const ticket = ++capsReqRef.current;
    try {
      // 2. Background fresh revalidation
      const data = await api.getAgentCapabilities(executionMode, selectedDevice, manual);
      if (ticket !== capsReqRef.current) return;
      if (data) {
        saveCapabilitiesCache(executionMode, selectedDevice, data);
        setCapabilities(data);
        if (!isCustomModel) {
          const hasModel = (data.models || []).some((m) => m.id === selectedModel);
          if (!hasModel && selectedModel !== "") {
            setSelectedModel("");
          }
        }
      }
    } catch (err) {
      console.warn("Failed to load agent capabilities:", err);
      if (manual && !immediate) {
        showInAppToast(isZh ? "模型列表已刷新" : "Refreshed", isZh ? "已加载默认推荐模型列表" : "Default model list loaded");
      }
    } finally {
      if (manual) {
        setTimeout(() => setIsRefreshingCaps(false), 200);
      }
    }
  }, [executionMode, selectedDevice, isCustomModel, selectedModel, isZh]);

  useEffect(() => {
    // 0ms instant sync upon switching executionMode or device
    const imm = getImmediateCapabilities(executionMode, selectedDevice);
    if (imm) {
      setCapabilities(imm);
    }
    void reloadCapabilities(false);
  }, [executionMode, selectedDevice, reloadCapabilities]);

  // Throttled patchLast: mutate ref immediately. When immediate is requested or tab is hidden, flush immediately; otherwise coalesce via requestAnimationFrame.
  const patchLast = useCallback((fn: (turn: Turn) => Turn, immediate = false) => {
    const arr = turnsRef.current;
    const i = arr.length - 1;
    if (i >= 0 && arr[i].role === "assistant") {
      arr[i] = fn(arr[i]);
    } else {
      arr.push(fn({ role: "assistant", content: "", toolCalls: [] }));
    }
    const isHidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    if (immediate || isHidden) {
      if (rafIdRef.current) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
      turnsDirtyRef.current = false;
      setTurns([...turnsRef.current]);
      return;
    }
    if (!turnsDirtyRef.current) {
      turnsDirtyRef.current = true;
      rafIdRef.current = window.requestAnimationFrame(() => {
        turnsDirtyRef.current = false;
        setTurns([...turnsRef.current]);
      });
    }
  }, []);

  // Read one SSE response of a run, applying its events. Returns true once the run is done.
  const consumeRun = useCallback(async (res: Response, cursor: RunCursor): Promise<boolean> => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;
    let laStepCount = 1;
    let laLastStatus = "";
    let laStartedSent = false;
    const laStartEpoch = Math.floor(Date.now() / 1000);

    const postLiveActivity = (
      action: "start" | "update" | "end",
      patch: {
        conversationId?: string;
        status: string;
        currentStep: string;
        toolName?: string | null;
      },
    ) => {
      try {
        const w = typeof window !== "undefined" ? (window as any) : null;
        if (!w?.ReactNativeWebView?.postMessage) return;
        const cid = patch.conversationId || cursor.convId || activeConversationIdRef.current;
        if (!cid) return;
        const eng =
          executionMode === "claude"
            ? "Claude"
            : executionMode === "antigravity"
            ? "AGY"
            : executionMode === "codex"
            ? "Codex"
            : executionMode === "workbuddy"
            ? "WB"
            : executionMode === "shell"
            ? "Shell"
            : "AI";
        const qTitle = (lastSentQuestionRef.current || "后台任务").replace(/\s+/g, " ").trim().slice(0, 45);
        w.ReactNativeWebView.postMessage(
          JSON.stringify({
            type: "live_activity",
            action,
            conversationId: cid,
            title: qTitle || "后台任务",
            engine: eng,
            deviceName: selectedDevice ? "远程设备" : "云端",
            status: patch.status,
            currentStep: patch.currentStep.slice(0, 85),
            stepCount: laStepCount,
            toolName: patch.toolName || null,
            startedAtEpoch: laStartEpoch,
          }),
        );
      } catch {}
    };

    const handleFrame = (frame: string) => {
      lastStreamActivityRef.current = Date.now();
      const lines = frame.split("\n");
      const idLine = lines.find((l) => l.startsWith("id: "));
      if (idLine) cursor.lastId = Number(idLine.slice(4)) || cursor.lastId;
      const line = lines.find((l) => l.startsWith("data: "));
      if (!line) return;
      let evt: {
        type: string;
        id?: string;
        conversation_id?: string;
        tool_call_id?: string;
        text?: string;
        sources?: Source[];
        message?: string;
        name?: string;
        args?: Record<string, unknown>;
        task_id?: string;
        device_id?: string;
        device_name?: string;
        action?: string;
        status?: string;
        stream?: "stdout" | "stderr";
        result?: ToolCallItem["result"];
        call?: ToolCallItem;
        event?: TaskEvent;
        user_created_at?: string;
        assistant_created_at?: string;
        duration_ms?: number;
      };
      try {
        evt = JSON.parse(line.slice(6));
      } catch {
        return;
      }

      if (evt.type === "run_started" && evt.conversation_id) {
        cursor.convId = evt.conversation_id;
        if (!laStartedSent) {
          laStartedSent = true;
          postLiveActivity("start", {
            conversationId: evt.conversation_id,
            status: "running",
            currentStep: "正在启动任务...",
          });
        }
      } else if (evt.type === "conversation_id" && evt.id) {
        cursor.convId = evt.id;
        activeConversationIdRef.current = evt.id;
        setActiveConversationId(evt.id);
        window.history.replaceState(null, "", `/ask?id=${evt.id}`);
        try {
          localStorage.setItem("memento_last_ask_conv_id", evt.id);
        } catch {}
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("memento_active_chat_change", { detail: { id: evt.id } }));
          window.dispatchEvent(new CustomEvent("memento_ask_start", { detail: { conversation_id: evt.id } }));
        }
        if (!laStartedSent) {
          laStartedSent = true;
          postLiveActivity("start", {
            conversationId: evt.id,
            status: "running",
            currentStep: "正在启动任务...",
          });
        }
        if (evt.user_created_at) {
          const cur = [...turnsRef.current];
          if (cur.length >= 2 && cur[cur.length - 2].role === "user") {
            cur[cur.length - 2] = {
              ...cur[cur.length - 2],
              created_at: evt.user_created_at || normalizeIsoTimestamp(cur[cur.length - 2].created_at),
            };
            turnsRef.current = cur;
          }
          patchLast((x) => ({
            ...x,
            started_at: evt.user_created_at || normalizeIsoTimestamp(x.started_at),
          }));
        }
        if (askCache) {
          askCache.streaming = true;
          askCache.activeRun = {
            convId: evt.id,
            question: lastSentQuestionRef.current || "",
            startedAt: normalizeEpochMs(askCache.activeRun?.startedAt),
          };
        }
      } else if (evt.type === "sources") {
        patchLast((x) => ({ ...x, sources: evt.sources ?? [] }));
      } else if (evt.type === "tool_call") {
        laStepCount += 1;
        laLastStatus = "tool";
        const callObj = evt.call || ({} as any);
        const tName = evt.name || callObj.name || "tool";
        const tArgs = (evt.args || callObj.args || {}) as Record<string, unknown>;
        const cmdRaw = String(tArgs.command || tArgs.prompt || tArgs.code || "").replace(/\s+/g, " ").trim();
        const stepDesc = cmdRaw ? `调用工具: ${tName} (${cmdRaw.slice(0, 36)})` : `调用工具: ${tName}`;
        postLiveActivity("update", {
          status: "tool",
          currentStep: stepDesc,
          toolName: tName,
        });
        patchLast((x) => {
          const calls = [...(x.toolCalls || [])];
          const callId = evt.id || evt.tool_call_id || callObj.id || `call_${Date.now()}`;
          if (!calls.some((c) => c.id === callId)) {
            calls.push({
              id: callId,
              name: evt.name || callObj.name || "",
              args: evt.args || callObj.args || {},
              device_name: evt.device_name || callObj.device_name,
            });
          }
          return { ...x, toolCalls: calls };
        });
      } else if (evt.type === "task_progress") {
        if (evt.status) {
          laLastStatus = "executing";
          postLiveActivity("update", {
            status: "executing",
            currentStep: `执行进度: ${evt.status}`,
          });
        }
        const progDev = evt.device_id || evt.device_name;
        if (progDev && !["auto", "ask_only", "all"].includes(progDev.toLowerCase()) && (!selectedDevice || selectedDevice === "auto")) {
          const normProgDev = normalizeDeviceId(progDev);
          if (normProgDev && normProgDev !== "auto") {
            setSelectedDevice(normProgDev);
          }
        }
        patchLast((x) => {
          const calls = [...(x.toolCalls || [])];
          let idx = -1;
          if (evt.task_id) {
            idx = calls.findIndex((c) => c.result?.task_id === evt.task_id);
          }
          if (idx === -1 && evt.tool_call_id) {
            idx = calls.findIndex((c) => c.id === evt.tool_call_id);
          }
          if (idx === -1 && evt.device_name) {
            idx = calls.findIndex(
              (c) =>
                (c.device_name === evt.device_name || (c.args as Record<string, any>)?.device_id === evt.device_id) &&
                (!c.result || !c.result.status || c.result.status === "queued" || c.result.status === "running")
            );
          }
          if (idx === -1) {
            idx = calls
              .map((c, i) =>
                c.name === "run_on_device" &&
                (!c.result || (c.result.status !== "succeeded" && c.result.status !== "failed" && c.result.status !== "timeout"))
                  ? i
                  : -1
              )
              .filter((i) => i >= 0)
              .pop() ?? -1;
          }
          if (idx >= 0) {
            calls[idx] = {
              ...calls[idx],
              device_name: evt.device_name || calls[idx].device_name,
              result: {
                ...(calls[idx].result || {}),
                task_id: evt.task_id,
                device_id: evt.device_id,
                device_name: evt.device_name || calls[idx].device_name,
                action: evt.action || (calls[idx].args?.action as string),
                status: evt.status,
              },
            };
          }
          return { ...x, toolCalls: calls };
        });
      } else if (evt.type === "task_chunk" || evt.type === "tool_stream") {
        patchLast((x) => {
          const calls = [...(x.toolCalls || [])];
          let idx = -1;
          if (evt.task_id) {
            idx = calls.findIndex((c) => c.result?.task_id === evt.task_id);
          }
          if (idx === -1 && evt.tool_call_id) {
            idx = calls.findIndex((c) => c.id === evt.tool_call_id);
          }
          if (idx === -1 && evt.device_name) {
            idx = calls.findIndex(
              (c) =>
                (c.device_name === evt.device_name || (c.args as Record<string, any>)?.device_id === evt.device_id) &&
                (!c.result || (c.result.status !== "succeeded" && c.result.status !== "failed" && c.result.status !== "timeout"))
            );
          }
          if (idx === -1) {
            idx = calls
              .map((c, i) =>
                c.name === "run_on_device" &&
                (!c.result || (c.result.status !== "succeeded" && c.result.status !== "failed" && c.result.status !== "timeout"))
                  ? i
                  : -1
              )
              .filter((i) => i >= 0)
              .pop() ?? -1;
          }
          if (idx >= 0) {
            const target = calls[idx];
            const prevRes = target.result || {};
            const chunkText = evt.text || "";
            const MAX_STREAM_CHARS = 250_000;
            if (evt.stream === "stderr") {
              const combined = (prevRes.stderr || "") + chunkText;
              calls[idx] = {
                ...target,
                result: {
                  ...prevRes,
                  task_id: evt.task_id || prevRes.task_id,
                  status: "running",
                  stderr: combined.length > MAX_STREAM_CHARS ? combined.slice(-MAX_STREAM_CHARS) : combined,
                },
              };
            } else {
              const combined = (prevRes.stdout || "") + chunkText;
              calls[idx] = {
                ...target,
                result: {
                  ...prevRes,
                  task_id: evt.task_id || prevRes.task_id,
                  status: "running",
                  stdout: combined.length > MAX_STREAM_CHARS ? combined.slice(-MAX_STREAM_CHARS) : combined,
                },
              };
            }
          }
          return { ...x, toolCalls: calls };
        });
      } else if (evt.type === "tool_result") {
        patchLast((x) => {
          const calls = [...(x.toolCalls || [])];
          let idx = -1;
          const resTaskId = evt.result?.task_id;
          if (resTaskId) {
            idx = calls.findIndex((c) => c.result?.task_id === resTaskId);
          }
          if (idx === -1 && evt.tool_call_id) {
            idx = calls.findIndex((c) => c.id === evt.tool_call_id);
          }
          const res = evt.result;
          if (idx === -1 && res?.device_name) {
            idx = calls.findIndex(
              (c) =>
                (c.device_name === res.device_name || (c.args as Record<string, any>)?.device_id === res.device_id) &&
                (!c.result || !c.result.status || c.result.status === "queued" || c.result.status === "running")
            );
          }
          if (idx === -1) {
            idx = calls
              .map((c, i) =>
                !c.result || (c.result.status !== "succeeded" && c.result.status !== "failed" && c.result.status !== "timeout")
                  ? i
                  : -1
              )
              .filter((i) => i >= 0)
              .pop() ?? -1;
          }
          if (idx !== undefined && idx >= 0) {
            // The final result carries the whole event log; keep the live one if it doesn't.
            const events = evt.result?.events ?? calls[idx].result?.events;
            calls[idx] = { ...calls[idx], result: evt.result && { ...evt.result, ...(events ? { events } : {}) } };
          } else if (calls.length > 0) {
            calls[calls.length - 1] = { ...calls[calls.length - 1], result: evt.result };
          }
          return { ...x, toolCalls: calls };
        });

        // 智能瘦身或新会话生成时，无缝同步最新的底层 session_id 与实际执行设备，并复位瘦身模式
        const newSid = (evt.result as any)?.session_id;
        const resDevRaw = (evt.result as any)?.device_id || (evt.result as any)?.device_name;
        const patchCfg: Record<string, any> = { compact_mode: false };
        if (newSid && typeof newSid === "string") {
          setSelectedSessionId(newSid);
          patchCfg.session_id = newSid;
        }
        if (resDevRaw && typeof resDevRaw === "string" && !["auto", "ask_only", "all"].includes(resDevRaw.toLowerCase())) {
          const normResDev = normalizeDeviceId(resDevRaw);
          if (normResDev && normResDev !== "auto" && (!selectedDevice || selectedDevice === "auto")) {
            setSelectedDevice(normResDev);
            patchCfg.device_id = normResDev;
          }
        }
        setCompactMode(false);
        persistCurrentConfig(patchCfg);
      } else if (evt.type === "task_event" && evt.event) {
        const event = evt.event;
        if (event.kind === "thinking" && event.text) {
          if (laLastStatus !== "thinking") {
            laLastStatus = "thinking";
            postLiveActivity("update", {
              status: "thinking",
              currentStep: "正在深度思考与推演...",
            });
          }
        }
        patchLast((x) => {
          const calls = [...(x.toolCalls || [])];
          let idx = evt.task_id ? calls.findIndex((c) => c.result?.task_id === evt.task_id) : -1;
          if (idx === -1 && evt.tool_call_id) idx = calls.findIndex((c) => c.id === evt.tool_call_id);
          if (idx >= 0) {
            const prev = calls[idx].result || {};
            calls[idx] = {
              ...calls[idx],
              result: { ...prev, task_id: prev.task_id || evt.task_id, events: mergeTaskEvent(prev.events ?? [], event) },
            };
          }
          let nextThinking = x.thinking;
          if (event.kind === "thinking" && event.text && !(x.thinking || "").endsWith(event.text)) {
            nextThinking = (x.thinking || "") + (x.thinking && !x.thinking.endsWith("\n") && !event.text.startsWith("\n") ? "\n" : "") + event.text;
          }
          return { ...x, toolCalls: calls, thinking: nextThinking };
        });
      } else if (evt.type === "thinking" && evt.text) {
        if (laLastStatus !== "thinking") {
          laLastStatus = "thinking";
          postLiveActivity("update", {
            status: "thinking",
            currentStep: "正在深度思考与推演...",
          });
        }
        patchLast((x) => ({ ...x, thinking: (x.thinking || "") + evt.text }));
      } else if (evt.type === "delta" && evt.text) {
        if (laLastStatus !== "generating") {
          laLastStatus = "generating";
          postLiveActivity("update", {
            status: "generating",
            currentStep: "正在生成回复...",
          });
        }
        patchLast((x) => ({ ...x, content: x.content + evt.text }));
      } else if (evt.type === "done") {
        sawDone = true;
        postLiveActivity("end", {
          status: "done",
          currentStep: "任务完成",
        });
        const doneIso = evt.assistant_created_at || new Date().toISOString();
        patchLast((x) => {
          const startIso = normalizeIsoTimestamp(x.started_at);
          const computedDur =
            typeof evt.duration_ms === "number"
              ? evt.duration_ms
              : startIso
                ? Math.max(0, new Date(doneIso).getTime() - new Date(startIso).getTime())
                : undefined;
          const calls = (x.toolCalls || []).map((c) => {
            if (!c.result || c.result.status === "running" || c.result.status === "queued") {
              return {
                ...c,
                result: {
                  ...(c.result || {}),
                  status: c.result?.status === "queued" ? "succeeded" : (c.result?.status || "succeeded"),
                },
              };
            }
            return c;
          });
          return {
            ...x,
            toolCalls: calls,
            started_at: startIso || x.started_at,
            created_at: doneIso,
            ...(computedDur !== undefined ? { duration_ms: computedDur } : {}),
          };
        }, true);
      } else if (evt.type === "error") {
        postLiveActivity("end", {
          status: "error",
          currentStep: `发生错误: ${(evt.message || t.ask.error || "").slice(0, 36)}`,
        });
        patchLast(
          (x) => ({ ...x, content: evt.message || t.ask.error, error: true, created_at: x.created_at || new Date().toISOString() }),
          true
        );
      }
    };

    try {
      for (;;) {
        // Watchdog: server emits keepalive every 8s. If no data arrives for 25s,
        // the TCP socket is dead (common during VPN handover/NAT timeout). Cancel and let followRun reconnect.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ done: true; value: undefined }>((_, reject) => {
          timer = setTimeout(() => {
            try { reader.cancel(); } catch {}
            reject(new Error("Stream idle timeout (zombie socket detected)"));
          }, 25000);
        });

        const { done, value } = await Promise.race([readPromise, timeoutPromise]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        frames.forEach(handleFrame);
      }
      if (buffer.trim()) handleFrame(buffer);
    } catch {
      // Reader read interrupted (network hiccup, socket drop, etc.)
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
    return sawDone;
  }, [patchLast, persistCurrentConfig, t, executionMode, selectedDevice, normalizeDeviceId]);

  const followRun = useCallback(async (cursor: RunCursor, ctrl: AbortController) => {
    let attempt = 1;
    while (!ctrl.signal.aborted) {
      if (attempt > 1) {
        setIsReconnecting(true);
      }
      try {
        const res = await authFetch(
          `${getApiBase()}/api/ask/conversations/${cursor.convId}/stream?after=${cursor.lastId}`,
          { signal: ctrl.signal },
        );
        if (res.status === 404) {
          setIsReconnecting(false);
          // Finished and no longer held by the server: the saved conversation has it all.
          const data = await api.getAskConversation(cursor.convId!, 40).catch(() => null);
          if (data?.turns) {
            const prevLast = turnsRef.current[turnsRef.current.length - 1];
            const nextLast = data.turns[data.turns.length - 1];
            if (prevLast?.content?.trim() && !nextLast?.content?.trim()) {
              nextLast.content = prevLast.content;
            }
            if (prevLast?.toolCalls?.length && (!nextLast?.toolCalls || nextLast.toolCalls.length === 0)) {
              nextLast.toolCalls = prevLast.toolCalls;
            }
            turnsRef.current = data.turns;
            setTurns(data.turns);
          }
          scrollConversationToBottom(true);
          return;
        }
        if (res.ok && res.body) {
          setIsReconnecting(false);
          const finished = await consumeRun(res, cursor);
          if (finished) return;
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError" || ctrl.signal.aborted) {
          setIsReconnecting(false);
          return;
        }
        setIsReconnecting(true);
      }

      if (ctrl.signal.aborted) {
        setIsReconnecting(false);
        return;
      }

      // Check server status before sleeping or retrying: is the task still active on the server?
      try {
        const runRes = await authFetch(`${getApiBase()}/api/ask/conversations/${cursor.convId}/run`, {
          signal: ctrl.signal,
        });
        if (runRes.status === 404) {
          setIsReconnecting(false);
          const data = await api.getAskConversation(cursor.convId!, 40).catch(() => null);
          if (data?.turns) {
            const prevLast = turnsRef.current[turnsRef.current.length - 1];
            const nextLast = data.turns[data.turns.length - 1];
            if (prevLast?.content?.trim() && !nextLast?.content?.trim()) {
              nextLast.content = prevLast.content;
            }
            if (prevLast?.toolCalls?.length && (!nextLast?.toolCalls || nextLast.toolCalls.length === 0)) {
              nextLast.toolCalls = prevLast.toolCalls;
            }
            turnsRef.current = data.turns;
            setTurns(data.turns);
          }
          scrollConversationToBottom(true);
          return;
        }
        if (runRes.ok) {
          const run = await runRes.json();
          if (run.done || run.cancelled) {
            setIsReconnecting(false);
            const data = await api.getAskConversation(cursor.convId!, 40).catch(() => null);
            if (data?.turns) {
              const prevLast = turnsRef.current[turnsRef.current.length - 1];
              const nextLast = data.turns[data.turns.length - 1];
              if (prevLast?.content?.trim() && !nextLast?.content?.trim()) {
                nextLast.content = prevLast.content;
              }
              if (prevLast?.toolCalls?.length && (!nextLast?.toolCalls || nextLast.toolCalls.length === 0)) {
                nextLast.toolCalls = prevLast.toolCalls;
              }
              turnsRef.current = data.turns;
              setTurns(data.turns);
            }
            scrollConversationToBottom(true);
            return;
          }
          // Server confirmed task is still running: keep reconnecting!
          if (attempt > 10) attempt = 3;
        }
      } catch {
        // Network error checking status; continue reconnect loop
      }

      attempt++;
      const isVisible = typeof document !== "undefined" && document.visibilityState === "visible";
      const maxDelay = isVisible ? 1500 : 10000;
      const sleepTime = Math.min(600 * attempt, maxDelay);
      await interruptibleSleep(sleepTime, ctrl.signal);
    }
    setIsReconnecting(false);
  }, [consumeRun, scrollConversationToBottom]);

  const finishStream = useCallback((ctrl: AbortController) => {
    setIsReconnecting(false);
    if (abortRef.current !== ctrl) return; // superseded by a newer stream
    if (rafIdRef.current) window.cancelAnimationFrame(rafIdRef.current);
    turnsDirtyRef.current = false;

    // If the component is unmounting while a task is still active and user did NOT explicitly cancel,
    // preserve activeRun in askCache so switching back can seamlessly reattach.
    if (isUnmountedRef.current && !userCancelledRef.current) {
      return;
    }

    const finalTurns = [...turnsRef.current];
    if (finalTurns.length > 0) {
      const last = finalTurns[finalTurns.length - 1];
      if (last.role === "assistant" && !last.created_at) {
        const finIso = new Date().toISOString();
        const normStart = normalizeIsoTimestamp(last.started_at);
        const dur = normStart ? Math.max(0, new Date(finIso).getTime() - new Date(normStart).getTime()) : undefined;
        finalTurns[finalTurns.length - 1] = {
          ...last,
          started_at: normStart || last.started_at,
          created_at: finIso,
          ...(dur !== undefined && !last.duration_ms ? { duration_ms: dur } : {}),
        };
        turnsRef.current = finalTurns;
      }
    }
    setTurns(finalTurns);
    if (!userCancelledRef.current) {
      pendingScrollToBottomRef.current = true;
      scrollConversationToBottom(true);
    }
    streamingRef.current = false;
    setStreaming(false);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("memento_ask_done", {
          detail: { conversation_id: activeConversationIdRef.current },
        })
      );
      try {
        const w = window as any;
        if (w?.ReactNativeWebView?.postMessage && activeConversationIdRef.current) {
          w.ReactNativeWebView.postMessage(
            JSON.stringify({
              type: "live_activity",
              action: "end",
              conversationId: activeConversationIdRef.current,
              status: "done",
              currentStep: "任务完成",
            })
          );
        }
      } catch {}
    }
    if (askCache) {
      askCache.streaming = false;
      askCache.activeRun = null;
    }
    userCancelledRef.current = false;
    setCompactMode(false);
    abortRef.current = null;
    loadConversations();
    if (activeConversationIdRef.current) {
      saveLocalConvSnapshot({
        id: activeConversationIdRef.current,
        turns: finalTurns,
        executionMode,
        selectedModel,
        selectedEffort,
        cwd,
        selectedDevice,
        selectedProjectId,
        selectedProjectTitle: selectedProjectTitleRef.current,
        selectedSessionId,
        worktreeMode,
        hasMoreTurns: false,
        totalTurns: finalTurns.length,
      });
    }
  }, [
    loadConversations,
    scrollConversationToBottom,
    executionMode,
    selectedModel,
    selectedEffort,
    cwd,
    selectedDevice,
    selectedProjectId,
    selectedSessionId,
    worktreeMode,
  ]);

  // Show a run that is still going (opened from history, or after a reload).
  const attachRun = useCallback(async (convId: string, question: string, baseTurns: Turn[]) => {
    abortRef.current?.abort();
    userCancelledRef.current = false;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    lastSentQuestionRef.current = question;

    let turnsToUse = [...baseTurns];
    const len = turnsToUse.length;
    const last = len > 0 ? turnsToUse[len - 1] : null;
    const secondLast = len > 1 ? turnsToUse[len - 2] : null;
    const runStartedIso = askCache?.activeRun?.startedAt
      ? new Date(normalizeEpochMs(askCache.activeRun.startedAt)).toISOString()
      : new Date().toISOString();

    if (last?.role === "assistant" && secondLast?.role === "user" && secondLast.content === question) {
      // Already ends with user question and assistant placeholder, reset assistant content and toolCalls for clean replay
      const normUserCreated = normalizeIsoTimestamp(secondLast.created_at) || runStartedIso;
      const normAsstStarted = normalizeIsoTimestamp(last.started_at) || normUserCreated;
      turnsToUse = [
        ...turnsToUse.slice(0, -2),
        { ...secondLast, created_at: normUserCreated },
        { role: "assistant", content: "", toolCalls: [], started_at: normAsstStarted },
      ];
    } else if (last?.role === "user" && last.content === question) {
      // Ends with user question, append assistant placeholder
      const normUserCreated = normalizeIsoTimestamp(last.created_at) || runStartedIso;
      turnsToUse[turnsToUse.length - 1] = { ...last, created_at: normUserCreated };
      turnsToUse.push({ role: "assistant", content: "", toolCalls: [], started_at: normUserCreated });
    } else {
      // Normal case: append both user and assistant
      turnsToUse.push(
        { role: "user", content: question, created_at: runStartedIso },
        { role: "assistant", content: "", toolCalls: [], started_at: runStartedIso }
      );
    }

    turnsRef.current = turnsToUse;
    setTurns([...turnsToUse]);
    streamingRef.current = true;
    setStreaming(true);
    if (askCache) {
      askCache.streaming = true;
      askCache.activeRun = {
        convId,
        question,
        startedAt: normalizeEpochMs(askCache.activeRun?.startedAt),
      };
    }
    try {
      await followRun({ lastId: 0, convId }, ctrl);
    } finally {
      finishStream(ctrl);
    }
  }, [finishStream, followRun]);
  attachRunRef.current = attachRun;

  // The stop button: ends the run on the server, including its device tasks.
  // Closing or leaving the page only detaches; the run keeps going.
  const stopRun = useCallback(() => {
    userCancelledRef.current = true;
    const convId = activeConversationIdRef.current;
    abortRef.current?.abort();
    streamingRef.current = false;
    setStreaming(false);
    setIsReconnecting(false);
    if (askCache) {
      askCache.streaming = false;
      askCache.activeRun = null;
    }
    if (convId) {
      authFetch(`${getApiBase()}/api/ask/conversations/${convId}/cancel`, { method: "POST" }).catch(() => {});
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("memento_ask_done", {
            detail: { conversation_id: convId },
          })
        );
      }
    }
  }, []);

  const sendWithText = useCallback(async (
    textToSend: string,
    options?: { forceCompact?: boolean; overrideSessionId?: string; images?: string[] }
  ) => {
    const rawQuestion = textToSend.trim();
    const sendImages = options?.images || [];
    if ((!rawQuestion && sendImages.length === 0) || streamingRef.current) return;
    const question = rawQuestion || (sendImages.length > 0 ? (locale === "zh-CN" ? "请分析这张图片" : "Please analyze this image") : "");
    lastSentQuestionRef.current = question;
    userCancelledRef.current = false;
    isNewChatModeRef.current = false;

    const effectiveSessionId = options?.overrideSessionId !== undefined ? options.overrideSessionId : selectedSessionId;
    const effectiveCompact = options?.forceCompact !== undefined ? options.forceCompact : compactMode;

    // Snapshot history BEFORE appending, preserving tool execution results for follow-up turns
    const history = turns
      .filter((x) => !x.error)
      .map((x) => ({
        role: x.role,
        content: x.content,
        images: x.images,
        created_at: x.created_at,
        started_at: x.started_at,
        duration_ms: x.duration_ms,
        tool_calls: x.toolCalls?.map((tc) => ({
          name: tc.name,
          args: tc.args,
          device_name: tc.device_name || tc.result?.device_name,
          status: tc.result?.status,
          exit_code: tc.result?.exit_code,
          stdout: tc.result?.stdout ? tc.result.stdout.slice(-2000) : undefined,
          stderr: tc.result?.stderr ? tc.result.stderr.slice(-2000) : undefined,
          error: tc.result?.error,
        })),
      }));

    setInput("");
    if (askCache) {
      askCache.input = "";
    }
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setIsConfigCollapsed(true);
    }
    const nowIso = new Date().toISOString();
    const initialTurns: Turn[] = [
      ...turns.filter((x) => !x.error),
      { role: "user", content: question, images: sendImages.length > 0 ? sendImages : undefined, created_at: nowIso },
      { role: "assistant", content: "", toolCalls: [], started_at: nowIso, model: selectedModel || undefined, execution_mode: executionMode },
    ];
    turnsRef.current = initialTurns;
    setTurns(initialTurns);
    streamingRef.current = true;
    setStreaming(true);
    if (typeof window !== "undefined" && activeConversationId) {
      window.dispatchEvent(
        new CustomEvent("memento_ask_start", {
          detail: { conversation_id: activeConversationId },
        })
      );
    }
    scrollConversationToBottom(false);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const cursor: RunCursor = { lastId: 0, convId: activeConversationId || null };
    if (askCache) {
      askCache.streaming = true;
      askCache.activeRun = {
        convId: activeConversationId || "",
        question,
        startedAt: Date.now(),
      };
    }

    try {
      const res = await authFetch(`${getApiBase()}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          images: sendImages.length > 0 ? sendImages : undefined,
          // Lets the server attach a retried send to the run it already started.
          request_id: crypto.randomUUID(),
          conversation_id: activeConversationId || undefined,
          history,
          device_id: selectedDevice,
          cwd: cwd.trim() || undefined,
          agent_mode: selectedDevice !== "ask_only",
          execution_mode: executionMode,
          model: selectedModel || undefined,
          effort: selectedEffort || undefined,
          session_id: effectiveSessionId || undefined,
          compact_mode: effectiveCompact || undefined,
          project_id: selectedProjectId || undefined,
          worktree: worktreeMode && ["codex", "claude", "antigravity", "workbuddy"].includes(executionMode) ? true : undefined,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        const busy = res.status === 409;
        patchLast((x) => ({ ...x, content: busy ? "这个对话还有任务在运行，请等它结束或先停止" : t.ask.error, error: true }));
        return;
      }

      const done = await consumeRun(res, cursor);
      // The run lives on the server: a dropped connection reattaches, never resends.
      if (!done && !ctrl.signal.aborted && cursor.convId) await followRun(cursor, ctrl);
    } catch (err) {
      if ((err as Error)?.name !== "AbortError" && !userCancelledRef.current) {
        if (cursor.convId && !ctrl.signal.aborted) {
          await followRun(cursor, ctrl);
        } else {
          patchLast((x) => ({ ...x, content: x.content || t.ask.error, error: true }));
        }
      }
    } finally {
      finishStream(ctrl);
    }
  }, [activeConversationId, compactMode, consumeRun, cwd, executionMode, finishStream, followRun, locale, patchLast, selectedDevice, selectedEffort, selectedModel, selectedProjectId, selectedSessionId, turns, t, worktreeMode]);

  const send = useCallback(() => {
    if (streaming || (!input.trim() && attachedImages.length === 0)) return;
    const textToSend = input.trim();
    const imgs = attachedImages.map((img) => img.dataUrl);
    setAttachedImages([]);
    setInput("");
    if (askCache) {
      askCache.input = "";
    }
    promptHistoryIdxRef.current = -1;
    promptDraftRef.current = "";
    sendWithText(textToSend, { images: imgs });
  }, [streaming, input, attachedImages, sendWithText]);

  const handleRetryLastTurn = useCallback(() => {
    if (streamingRef.current) return;
    const lastUserTurn = [...turns].reverse().find((t) => t.role === "user");
    if (!lastUserTurn || !lastUserTurn.content) return;
    setTurns((prev) => {
      const idx = prev.findLastIndex((t) => t.role === "assistant" && t.error);
      if (idx !== -1) {
        return prev.slice(0, idx - 1 >= 0 && prev[idx - 1].role === "user" ? idx - 1 : idx);
      }
      return prev;
    });
    sendWithText(lastUserTurn.content, { images: lastUserTurn.images });
  }, [turns, sendWithText]);

  const handleSmartCompactAndRetry = useCallback(
    (targetSid?: string) => {
      const sidToUse = targetSid || selectedSessionId;
      if (sidToUse) {
        setSelectedSessionId(sidToUse);
      }
      setCompactMode(true);
      const lastUserTurn = [...turnsRef.current].reverse().find((t) => t.role === "user" && t.content);
      if (lastUserTurn?.content) {
        sendWithText(lastUserTurn.content, { forceCompact: true, overrideSessionId: sidToUse });
      }
    },
    [selectedSessionId, sendWithText]
  );

  useEffect(() => {
    if (qParam && !initialSentRef.current && !streaming) {
      initialSentRef.current = true;
      sendWithText(qParam);
    }
  }, [qParam, streaming, sendWithText]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      const isMobileViewport = typeof window !== "undefined" && window.innerWidth < 768;
      if (!isMobileViewport) {
        e.preventDefault();
        send();
        return;
      }
    }
    // 上下方向键回溯历史提问 (Prompt History Navigation)
    if (e.key === "ArrowUp") {
      const textarea = e.currentTarget;
      const isAtStart = textarea.selectionStart === 0 && textarea.selectionEnd === 0;
      if (isAtStart || !input.trim()) {
        const userQuestions = turns.filter((t) => t.role === "user" && t.content).map((t) => t.content);
        if (userQuestions.length > 0) {
          e.preventDefault();
          if (promptHistoryIdxRef.current === -1) {
            promptDraftRef.current = input;
          }
          const nextIdx = promptHistoryIdxRef.current === -1 ? userQuestions.length - 1 : Math.max(0, promptHistoryIdxRef.current - 1);
          promptHistoryIdxRef.current = nextIdx;
          const val = userQuestions[nextIdx];
          setInput(val);
          if (askCache) askCache.input = val;
        }
      }
    } else if (e.key === "ArrowDown") {
      if (promptHistoryIdxRef.current !== -1) {
        e.preventDefault();
        const userQuestions = turns.filter((t) => t.role === "user" && t.content).map((t) => t.content);
        if (promptHistoryIdxRef.current < userQuestions.length - 1) {
          promptHistoryIdxRef.current += 1;
          const val = userQuestions[promptHistoryIdxRef.current];
          setInput(val);
          if (askCache) askCache.input = val;
        } else {
          promptHistoryIdxRef.current = -1;
          const draft = promptDraftRef.current;
          setInput(draft);
          if (askCache) askCache.input = draft;
        }
      }
    }
  }, [send, input, turns]);

  // 全局快捷键与事件监听: Cmd/Ctrl+K 聚焦、Cmd+Shift+O 新建、Cmd+Shift+E 导出，memento_fill_input 一键错误排查与填充
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleFillInput = (e: any) => {
      const text = e?.detail?.text;
      const autoSubmit = Boolean(e?.detail?.autoSubmit);
      if (typeof text === "string" && text.trim()) {
        setInput(text);
        if (autoSubmit) {
          setTimeout(() => {
            sendWithText(text);
          }, 60);
        } else {
          inputElRef.current?.focus();
        }
      }
    };
    window.addEventListener("memento_fill_input", handleFillInput);

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const hasModifier = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // Cmd/Ctrl + Shift + O: 一键新建对话
      if (hasModifier && e.shiftKey && key === "o") {
        e.preventDefault();
        startNewChat();
        return;
      }

      // Cmd/Ctrl + Shift + E: 一键导出 Markdown 研报
      if (hasModifier && e.shiftKey && key === "e") {
        e.preventDefault();
        handleExportMarkdown();
        return;
      }

      // Cmd/Ctrl + K: 聚焦输入框或历史搜索框
      if (hasModifier && key === "k") {
        e.preventDefault();
        if (historyOpen) {
          const searchInput =
            document.querySelector<HTMLInputElement>('input[placeholder*="搜索"]') ||
            document.querySelector<HTMLInputElement>('input[placeholder*="Search"]');
          searchInput?.focus();
        } else {
          inputElRef.current?.focus();
        }
        return;
      }

      // Escape: 关闭侧边栏或中止流式生成
      if (e.key === "Escape") {
        if (historyOpen) {
          e.preventDefault();
          setHistoryOpen(false);
          return;
        }
        if (streaming && abortRef.current) {
          e.preventDefault();
          stopRun();
          return;
        }
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
      window.removeEventListener("memento_fill_input", handleFillInput);
    };
  }, [historyOpen, streaming, sendWithText, startNewChat, handleExportMarkdown, stopRun]);

  // Expose global task cancellation for Native App / Live Activity bridge
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__memento_stop_task = (convId?: string) => {
      const targetId = convId || activeConversationIdRef.current;
      if (targetId) {
        authFetch(`${getApiBase()}/api/ask/conversations/${targetId}/cancel`, { method: "POST" }).catch(() => {});
        streamingRef.current = false;
        setStreaming(false);
        userCancelledRef.current = true;
        abortRef.current?.abort();
      }
    };
    return () => {
      delete (window as any).__memento_stop_task;
    };
  }, []);

  const handleSelectProject = useCallback(
    async (projId: string, customProjects?: ProjectSummary[], explicitDev?: string) => {
      const isSameProj = projId === selectedProjectIdRef.current;
      setSelectedProjectId(projId);
      selectedProjectIdRef.current = projId;
      if (!isSameProj && !isRestoringRef.current) {
        setSelectedSessionId("");
      }
      const ticket = ++sessionsReqRef.current;
      if (!projId) {
        setSessions([]);
        if (!isRestoringRef.current) {
          persistCurrentConfig({ project_id: "", session_id: "" });
        }
        return;
      }
      const projs = customProjects || projectsRef.current;
      const proj = projs.find((p) => p.id === projId);
      if (proj && proj.title && !isUuidOrHash(proj.title)) {
        setSelectedProjectTitle(proj.title);
        selectedProjectTitleRef.current = proj.title;
      }

      // The device is the one picked. Only in auto mode does the project choose it, the device it
      // lives on, so that the folder, the sessions and the run all belong to the same machine.
      let dev = explicitDev !== undefined ? explicitDev : selectedDeviceRef.current;
      let pinned = false;
      if (!isConcreteDevice(dev) && dev !== "ask_only") {
        const home = homeDeviceOf(proj, devices);
        if (home) {
          dev = home.device_id;
          setSelectedDevice(dev);
          selectedDeviceRef.current = dev;
          pinned = true;
        }
      }
      const folder = projectPathOn(proj, dev);
      setCwd(folder);
      setShowCwd(Boolean(folder));
      if (pinned) {
        // The project list follows the device now picked
        void loadProjectsRef.current?.(executionModeRef.current, dev, proj?.title);
      }

      if (!isRestoringRef.current) {
        persistCurrentConfig(
          isSameProj ? { cwd: folder, device_id: dev } : { project_id: projId, session_id: "", cwd: folder, device_id: dev }
        );
      }
      // 0ms instant hydration from this device's cache
      const cachedSess = getCachedSessions(projId, dev);
      setSessions(cachedSess);
      setLoadingSessions(cachedSess.length === 0);
      try {
        const res = await api.getProjectConversations(projId, 0, 50, "desc", dev);
        if (ticket !== sessionsReqRef.current) return;
        const sessList = res.sessions || [];
        setSessions(sessList);
        saveCachedSessions(projId, dev, sessList);
        // The server knows this device's folder even when the list didn't
        const serverFolder = isConcreteDevice(dev) ? cleanProjectPath(res.project?.source_path) : "";
        if (!folder && serverFolder) {
          setCwd(serverFolder);
          setShowCwd(true);
        }
      } catch (e) {
        if (ticket !== sessionsReqRef.current) return;
        console.error("Failed to load project sessions:", e);
        setSessions([]);
      } finally {
        if (ticket === sessionsReqRef.current) setLoadingSessions(false);
      }
    },
    [persistCurrentConfig, devices]
  );

  const loadProjectsForMode = useCallback(
    async (mode: ExecutionMode, targetDev?: string, preferredTitle?: string) => {
      const toolMap: Record<string, string> = {
        codex: "codex",
        claude: "claude_code",
        antigravity: "antigravity",
        workbuddy: "workbuddy",
      };
      const toolId = toolMap[mode];
      const ticket = ++projectsReqRef.current;
      const clearProject = () => {
        ++sessionsReqRef.current;
        setSelectedProjectId("");
        selectedProjectIdRef.current = "";
        setSessions([]);
        setSelectedSessionId("");
      };
      if (!toolId) {
        if (!isRestoringRef.current) {
          setProjects([]);
          clearProject();
        }
        return;
      }
      const devToUse = targetDev !== undefined ? targetDev : selectedDeviceRef.current;
      // 0ms instant hydration from this device's cache, never another device's list
      setProjects(getCachedProjects(toolId, devToUse));
      try {
        let list = (await api.listProjects(toolId, devToUse)) || [];
        if (ticket !== projectsReqRef.current) return;
        const curProjId = selectedProjectIdRef.current;
        // An old conversation's project that is no longer listed still shows by name
        if (isRestoringRef.current && curProjId && !list.some((p) => p.id === curProjId)) {
          try {
            const single = await api.getProject(curProjId);
            if (ticket !== projectsReqRef.current) return;
            if (single && single.id) {
              list = [...list, single];
              if (single.title && !isUuidOrHash(single.title)) {
                setSelectedProjectTitle(single.title);
                selectedProjectTitleRef.current = single.title;
              }
            }
          } catch {}
        }
        setProjects(list);
        saveCachedProjects(toolId, devToUse, list);
        if (isRestoringRef.current) return;

        const pref = preferredTitle || projectsRef.current.find((p) => p.id === curProjId)?.title;
        let target = pref
          ? list.find((p) => p.title?.toLowerCase() === pref.toLowerCase() || p.slug?.toLowerCase().endsWith(`/${pref.toLowerCase()}`))
          : undefined;
        if (!target && curProjId) target = list.find((p) => p.id === curProjId);
        // Pick a project for a device that was picked; in auto mode picking one would also pick the device
        if (!target && !curProjId && isConcreteDevice(devToUse)) target = list[0];
        if (target && target.id !== curProjId) {
          handleSelectProject(target.id, list, devToUse);
        } else if (target) {
          const folder = projectPathOn(target, devToUse);
          if (folder && !pathWithin(cwdRef.current, folder)) {
            setCwd(folder);
            setShowCwd(true);
          }
        } else if (curProjId) {
          // The project picked before isn't on this device
          clearProject();
          setCwd("");
          setShowCwd(false);
          persistCurrentConfig({ project_id: "", session_id: "", cwd: "" });
        }
      } catch (e) {
        if (ticket !== projectsReqRef.current) return;
        console.error("Failed to load projects:", e);
        if (!isRestoringRef.current) {
          setProjects([]);
          clearProject();
        }
      }
    },
    [handleSelectProject, persistCurrentConfig]
  );
  loadProjectsRef.current = loadProjectsForMode;

  const handleDeviceChange = (newDev: string) => {
    setSelectedDevice(newDev);
    selectedDeviceRef.current = newDev;
    try {
      localStorage.setItem("memento_last_device", newDev);
    } catch {}
    const prevTitle = projectsRef.current.find((p) => p.id === selectedProjectIdRef.current)?.title;
    ++sessionsReqRef.current;
    setSelectedProjectId("");
    selectedProjectIdRef.current = "";
    setSelectedSessionId("");
    setSessions([]);
    // The folder was the previous device's; the project brings its own folder on this one
    setCwd("");
    setShowCwd(false);
    persistCurrentConfig({ device_id: newDev, project_id: "", session_id: "", cwd: "" });
    if (["codex", "claude", "antigravity", "workbuddy"].includes(executionMode)) {
      // Choosing auto leaves the project to the user: picking one then picks its device
      loadProjectsForMode(executionMode, newDev, isConcreteDevice(newDev) ? prevTitle : undefined);
    }
  };

  const handleSelectMode = (mode: ExecutionMode) => {
    setExecutionMode(mode);
    executionModeRef.current = mode;
    try {
      localStorage.setItem("memento_last_execution_mode", mode);
    } catch {}
    let dev = selectedDevice;
    if (mode !== "ai" && selectedDevice === "ask_only") {
      dev = "auto";
      setSelectedDevice("auto");
    }
    // Default to empty (follow client/CLI config), never force hardcoded model!
    setSelectedModel("");
    setIsCustomModel(false);
    persistCurrentConfig({ execution_mode: mode, model: "", project_id: "", session_id: "" });
    const prevTitle = projectsRef.current.find((p) => p.id === selectedProjectIdRef.current)?.title;
    setSelectedProjectId("");
    selectedProjectIdRef.current = "";
    setSelectedSessionId("");
    setSessions([]);
    loadProjectsForMode(mode, dev, prevTitle);
  };

  const handleSelectSession = useCallback(
    async (sid: string) => {
      setSelectedSessionId(sid);
      persistCurrentConfig({ session_id: sid });
      if (!sid) {
        if (!activeConversationIdRef.current) {
          startNewChat();
        }
        return;
      }
      const targetSession = sessions.find(
        (s) => (s.session_id || s.conversation_id) === sid
      );
      // A session resumes on the device it ran on, in the project's folder there
      const ranOn = targetSession?.device_id ? normalizeDeviceId(targetSession.device_id) : "";
      if (isConcreteDevice(ranOn) && ranOn !== selectedDeviceRef.current) {
        setSelectedDevice(ranOn);
        selectedDeviceRef.current = ranOn;
        const folder = projectPathOn(projectsRef.current.find((p) => p.id === selectedProjectIdRef.current), ranOn);
        setCwd(folder);
        setShowCwd(Boolean(folder));
        persistCurrentConfig({ device_id: ranOn, cwd: folder });
      }
      if (!targetSession) {
        const matchedAskConv = conversations.find(
          (c) => c.config?.session_id === sid || c.id === sid
        );
        if (matchedAskConv) {
          activeConversationIdRef.current = matchedAskConv.id;
          setActiveConversationId(matchedAskConv.id);
          window.history.replaceState(null, "", `/ask?id=${matchedAskConv.id}`);
          try {
            localStorage.setItem("memento_last_ask_conv_id", matchedAskConv.id);
          } catch {}
          loadConversation(matchedAskConv.id);
        }
        return;
      }

      // 默认保持原生接续（Raw Resume），绝不静默强制开启瘦身模式，仅在 UI 提供建议标记并由用户显式切换
      setCompactMode(false);

      let rawMsgs: Array<{
        role: string;
        content: string;
        images?: string[];
        thinking?: string;
        tool_name?: string;
        tool_input?: string;
        raw_type?: string;
        timestamp?: string;
      }> = (targetSession.messages || []) as any;

      if (targetSession.conversation_id) {
        try {
          const full = await api.getMessages(targetSession.conversation_id, 0, 100);
          if (full?.messages && full.messages.length > 0) {
            rawMsgs = full.messages.map((m: any) => ({
              role: m.role || "user",
              content: m.content || "",
              images: m.images || undefined,
              thinking: m.thinking || undefined,
              tool_name: m.tool_name || undefined,
              tool_input: m.tool_input || undefined,
              raw_type: m.raw_type || undefined,
              timestamp: m.timestamp || m.created_at || undefined,
            }));
          }
        } catch (err) {
          console.warn("Failed to load full conversation messages:", err);
        }
      }

      // Helper to parse legacy [Tool: <name>]\n<input> blocks embedded in text
      const parseLegacyToolContent = (text: string) => {
        const toolIdx = text.indexOf("[Tool:");
        if (toolIdx === -1) return null;
        const preText = text.slice(0, toolIdx).trim();
        const toolPart = text.slice(toolIdx);
        const match = toolPart.match(/^\[Tool:\s*([^\]]+)\]\s*([\s\S]*)$/);
        if (!match) return null;
        const name = match[1].trim();
        const inputStr = match[2].trim();
        let command = inputStr;
        try {
          const parsed = JSON.parse(inputStr);
          if (typeof parsed === "object" && parsed !== null) {
            if (parsed.command) command = parsed.command;
          }
        } catch {}
        return { preText, name, command };
      };

      const loadedTurns: Turn[] = [];

      for (const m of rawMsgs) {
        let role = m.role || "user";
        let content = m.content || "";
        const rawType = m.raw_type || "";
        const msgTime = m.timestamp || (m as any).created_at || undefined;

        // Detect legacy [Result] on user role -> treat as tool output
        if (role === "user" && content.startsWith("[Result]")) {
          role = "tool";
          content = content.replace(/^\[Result\]\s*/, "");
        }

        // Detect legacy [Tool: ...] on assistant role
        const legacyCall = role === "assistant" ? parseLegacyToolContent(content) : null;
        if (legacyCall) {
          content = legacyCall.preText;
          role = content ? "assistant" : "tool";
        }

        if (role === "user") {
          // Skip any residual tool/meta noise from appearing as user messages
          if (
            content.startsWith("[Tool:") ||
            content.startsWith("[Result]") ||
            content.startsWith('{"tool_use_id"')
          ) {
            continue;
          }
          loadedTurns.push({
            role: "user",
            content: content,
            images: m.images || undefined,
            created_at: msgTime,
          });
        } else if (role === "assistant") {
          const toolCalls: ToolCallItem[] = [];
          if (legacyCall) {
            toolCalls.push({
              name: legacyCall.name,
              args: { command: legacyCall.command },
            });
          } else if (m.tool_name) {
            toolCalls.push({
              name: m.tool_name,
              args: m.tool_input ? { command: m.tool_input } : {},
            });
          }
          const prevTurn = loadedTurns[loadedTurns.length - 1];
          const prevUserTime = prevTurn?.role === "user" ? prevTurn.created_at : undefined;
          loadedTurns.push({
            role: "assistant",
            content: content,
            thinking: m.thinking || undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            created_at: msgTime,
            started_at: prevUserTime,
          });
        } else if (role === "tool") {
          // Attach tool call or output to the last assistant turn
          let lastTurn = loadedTurns[loadedTurns.length - 1];
          if (!lastTurn || lastTurn.role !== "assistant") {
            const prevUserTime = lastTurn?.role === "user" ? lastTurn.created_at : undefined;
            lastTurn = {
              role: "assistant",
              content: "",
              toolCalls: [],
              created_at: msgTime,
              started_at: prevUserTime,
            };
            loadedTurns.push(lastTurn);
          } else if (msgTime) {
            lastTurn.created_at = msgTime;
          }
          if (!lastTurn.toolCalls) {
            lastTurn.toolCalls = [];
          }

          if (legacyCall) {
            lastTurn.toolCalls.push({
              name: legacyCall.name,
              args: { command: legacyCall.command },
            });
          } else if (rawType === "tool_call" || m.tool_name) {
            lastTurn.toolCalls.push({
              name: m.tool_name || "tool",
              args: m.tool_input ? { command: m.tool_input } : {},
            });
          } else {
            // Tool output: attach stdout to the most recent tool call if available
            if (lastTurn.toolCalls.length > 0) {
              const lastCall = lastTurn.toolCalls[lastTurn.toolCalls.length - 1];
              lastCall.result = {
                stdout: content,
                status: "succeeded",
                exit_code: 0,
              };
            } else {
              lastTurn.toolCalls.push({
                name: "tool",
                args: {},
                result: {
                  stdout: content,
                  status: "succeeded",
                  exit_code: 0,
                },
              });
            }
          }
        }
      }

      abortRef.current?.abort();
      streamingRef.current = false;
      // 优先从已有的 AskConversations 中寻找关联该底层 session 的真正 Ask 会话，避免将 Document ID 误作为 AskConversation ID
      const matchedAskConv = conversations.find(
        (c) => c.config?.session_id === sid || c.id === sid
      );
      if (matchedAskConv) {
        activeConversationIdRef.current = matchedAskConv.id;
        setActiveConversationId(matchedAskConv.id);
        window.history.replaceState(null, "", `/ask?id=${matchedAskConv.id}`);
        try {
          localStorage.setItem("memento_last_ask_conv_id", matchedAskConv.id);
        } catch {}
        try {
          const detail = await api.getAskConversation(matchedAskConv.id, 40);
          if (detail?.device_id && detail.device_id !== "auto") {
            setSelectedDevice(normalizeDeviceId(detail.device_id));
          }
          if (detail?.turns && detail.turns.length > 0) {
            setTurns(detail.turns);
            return;
          }
        } catch {}
      } else {
        try {
          const ensured = await api.ensureConversationBySession({
            session_id: sid,
            project_id: selectedProjectIdRef.current || selectedProjectId || undefined,
            execution_mode: executionMode,
            device_id: selectedDevice,
            cwd: cwd.trim() || undefined,
          });
          if (ensured && ensured.id) {
            activeConversationIdRef.current = ensured.id;
            setActiveConversationId(ensured.id);
            window.history.replaceState(null, "", `/ask?id=${ensured.id}`);
            try {
              localStorage.setItem("memento_last_ask_conv_id", ensured.id);
            } catch {}
            if (ensured.device_id && ensured.device_id !== "auto") {
              setSelectedDevice(normalizeDeviceId(ensured.device_id));
            }
            if (ensured.turns && ensured.turns.length > 0) {
              setTurns(ensured.turns);
              return;
            }
          }
        } catch (e) {
          console.warn("Failed to ensure conversation by session:", e);
        }
      }
      setTurns(loadedTurns);
    },
    [conversations, cwd, executionMode, normalizeDeviceId, selectedDevice, selectedProjectId, sessions, startNewChat]
  );

  // Sync projects on initial load if starting in agent mode (ONLY when no conversation is active/restoring)
  useEffect(() => {
    if (!activeConversationId && !isRestoringRef.current && ["codex", "claude", "antigravity", "workbuddy"].includes(executionMode)) {
      if (projects.length === 0) {
        loadProjectsForMode(executionMode);
      }
    }
  }, [executionMode, activeConversationId, projects.length, loadProjectsForMode]);

  const currentDev = devices.find(
    (d) =>
      d.device_id === selectedDevice ||
      d.id === selectedDevice ||
      d.name === selectedDevice ||
      d.name?.toLowerCase() === selectedDevice?.toLowerCase()
  );
  const isCurrentDevOnline = currentDev
    ? (currentDev.online ?? (currentDev.last_heartbeat ? (Date.now() - new Date(currentDev.last_heartbeat).getTime()) < 180_000 : false))
    : true;
  let placeholderText = t.ask.placeholderAgent;
  if (executionMode === "claude") {
    placeholderText = isZh ? "向 Claude Code 派发任务或提问..." : (t.ask.placeholderClaude || "Dispatch task to Claude Code...");
  } else if (executionMode === "codex") {
    placeholderText = isZh ? "向 Codex 派发任务或提问..." : (t.ask.placeholderCodex || "Dispatch task to OpenAI Codex...");
  } else if (executionMode === "antigravity") {
    placeholderText = isZh ? "向 Antigravity 派发任务或提问..." : (t.ask.placeholderAntigravity || "Dispatch task to Antigravity...");
  } else if (executionMode === "workbuddy") {
    placeholderText = isZh ? "向 WorkBuddy 派发任务或提问..." : "Dispatch task to WorkBuddy...";
  } else if (executionMode === "shell") {
    placeholderText = isZh ? "输入要在目标机执行的 Shell 命令..." : (t.ask.placeholderShell || "Execute Shell command on target device...");
  } else if (selectedDevice === "ask_only") {
    placeholderText = t.ask.placeholderAskOnly;
  } else if (currentDev) {
    placeholderText = isZh ? `在 ${currentDev.name} 上执行任务或提问...` : `Run task or question on ${currentDev.name}...`;
  }

  // Active question waiting for user input across recent turns
  const activeWaitingQuestion = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i];
      if (turn.toolCalls) {
        for (const tc of turn.toolCalls) {
          const events = tc.result?.events;
          if (events && Array.isArray(events)) {
            const q = events.find(
              (e: any) => e.kind === "question" && (e.status === "waiting" || !e.status) && !e.answer
            ) as any;
            if (q) {
              return {
                question: q,
                taskId: tc.result?.task_id || tc.id,
                device: tc.result?.device_name || tc.device_name || "",
              };
            }
          }
        }
      }
    }
    return null;
  }, [turns]);

  // Smart device routing recommendation based on prompt input
  const suggestedDevice = useMemo(() => {
    if (!input || !devices || devices.length <= 1) return null;
    const lower = input.toLowerCase();
    const osOf = (d?: DeviceSummary) => {
      const n = (d?.name || "").toLowerCase();
      if (n.includes("windows") || n.startsWith("desktop-") || n.startsWith("laptop-")) return "windows";
      if (n.includes("darwin") || n.includes("mac")) return "mac";
      if (n.includes("linux")) return "linux";
      return "";
    };
    // Suggest only when the device picked can't be the one meant: a Mac path on another Mac is fine
    const currentOs = osOf(devices.find((d) => d.device_id === selectedDevice));
    const firstOf = (os: string) =>
      devices.filter((d) => osOf(d) === os).sort((a, b) => Number(isDeviceOnline(b)) - Number(isDeviceOnline(a)))[0];

    const hasWinPath = /\b[cd]:[\\/]/.test(lower) || /\b(powershell|cmd\.exe|choco|winget)\b/.test(lower);
    if (hasWinPath && currentOs !== "windows") {
      const winDev = firstOf("windows");
      if (winDev) return { device: winDev, reason: isZh ? "检测到 Windows 路径/命令" : "Windows path/command detected" };
    }

    const hasMacPath = /(^|[\s"'`(=])\/users\//.test(lower) || lower.includes(".app/") || /\b(brew\s+|osascript|launchctl)\b/.test(lower);
    if (hasMacPath && currentOs !== "mac") {
      const macDev = firstOf("mac");
      if (macDev) return { device: macDev, reason: isZh ? "检测到 macOS 路径/命令" : "macOS path/command detected" };
    }

    return null;
  }, [input, devices, selectedDevice, isZh]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId),
    [conversations, activeConversationId]
  );
  const displayConvTitle = useMemo(() => {
    const raw = activeConversation?.title?.trim();
    if (raw && raw.toLowerCase() !== "start" && raw !== t.ask.title) return raw;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "user" && turns[i].content?.trim()) {
        const cleaned = turns[i].content
          .replace(/^【用户上传了图片[\s\S]*?提示:[^\n]*\n*/g, "")
          .trim();
        if (cleaned) return cleaned;
      }
    }
    return raw || t.ask.title;
  }, [activeConversation?.title, turns, t.ask.title]);

  const displayConvTitleRef = useRef(displayConvTitle);
  useEffect(() => {
    displayConvTitleRef.current = displayConvTitle;
  }, [displayConvTitle]);

  const getTurnAbsIndex = useCallback((localIdx: number) => {
    const curTurns = turnsRef.current;
    const t = curTurns[localIdx] as any;
    if (t && typeof t.index === "number") {
      return t.index;
    }
    const baseOffset = totalTurns > curTurns.length ? totalTurns - curTurns.length : 0;
    return baseOffset + localIdx;
  }, [totalTurns]);

  const toggleSelectTurn = useCallback((index: number) => {
    setSelectedTurnIndices((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]
    );
  }, []);

  const handleShareSelectedTurns = useCallback(() => {
    const convId = activeConversationIdRef.current;
    if (!convId || selectedTurnIndices.length === 0) return;
    const sorted = [...selectedTurnIndices].sort((a, b) => a - b);
    const absIndices = sorted.map(getTurnAbsIndex);
    const targetId = `${convId}:${absIndices.join(",")}`;
    const shareTitle = `${displayConvTitleRef.current || "Memento"} · 精选 (${sorted.length} 条消息)`;
    setShareTargetId(targetId);
    setShareTitle(shareTitle);
    setShareModalOpen(true);
  }, [selectedTurnIndices, getTurnAbsIndex]);

  const handleShareAssistantTurn = useCallback((assistantIndex: number) => {
    const convId = activeConversationIdRef.current;
    if (!convId) return;
    const curTurns = turnsRef.current;
    const localIndices =
      assistantIndex > 0 && curTurns[assistantIndex - 1]?.role === "user"
        ? [assistantIndex - 1, assistantIndex]
        : [assistantIndex];
    const turnIndices = localIndices.map(getTurnAbsIndex);
    const questionTurn =
      assistantIndex > 0 && curTurns[assistantIndex - 1]?.role === "user"
        ? curTurns[assistantIndex - 1]
        : curTurns[assistantIndex];
    const excerpt = questionTurn?.content?.trim().slice(0, 36) || "问答";
    const shareTitle = `${displayConvTitleRef.current || "Memento"} · 提问：${excerpt}${questionTurn?.content?.trim().length > 36 ? "..." : ""}`;
    setShareTargetId(`${convId}:${turnIndices.join(",")}`);
    setShareTitle(shareTitle);
    setShareModalOpen(true);
  }, [getTurnAbsIndex]);

  const handleShareUserTurn = useCallback((userIndex: number) => {
    const convId = activeConversationIdRef.current;
    if (!convId) return;
    const curTurns = turnsRef.current;
    const localIndices =
      userIndex + 1 < curTurns.length && curTurns[userIndex + 1]?.role === "assistant"
        ? [userIndex, userIndex + 1]
        : [userIndex];
    const turnIndices = localIndices.map(getTurnAbsIndex);
    const excerpt = curTurns[userIndex]?.content?.trim().slice(0, 36) || "问答";
    const shareTitle = `${displayConvTitleRef.current || "Memento"} · 提问：${excerpt}${curTurns[userIndex]?.content?.trim().length > 36 ? "..." : ""}`;
    setShareTargetId(`${convId}:${turnIndices.join(",")}`);
    setShareTitle(shareTitle);
    setShareModalOpen(true);
  }, [getTurnAbsIndex]);

  const renderedTurns = useMemo(() => {
    const eagerThreshold = Math.max(0, turns.length - 4);
    return turns.map((turn, i) => {
      const isRecentOrStreaming = i >= eagerThreshold || (i === turns.length - 1 && streaming);
      const contentVisibilityStyle: React.CSSProperties = isRecentOrStreaming
        ? {}
        : {
            contentVisibility: "auto",
            containIntrinsicSize: turn.role === "user" ? "0 80px" : "0 140px",
          };
      const prevUserCreatedAt =
        turn.role === "assistant" && i > 0 && turns[i - 1]?.role === "user"
          ? turns[i - 1].created_at
          : undefined;

      const isSelected = selectedTurnIndices.includes(i);
      const stableKey = (turn as any).id || (turn.created_at ? `${turn.role}-${turn.created_at}-${i}` : `turn-${i}`);

      return (
        <div
          key={stableKey}
          style={contentVisibilityStyle}
          className={selectTurnsMode ? "flex items-start gap-2.5 my-1.5 transition-all group/turn-row" : ""}
        >
          {selectTurnsMode && (
            <div
              onClick={() => toggleSelectTurn(i)}
              className="pt-2 sm:pt-3 shrink-0 cursor-pointer select-none flex items-center justify-center"
              title={isSelected ? "取消选择" : "选择此条消息"}
            >
              <div
                className={`w-5 h-5 rounded-md border flex items-center justify-center transition-all ${
                  isSelected
                    ? "bg-[var(--aurora-accent)] border-[var(--aurora-accent)] text-slate-900 shadow-sm"
                    : "border-[var(--aurora-border-strong)] bg-[var(--aurora-chip)] hover:border-[var(--aurora-accent)] text-transparent"
                }`}
              >
                <Icon name="check" size={13} style={{ strokeWidth: 3 }} />
              </div>
            </div>
          )}
          <div className="flex-1 min-w-0">
            {turn.role === "user" ? (
              <UserBubble
                index={i}
                content={turn.content}
                images={turn.images}
                createdAt={turn.created_at}
                onShareTurn={handleShareUserTurn}
              />
            ) : (
              <AssistantBubble
                index={i}
                turn={turn}
                isLast={i === turns.length - 1}
                streaming={i === turns.length - 1 ? streaming : false}
                isReconnecting={i === turns.length - 1 ? isReconnecting : false}
                prevUserCreatedAt={prevUserCreatedAt}
                onSourcesClick={handleSourcesClick}
                onSmartCompactAndRetry={handleSmartCompactAndRetry}
                onRetry={i === turns.length - 1 ? handleRetryLastTurn : undefined}
                onShareTurn={handleShareAssistantTurn}
                t={t}
              />
            )}
          </div>
        </div>
      );
    });
  }, [
    turns,
    streaming,
    handleSourcesClick,
    handleSmartCompactAndRetry,
    handleRetryLastTurn,
    selectTurnsMode,
    selectedTurnIndices,
    toggleSelectTurn,
    handleShareAssistantTurn,
    handleShareUserTurn,
    t,
  ]);

  return (
    <div className="w-full flex h-[calc(100dvh-2.75rem)] sm:h-[calc(100dvh-5rem)] md:h-[calc(100dvh-5.5rem)] rounded-none sm:rounded-2xl border-0 sm:border border-[var(--aurora-border-strong)] bg-[var(--aurora-bg)] sm:bg-[var(--aurora-surface-solid)]/40 sm:backdrop-blur-xl overflow-hidden sm:shadow-2xl relative">
      {/* 主对话区与输入控制台 */}
      <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden relative bg-transparent">
        {/* 对话区顶部 Bar */}
        <header className="px-2 sm:px-4 py-1.5 sm:py-2.5 border-b border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)]/95 sm:bg-[var(--aurora-surface-solid)]/75 sm:backdrop-blur-md flex items-center justify-between gap-1.5 sm:gap-2.5 shrink-0 select-none relative z-20">
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1 mr-1 sm:mr-2">
            <Btn
              variant="glass"
              size="sm"
              icon="clock"
              onClick={() => {
                setHistoryOpen(true);
                void loadConversations();
              }}
              title={isZh ? "查看历史对话" : "View history"}
              className="shrink-0"
            >
              <span className="hidden md:inline">{t.ask.historyTitle}</span>
              {conversations.length > 0 && (
                <span
                  style={{
                    fontSize: 10.5,
                    padding: "1px 5px",
                    borderRadius: 999,
                    background: "var(--aurora-chip)",
                    color: "var(--aurora-fg3)",
                    marginLeft: 2,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {conversations.length}
                </span>
              )}
            </Btn>
            <div className="min-w-0 flex-1 overflow-hidden">
              <h1
                className="text-[13px] sm:text-sm font-semibold text-[var(--aurora-fg1)] truncate"
                title={displayConvTitle}
              >
                {displayConvTitle}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-1 sm:gap-1.5 shrink-0 relative">
            {/* 工作台独立视窗快捷开关 (若对话中有文档、视频或照片，高亮并提示) */}
            {inspector && inspector.mediaList.length > 0 && (
              <Btn
                variant={inspector.isOpen ? "primary" : "glass"}
                size="sm"
                icon="sidebar"
                onClick={inspector.toggleInspector}
                title={inspector.isOpen ? (isZh ? "折叠工作台视窗" : "Collapse workbench inspector") : (isZh ? "展开工作台预览" : "Open workbench inspector")}
                className="shrink-0"
              >
                <span className="flex items-center gap-1 sm:gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                  <span className="font-medium">
                    <span className="hidden xl:inline">
                      {inspector.mediaList.some((m) => m.type === "markdown") ? (isZh ? "工作台预览" : "Workbench") : (isZh ? "媒体视窗" : "Media")}
                    </span>
                    <span className="hidden sm:inline xl:hidden">{isZh ? "工作台" : "Desk"}</span>
                  </span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-black/20 font-mono font-bold">
                    {inspector.mediaList.length}
                  </span>
                </span>
              </Btn>
            )}
            {/* AI 订阅与额度监控入口 */}
            <Btn
              variant="glass"
              size="sm"
              icon="activity"
              onMouseEnter={() => {
                void api.getAgentQuotas(selectedDevice);
              }}
              onClick={() => setQuotaOpen(true)}
              title={isZh ? "查看各个 AI 订阅工具额度 (Antigravity/Claude/Codex/WorkBuddy)" : "View AI Subscriptions & Quotas"}
              className="shrink-0"
            >
              <span className="flex items-center gap-1">
                <span className="hidden 2xl:inline-block w-1.5 h-1.5 rounded-full bg-cyan-400" />
                <span className="hidden 2xl:inline text-xs font-medium">AI 额度</span>
                {(() => {
                  const targetTool = executionMode === "claude"
                    ? quotasData?.tools?.claude_code
                    : executionMode === "codex"
                    ? quotasData?.tools?.codex
                    : executionMode === "workbuddy"
                    ? quotasData?.tools?.workbuddy
                    : quotasData?.tools?.antigravity;
                  const percent = targetTool?.remaining_percent;
                  if (percent != null) {
                    return (
                      <span
                        className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded-full tabular-nums ${
                          percent > 30 ? "quota-badge-teal" : "quota-badge-amber"
                        }`}
                      >
                        {Math.round(percent)}%
                      </span>
                    );
                  }
                  if (targetTool?.tier) {
                    return (
                      <span className="quota-badge-neutral text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                        {targetTool.tier}
                      </span>
                    );
                  }
                  return (
                    <span
                      className={`text-[10.5px] font-semibold px-1.5 py-0.5 rounded-full ${
                        targetTool?.available ? "quota-badge-emerald" : "quota-badge-neutral"
                      }`}
                    >
                      {targetTool?.available ? "可用" : "未启动"}
                    </span>
                  );
                })()}
              </span>
            </Btn>
            <Btn
              variant="glass"
              size="sm"
              icon="plus"
              onClick={startNewChat}
              title={t.ask.newChat}
              className="shrink-0"
            >
              <span className="hidden xl:inline">{t.ask.newChat}</span>
            </Btn>

            {/* 桌面端大屏幕平铺操作按钮 (>= md) */}
            {activeConversationId && turns.length > 0 && (
              <div className="hidden md:flex items-center gap-1 sm:gap-1.5">
                <Btn
                  variant={selectTurnsMode ? "primary" : "glass"}
                  size="sm"
                  icon="layers"
                  onClick={() => {
                    setSelectTurnsMode(!selectTurnsMode);
                    setSelectedTurnIndices([]);
                  }}
                  title={isZh ? "多选消息/问答分享" : "Select messages to share"}
                  className="shrink-0"
                >
                  <span className="hidden xl:inline">{isZh ? "多选" : "Select"}</span>
                </Btn>
                <Btn
                  variant="glass"
                  size="sm"
                  icon="download"
                  onClick={handleExportMarkdown}
                  title={isZh ? "导出 Markdown 研报记录" : "Export Markdown report"}
                  className="shrink-0"
                >
                  <span className="hidden xl:inline">{isZh ? "导出" : "Export"}</span>
                </Btn>
                <Btn
                  variant="glass"
                  size="sm"
                  icon="share"
                  onClick={() => openSingleShare(activeConversationId, displayConvTitle)}
                  title={isZh ? "分享整场对话" : "Share full conversation"}
                  className="shrink-0"
                >
                  <span className="hidden xl:inline">{isZh ? "分享" : "Share"}</span>
                </Btn>
              </div>
            )}
            {turns.length > 0 && (
              <Btn
                variant="ghost"
                size="sm"
                icon="trash"
                title={t.ask.clear}
                onClick={() => {
                  abortRef.current?.abort();
                  setTurns([]);
                }}
                className="hidden md:inline-flex shrink-0"
              >
                <span className="hidden xl:inline">{t.ask.clear}</span>
              </Btn>
            )}

            {/* 移动端折叠更多菜单 (< md 屏幕) */}
            {turns.length > 0 && (
              <div className="relative md:hidden shrink-0">
                <Btn
                  variant={selectTurnsMode ? "primary" : "glass"}
                  size="sm"
                  icon="more"
                  onClick={() => setMoreMenuOpen(!moreMenuOpen)}
                  title={isZh ? "更多会话操作" : "More actions"}
                  className="shrink-0"
                />

                {moreMenuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setMoreMenuOpen(false)}
                    />
                    <div
                      className="absolute right-0 top-10 z-50 min-w-[170px] py-1.5 rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)]/98 backdrop-blur-xl shadow-2xl flex flex-col gap-0.5 animate-in fade-in zoom-in-95 duration-100"
                    >
                      {activeConversationId && (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectTurnsMode(!selectTurnsMode);
                              setSelectedTurnIndices([]);
                              setMoreMenuOpen(false);
                            }}
                            className={`px-3 py-2 text-xs flex items-center gap-2.5 hover:bg-[var(--aurora-chip)] transition-colors text-left ${
                              selectTurnsMode ? "text-[var(--aurora-accent)] font-semibold" : "text-[var(--aurora-fg1)]"
                            }`}
                          >
                            <Icon name="layers" size={15} />
                            <span>{selectTurnsMode ? (isZh ? "退出多选模式" : "Exit selection") : (isZh ? "批量多选消息" : "Select messages")}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              handleExportMarkdown();
                              setMoreMenuOpen(false);
                            }}
                            className="px-3 py-2 text-xs flex items-center gap-2.5 text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] transition-colors text-left"
                          >
                            <Icon name="download" size={15} />
                            <span>{isZh ? "导出 Markdown 研报" : "Export Markdown"}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              openSingleShare(activeConversationId, displayConvTitle);
                              setMoreMenuOpen(false);
                            }}
                            className="px-3 py-2 text-xs flex items-center gap-2.5 text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] transition-colors text-left"
                          >
                            <Icon name="share" size={15} />
                            <span>{isZh ? "分享完整会话" : "Share conversation"}</span>
                          </button>
                          <div className="my-1 border-t border-[var(--aurora-border)]" />
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          abortRef.current?.abort();
                          setTurns([]);
                          setMoreMenuOpen(false);
                        }}
                        className="px-3 py-2 text-xs flex items-center gap-2.5 text-rose-400 hover:bg-rose-500/10 transition-colors text-left"
                      >
                        <Icon name="trash" size={15} />
                        <span>{isZh ? "清空当前消息" : "Clear conversation"}</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </header>

        {/* 中栏消息滚动列表 */}
        <div className="relative flex-1 min-h-0 flex flex-col">
          <div
            ref={chatScrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              if (askCache) {
                askCache.scrollTop = el.scrollTop;
              }
              const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
              setShowScrollBottom(dist > 180);
            }}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            className="flex-1 overflow-y-auto px-2.5 sm:px-5 md:px-8 py-3 sm:py-6 select-text"
          style={{
            contain: "content",
            overscrollBehaviorY: "contain",
            userSelect: "text",
            WebkitUserSelect: "text",
          }}
        >
          <div className="w-full max-w-3xl xl:max-w-4xl 2xl:max-w-5xl mx-auto space-y-3 sm:space-y-4 select-text" style={{ userSelect: "text", WebkitUserSelect: "text" }}>

      {turns.length === 0 && (
        <Glass padding="clamp(16px, 4vw, 32px)" radius={20} style={{ textAlign: "center", marginBottom: 20, maxWidth: "100%", minWidth: 0 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 48,
              height: 48,
              borderRadius: 14,
              background: "rgba(56, 189, 248, 0.12)",
              color: "var(--aurora-accent)",
              marginBottom: 12,
            }}
          >
            <Icon name="terminal" size={26} />
          </div>
          <h3 style={{ fontSize: 16, fontWeight: 600, color: "var(--aurora-fg1)", margin: "0 0 6px" }}>
            {t.ask.title}
          </h3>
          <p style={{ color: "var(--aurora-fg3)", fontSize: 13.5, margin: "0 0 18px" }}>
            {t.ask.empty}
          </p>

          {/* Quick command pills */}
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            {[
              { label: t.ask.sugGitStatus, icon: "code" as const },
              { label: t.ask.sugPorts, icon: "activity" as const },
              { label: t.ask.sugDevices, icon: "devices" as const },
              { label: t.ask.sugRecentSummary, icon: "sparkles" as const },
            ].map((s, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => {
                  sendWithText(s.label);
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 14px",
                  borderRadius: 9999,
                  background: "var(--aurora-chip)",
                  border: "1px solid var(--aurora-border)",
                  color: "var(--aurora-fg2)",
                  fontSize: 12.5,
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--aurora-accent)";
                  e.currentTarget.style.color = "var(--aurora-fg1)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--aurora-border)";
                  e.currentTarget.style.color = "var(--aurora-fg2)";
                }}
              >
                <Icon name={s.icon} size={13} style={{ color: "var(--aurora-accent)" }} />
                <span>{s.label}</span>
              </button>
            ))}
          </div>
        </Glass>
      )}

      {/* Conversation turns list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: "100%", minWidth: 0 }}>
        {hasMoreTurns && (
          <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
            <button
              type="button"
              onClick={loadAllHistoryTurns}
              disabled={loadingMoreTurns}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 14px",
                borderRadius: 16,
                fontSize: 12,
                color: "var(--aurora-fg2)",
                background: "var(--aurora-chip)",
                border: "1px solid var(--aurora-border)",
                cursor: loadingMoreTurns ? "default" : "pointer",
                transition: "all 0.15s ease",
              }}
              onMouseEnter={(e) => {
                if (!loadingMoreTurns) {
                  e.currentTarget.style.borderColor = "var(--aurora-accent)";
                  e.currentTarget.style.color = "var(--aurora-accent)";
                }
              }}
              onMouseLeave={(e) => {
                if (!loadingMoreTurns) {
                  e.currentTarget.style.borderColor = "var(--aurora-border)";
                  e.currentTarget.style.color = "var(--aurora-fg2)";
                }
              }}
            >
              {loadingMoreTurns ? (
                <>
                  <Icon name="refresh" size={13} className="animate-spin" />
                  <span>{isZh ? "正在加载更早历史..." : "Loading earlier history..."}</span>
                </>
              ) : (
                <>
                  <Icon name="clock" size={13} />
                  <span>
                    {isZh
                      ? `加载更早的历史记录 (${totalTurns > turns.length ? `${totalTurns - turns.length} 条` : "全部"})`
                      : `Load earlier history (${totalTurns > turns.length ? `${totalTurns - turns.length} more` : "all"})`}
                  </span>
                </>
              )}
            </button>
          </div>
        )}
        {renderedTurns}
        <div ref={bottomRef} style={{ height: 1, minHeight: 1, overflow: "hidden", pointerEvents: "none" }} />
      </div>
    </div>
  </div>
    {/* 回到底部悬浮快捷键 */}
    {showScrollBottom && turns.length > 0 && (
      <button
        type="button"
        onClick={() => {
          chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: "smooth" });
        }}
        className="absolute bottom-4 right-5 sm:right-8 z-30 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold shadow-xl transition-all transform hover:scale-105 cursor-pointer backdrop-blur-md"
        style={{
          background: "var(--aurora-surface-solid)",
          border: "1px solid var(--aurora-border-strong)",
          color: "var(--aurora-accent)",
          boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
        }}
      >
        <Icon name="arrow_down" size={13} />
        <span>{streaming ? (isZh ? "最新输出" : "Latest") : (isZh ? "回到底部" : "Bottom")}</span>
      </button>
    )}
  </div>
    {/* 多选消息分享操作栏 */}
    {selectTurnsMode && (
      <div className="shrink-0 px-3 sm:px-6 py-2.5 bg-[var(--aurora-surface-solid)]/95 backdrop-blur-md border-t border-[var(--aurora-accent)]/30 shadow-2xl flex items-center justify-between gap-3 z-30 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold text-[var(--aurora-fg1)] flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[var(--aurora-accent)]" />
            <span>
              {isZh
                ? `已选择 ${selectedTurnIndices.length} 条消息`
                : `${selectedTurnIndices.length} messages selected`}
            </span>
          </span>
          <button
            type="button"
            onClick={() => {
              if (selectedTurnIndices.length === turns.length) {
                setSelectedTurnIndices([]);
              } else {
                setSelectedTurnIndices(turns.map((_, idx) => idx));
              }
            }}
            className="text-xs text-[var(--aurora-fg3)] hover:text-white underline cursor-pointer"
          >
            {selectedTurnIndices.length === turns.length
              ? (isZh ? "取消全选" : "Deselect all")
              : (isZh ? "全选" : "Select all")}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Btn
            variant="primary"
            size="sm"
            icon="share"
            disabled={selectedTurnIndices.length === 0}
            onClick={handleShareSelectedTurns}
          >
            {isZh ? "分享所选问答 ↗" : "Share selected ↗"}
          </Btn>
          <Btn
            variant="glass"
            size="sm"
            onClick={() => {
              setSelectTurnsMode(false);
              setSelectedTurnIndices([]);
            }}
          >
            {isZh ? "退出多选" : "Cancel"}
          </Btn>
        </div>
      </div>
    )}

  {/* 中栏底部交互控制台 (作为 flex footer，全面屏安全区适配) */}
  <footer
    className="shrink-0 px-2.5 pt-2 sm:px-3.5 sm:pt-2.5 lg:p-3.5 border-t border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)]/95 sm:bg-[var(--aurora-surface-solid)]/90 sm:backdrop-blur-xl"
    style={{
      paddingBottom: "max(0.5rem, env(safe-area-inset-bottom, 0.5rem))",
    }}
  >
    <div className="max-w-3xl xl:max-w-4xl 2xl:max-w-5xl mx-auto w-full min-w-0" style={{ boxSizing: "border-box" }}>
      <div
        className="p-2.5 sm:px-3.5 sm:py-2.5"
        style={{
          background: isDraggingOver ? "var(--aurora-accent-soft)" : "var(--aurora-surface-solid)",
          border: isDraggingOver ? "2px dashed var(--aurora-accent)" : "1px solid var(--aurora-border-strong)",
          borderRadius: 16,
          boxShadow: isDraggingOver
            ? "0 0 24px rgba(99, 102, 241, 0.25)"
            : "var(--aurora-card-shadow), 0 16px 40px -8px rgba(0,0,0,0.14)",
          maxWidth: "100%",
          width: "100%",
          minWidth: 0,
          boxSizing: "border-box",
          transition: "border 0.2s ease, background 0.2s ease, box-shadow 0.2s ease",
          position: "relative",
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
          if (!isDraggingOver) setIsDraggingOver(true);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDraggingOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setIsDraggingOver(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDraggingOver(false);
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            void addFilesAsImages(e.dataTransfer.files);
          }
        }}
      >
        {/* Drag and Drop Active Overlay */}
        {isDraggingOver && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 15,
              background: "rgba(99, 102, 241, 0.12)",
              backdropFilter: "blur(3px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              zIndex: 40,
              pointerEvents: "none",
              color: "var(--aurora-accent)",
              fontWeight: 600,
              fontSize: 13.5,
            }}
          >
            <Icon name="image" size={18} />
            <span>{isZh ? "释放鼠标以附加图片至提问" : "Drop image to attach to prompt"}</span>
          </div>
        )}
            {isConfigCollapsed ? (
              /* Collapsed Summary Pill Bar */
              <div
                onClick={toggleConfigCollapsed}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 6,
                  marginBottom: 7,
                  padding: "0 0 6px 0",
                  borderBottom: "1px solid var(--aurora-border)",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                  userSelect: "none",
                  minWidth: 0,
                  maxWidth: "100%",
                  boxSizing: "border-box",
                }}
                title={isZh ? "点击展开完整配置面板" : "Click to expand configuration panel"}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    overflowX: "auto",
                    scrollbarWidth: "none",
                    minWidth: 0,
                    flex: 1,
                  }}
                >
                  {/* Current Mode Badge */}
                  {(() => {
                    const currentMode = [
                      { id: "ai" as const, label: t.ask.modeAi || "AI 编排", icon: "brain" as const, color: "var(--aurora-accent)" },
                      { id: "claude" as const, label: t.ask.modeClaude || "Claude Code", brandId: "claude_code" as const, color: "#D97757" },
                      { id: "codex" as const, label: t.ask.modeCodex || "Codex", brandId: "codex" as const, color: "#10A37F" },
                      { id: "antigravity" as const, label: t.ask.modeAntigravity || "Antigravity", brandId: "antigravity" as const, color: "#3186FF" },
                      { id: "workbuddy" as const, label: "WorkBuddy", brandId: "workbuddy" as const, color: "#0EC7A8" },
                      { id: "shell" as const, label: t.ask.modeShell || "Shell 终端", icon: "terminal" as const, color: "#38BDF8" },
                    ].find((m) => m.id === executionMode) || { id: "ai" as const, label: "AI 编排", icon: "brain" as const, color: "var(--aurora-accent)" };

                    const modeQuota = getModeQuotaSummary(executionMode);

                    return (
                      <span
                        onMouseEnter={() => {
                          if (["antigravity", "claude", "codex", "workbuddy"].includes(executionMode)) {
                            void api.getAgentQuotas(selectedDevice);
                          }
                        }}
                        onClick={(e) => {
                          if (["antigravity", "claude", "codex", "workbuddy"].includes(executionMode)) {
                            e.stopPropagation();
                            setQuotaOpen(true);
                          }
                        }}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          padding: "2px 8px",
                          borderRadius: 8,
                          background: "var(--aurora-accent-soft)",
                          border: `1px solid ${currentMode.color}`,
                          color: currentMode.color,
                          fontSize: 11.5,
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                          flexShrink: 0,
                          cursor: ["antigravity", "claude", "codex", "workbuddy"].includes(executionMode) ? "pointer" : "default",
                        }}
                        title={["antigravity", "claude", "codex", "workbuddy"].includes(executionMode) ? "点击查看 AI 订阅与额度详情" : undefined}
                      >
                        {currentMode.brandId ? (
                          <BrandMark id={currentMode.brandId} size={13} colored />
                        ) : (
                          <Icon name={currentMode.icon || "sparkles"} size={12} style={{ color: currentMode.color }} />
                        )}
                        <span>{currentMode.label}</span>
                        {modeQuota && (
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              padding: "0 5px",
                              borderRadius: 4,
                              background: "var(--aurora-chip)",
                              border: "1px solid var(--aurora-border)",
                              color: modeQuota.percent != null && modeQuota.percent < 30 ? "#F59E0B" : "inherit",
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {modeQuota.label}
                          </span>
                        )}
                      </span>
                    );
                  })()}

                  {/* Target Device Badge */}
                  <span
                    className="max-w-[168px] sm:max-w-[260px]"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 8px",
                      borderRadius: 8,
                      background: !isCurrentDevOnline && selectedDevice !== "auto" && selectedDevice !== "ask_only" ? "rgba(239, 68, 68, 0.12)" : "var(--aurora-chip)",
                      border: !isCurrentDevOnline && selectedDevice !== "auto" && selectedDevice !== "ask_only" ? "1px solid rgba(239, 68, 68, 0.4)" : "1px solid var(--aurora-border)",
                      color: !isCurrentDevOnline && selectedDevice !== "auto" && selectedDevice !== "ask_only" ? "#ef4444" : "var(--aurora-fg2)",
                      fontSize: 11.5,
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                      flexShrink: 1,
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        background: !isCurrentDevOnline && selectedDevice !== "auto" && selectedDevice !== "ask_only" ? "#ef4444" : "#10B981",
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {selectedDevice === "auto"
                        ? t.ask.autoDispatch
                        : selectedDevice === "ask_only"
                        ? t.ask.askOnly
                        : `${currentDev?.name?.replace(/ \(\w+\)$/, "") || (selectedDevice.length > 8 ? selectedDevice.slice(0, 8) : selectedDevice)}${!isCurrentDevOnline ? (isZh ? " (离线)" : " (Offline)") : ""}`}
                    </span>
                  </span>

                  {/* Associated Project Badge */}
                  {selectedProjectId && (() => {
                    const displayTitle = resolveSafeProjectName({
                      projectId: selectedProjectId,
                      projectTitle: selectedProjectTitle,
                      projects,
                      cwd,
                      isZh,
                    });
                    return (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "2px 8px",
                          borderRadius: 8,
                          background: "var(--aurora-chip)",
                          border: "1px solid var(--aurora-border)",
                          color: "var(--aurora-fg2)",
                          fontSize: 11.5,
                          fontWeight: 500,
                          whiteSpace: "nowrap",
                          flexShrink: 0,
                        }}
                      >
                        <Icon name="code" size={12} style={{ color: "var(--aurora-fg3)" }} />
                        <span>{displayTitle}</span>
                      </span>
                    );
                  })()}

                  {/* CWD snippet if no project but cwd is set */}
                  {!selectedProjectId && cwd && (() => {
                    const safeFolder = resolveSafeProjectName({ cwd, isZh });
                    return (
                      <span
                        className="max-w-[160px] sm:max-w-[240px]"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "2px 8px",
                          borderRadius: 8,
                          background: "var(--aurora-chip)",
                          border: "1px solid var(--aurora-border)",
                          color: "var(--aurora-fg3)",
                          fontSize: 11,
                          whiteSpace: "nowrap",
                          flexShrink: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                        title={cwd}
                      >
                        <Icon name="folder" size={11} style={{ color: "var(--aurora-accent)" }} />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{safeFolder}</span>
                      </span>
                    );
                  })()}

                  {/* Selected Model Badge */}
                  {selectedModel && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "2px 8px",
                        borderRadius: 8,
                        background: "var(--aurora-chip)",
                        border: "1px solid var(--aurora-border)",
                        color: "var(--aurora-fg3)",
                        fontSize: 11,
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      <Icon name="sparkles" size={11} style={{ color: "var(--aurora-accent)" }} />
                      <span>{selectedModel}</span>
                    </span>
                  )}

                  {/* Reasoning Effort Badge */}
                  {selectedEffort && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                        padding: "2px 6px",
                        borderRadius: 8,
                        background: "var(--aurora-chip)",
                        border: "1px solid var(--aurora-border)",
                        color: "var(--aurora-fg3)",
                        fontSize: 11,
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      <Icon name="brain" size={11} style={{ color: "var(--aurora-accent)" }} />
                      <span>{selectedEffort}</span>
                    </span>
                  )}

                  {/* Resumed Session Badge */}
                  {selectedSessionId && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "2px 8px",
                        borderRadius: 8,
                        background: "var(--aurora-accent-soft)",
                        border: "1px solid var(--aurora-accent)",
                        color: "var(--aurora-accent)",
                        fontSize: 11,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      <Icon name="clock" size={11} />
                      <span>
                        {isZh ? "续接: " : "Resuming: "}
                        {(() => {
                          const s = sessions.find((x) => (x.session_id || x.conversation_id) === selectedSessionId);
                          const isCurrentActive = Boolean(
                            activeConversation &&
                            (activeConversation.config?.session_id === selectedSessionId ||
                             activeConversation.id === selectedSessionId)
                          );
                          const matchedConv = isCurrentActive
                            ? activeConversation
                            : conversations.find((c) => c.config?.session_id === selectedSessionId || c.id === selectedSessionId);
                          const t = s?.title || matchedConv?.title || selectedSessionId;
                          return t.length > 18 ? t.slice(0, 18) + "..." : t;
                        })()}
                      </span>
                    </span>
                  )}
                </div>

                {/* Expand button */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleConfigCollapsed();
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                    background: "var(--aurora-accent-soft)",
                    border: "1px solid var(--aurora-accent)",
                    borderRadius: 8,
                    padding: "2px 7px",
                    color: "var(--aurora-accent)",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                  title={isZh ? "展开完整配置面板" : "Expand configuration panel"}
                >
                  <Icon name="chevron_down" size={11} />
                  <span className="sm:hidden">{isZh ? "配置" : "Config"}</span>
                  <span className="hidden sm:inline">{isZh ? "展开配置" : "Expand"}</span>
                </button>
              </div>
            ) : (
              <div>
                {/* Agent Mode Selector Toolbelt with Collapse button */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    marginBottom: 8,
                    minWidth: 0,
                    maxWidth: "100%",
                    boxSizing: "border-box",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      overflowX: "auto",
                      maxWidth: "calc(100% - 75px)",
                      flex: 1,
                      paddingBottom: 2,
                      scrollbarWidth: "none",
                      WebkitOverflowScrolling: "touch",
                      minWidth: 0,
                    }}
                  >
                    {[
                      { id: "ai" as const, label: t.ask.modeAi || "AI 编排", icon: "brain" as const, color: "var(--aurora-accent)" },
                      { id: "claude" as const, label: t.ask.modeClaude || "Claude Code", brandId: "claude_code", color: "#D97757" },
                      { id: "codex" as const, label: t.ask.modeCodex || "Codex", brandId: "codex", color: "#10A37F" },
                      { id: "antigravity" as const, label: t.ask.modeAntigravity || "Antigravity", brandId: "antigravity", color: "#3186FF" },
                      { id: "workbuddy" as const, label: "WorkBuddy", brandId: "workbuddy", color: "#0EC7A8" },
                      { id: "shell" as const, label: t.ask.modeShell || "Shell 终端", icon: "terminal" as const, color: "#38BDF8" },
                    ].map((m) => {
                      const isSelected = executionMode === m.id;
                      const qSummary = getModeQuotaSummary(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => handleSelectMode(m.id)}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            background: isSelected ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                            border: "1px solid",
                            borderColor: isSelected ? m.color : "var(--aurora-border)",
                            borderRadius: 12,
                            padding: "4px 10px",
                            fontSize: 12,
                            fontWeight: isSelected ? 600 : 500,
                            color: isSelected ? m.color : "var(--aurora-fg2)",
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                            whiteSpace: "nowrap",
                            flexShrink: 0,
                          }}
                        >
                          {m.brandId ? (
                            <BrandMark id={m.brandId} size={14} colored={isSelected} tint={isSelected ? undefined : "var(--aurora-fg3)"} />
                          ) : (
                            <Icon name={m.icon || "sparkles"} size={13} style={{ color: isSelected ? m.color : "var(--aurora-fg3)" }} />
                          )}
                          <span>{m.label}</span>
                          {qSummary && (
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 600,
                                padding: "1px 5px",
                                borderRadius: 6,
                                background: isSelected ? "var(--aurora-card)" : "var(--aurora-surface)",
                                border: "1px solid var(--aurora-border)",
                                color: isSelected ? "var(--aurora-fg1)" : "var(--aurora-fg3)",
                              }}
                            >
                              {qSummary.label}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Export Markdown button */}
                  {turns.length > 0 && (
                    <button
                      type="button"
                      onClick={handleExportMarkdown}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                        background: "var(--aurora-chip)",
                        border: "1px solid var(--aurora-border)",
                        borderRadius: 8,
                        padding: "3px 8px",
                        color: exportingMd ? "#10b981" : "var(--aurora-fg3)",
                        fontSize: 11.5,
                        fontWeight: 500,
                        cursor: "pointer",
                        flexShrink: 0,
                        transition: "all 0.15s ease",
                      }}
                      title={isZh ? "将当前对话与执行结果导出为 Markdown 研报" : "Export conversation to Markdown report"}
                    >
                      <Icon name={exportingMd ? "check" : "download"} size={12} style={{ color: exportingMd ? "#10b981" : undefined }} />
                      <span>{exportingMd ? (isZh ? "已导出" : "Exported") : (isZh ? "导出研报" : "Export")}</span>
                    </button>
                  )}

                  {/* Collapse button */}
                  <button
                    type="button"
                    onClick={toggleConfigCollapsed}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                      background: "var(--aurora-chip)",
                      border: "1px solid var(--aurora-border)",
                      borderRadius: 8,
                      padding: "3px 8px",
                      color: "var(--aurora-fg3)",
                      fontSize: 11.5,
                      fontWeight: 500,
                      cursor: "pointer",
                      flexShrink: 0,
                      transition: "all 0.15s ease",
                    }}
                    title={isZh ? "收起配置面板，释放聊天区域" : "Collapse configuration panel"}
                  >
                    <Icon name="chevron_up" size={12} />
                    <span>{isZh ? "收起" : "Collapse"}</span>
                  </button>
                </div>

            {/* Device & environment toolbelt */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap", maxWidth: "100%", minWidth: 0 }}>
              {/* Target device selector */}
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: !isCurrentDevOnline && selectedDevice !== "auto" && selectedDevice !== "ask_only" ? "rgba(239, 68, 68, 0.08)" : "var(--aurora-chip)",
                  border: !isCurrentDevOnline && selectedDevice !== "auto" && selectedDevice !== "ask_only" ? "1px solid rgba(239, 68, 68, 0.5)" : "1px solid var(--aurora-border)",
                  borderRadius: 10,
                  padding: "4px 10px",
                  fontSize: 12,
                  maxWidth: "100%",
                  minWidth: 0,
                }}
              >
                <Icon name="devices" size={13} style={{ color: !isCurrentDevOnline && selectedDevice !== "auto" && selectedDevice !== "ask_only" ? "#ef4444" : "var(--aurora-accent)", flexShrink: 0 }} />
                <select
                  value={selectedDevice}
                  onChange={(e) => handleDeviceChange(e.target.value)}
                  style={{
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    color: "var(--aurora-fg1)",
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: "pointer",
                    maxWidth: "min(220px, 60vw)",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}
                >
                  <option value="auto" style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                    {t.ask.autoDispatch}
                  </option>
                  {selectedDevice && !["auto", "ask_only", "all"].includes(selectedDevice) && !devices.some((d) => d.device_id === selectedDevice) && (
                    <option value={selectedDevice} style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                      💻 {selectedDevice}
                    </option>
                  )}
                  {devices.map((d) => {
                    const isOnline = d.online ?? (d.last_heartbeat ? (Date.now() - new Date(d.last_heartbeat).getTime()) < 180_000 : false);
                    return (
                      <option key={d.device_id} value={d.device_id} style={{ background: "var(--aurora-surface-solid)", color: isOnline ? "var(--aurora-fg1)" : "var(--aurora-fg3)" }}>
                        {isOnline ? "🟢" : "🔴"} {d.name} ({isOnline ? (isZh ? "在线" : "Online") : (isZh ? "离线" : "Offline")})
                      </option>
                    );
                  })}
                  <option value="ask_only" style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                    {t.ask.askOnly}
                  </option>
                </select>
                {!isCurrentDevOnline && selectedDevice !== "auto" && selectedDevice !== "ask_only" && (
                  <span
                    title={isZh ? "目标设备当前离线，请在目标机器上启动 Memento 客户端" : "Target device is offline, please start Memento on target device"}
                    style={{
                      fontSize: 11,
                      color: "#ef4444",
                      fontWeight: 600,
                      display: "inline-flex",
                      alignItems: "center",
                      whiteSpace: "nowrap",
                    }}
                  >
                    ⚠️ {isZh ? "离线" : "Offline"}
                  </span>
                )}
              </div>

              {/* Optional working directory selector */}
              {selectedDevice !== "ask_only" && (
                showCwd ? (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      background: "var(--aurora-chip)",
                      border: "1px solid var(--aurora-accent)",
                      borderRadius: 10,
                      padding: "4px 10px",
                      flex: 1,
                      minWidth: "min(140px, 100%)",
                      maxWidth: "100%",
                    }}
                  >
                    <Icon name="folder" size={13} style={{ color: "var(--aurora-accent)", flexShrink: 0 }} />
                    <input
                      type="text"
                      value={cwd}
                      onChange={(e) => {
                        setCwd(e.target.value);
                        persistCurrentConfig({ cwd: e.target.value });
                      }}
                      onBlur={() => {
                        // A folder outside the project's no longer belongs to that project or its sessions
                        const proj = projects.find((p) => p.id === selectedProjectId);
                        const root = projectPathOn(proj, selectedDevice);
                        if (proj && root && cwd.trim() && !pathWithin(cwd, root)) {
                          ++sessionsReqRef.current;
                          setSelectedProjectId("");
                          selectedProjectIdRef.current = "";
                          setSelectedSessionId("");
                          setSessions([]);
                          persistCurrentConfig({ project_id: "", session_id: "" });
                        }
                      }}
                      placeholder={t.ask.cwdPlaceholder}
                      style={{
                        background: "transparent",
                        border: "none",
                        outline: "none",
                        color: "var(--aurora-fg1)",
                        fontSize: 12,
                        fontFamily: "monospace",
                        width: "100%",
                        minWidth: 0,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowCwd(false)}
                      style={{ background: "none", border: "none", color: "var(--aurora-fg4)", cursor: "pointer", padding: 0, flexShrink: 0 }}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowCwd(true)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      background: cwd ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                      border: "1px solid",
                      borderColor: cwd ? "var(--aurora-accent)" : "var(--aurora-border)",
                      borderRadius: 10,
                      padding: "4px 10px",
                      fontSize: 12,
                      fontWeight: 500,
                      color: cwd ? "var(--aurora-accent)" : "var(--aurora-fg2)",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                      maxWidth: "min(200px, 45vw)",
                      minWidth: 0,
                    }}
                  >
                    <Icon name="folder" size={12} style={{ flexShrink: 0 }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {cwd ? cwd : t.ask.cwdLabel}
                    </span>
                  </button>
                )
              )}

              {/* Agent Model selector */}
              {["codex", "claude", "antigravity", "workbuddy"].includes(executionMode) && (
                isCustomModel ? (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      background: "var(--aurora-chip)",
                      border: "1px solid var(--aurora-accent)",
                      borderRadius: 10,
                      padding: "4px 10px",
                      fontSize: 12,
                      maxWidth: "100%",
                      minWidth: 0,
                    }}
                    title={isZh ? "输入任意模型名称或标识符" : "Input custom model identifier"}
                  >
                    <Icon name="sparkles" size={13} style={{ color: "var(--aurora-accent)", flexShrink: 0 }} />
                    <input
                      type="text"
                      value={selectedModel}
                      onChange={(e) => {
                        setSelectedModel(e.target.value);
                        persistCurrentConfig({ model: e.target.value });
                      }}
                      placeholder={isZh ? "输入模型名称, 如 gpt-6-astra..." : "Model name, e.g. gpt-6-astra..."}
                      autoFocus
                      style={{
                        background: "transparent",
                        border: "none",
                        outline: "none",
                        color: "var(--aurora-fg1)",
                        fontSize: 12,
                        fontFamily: "monospace",
                        width: "min(160px, 35vw)",
                        minWidth: 0,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setIsCustomModel(false);
                        setSelectedModel("");
                        persistCurrentConfig({ model: "" });
                      }}
                      style={{ background: "none", border: "none", color: "var(--aurora-fg4)", cursor: "pointer", padding: 0, flexShrink: 0 }}
                      title={isZh ? "返回快捷预设列表" : "Return to preset list"}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                ) : (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      background: selectedModel ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                      border: "1px solid",
                      borderColor: selectedModel ? "var(--aurora-accent)" : "var(--aurora-border)",
                      borderRadius: 10,
                      padding: "4px 10px",
                      fontSize: 12,
                      maxWidth: "100%",
                      minWidth: 0,
                    }}
                    title={isZh ? "选择调用的模型" : "Select model"}
                  >
                    <Icon name="sparkles" size={13} style={{ color: selectedModel ? "var(--aurora-accent)" : "var(--aurora-fg3)", flexShrink: 0 }} />
                    <select
                      value={selectedModel}
                      onChange={(e) => {
                        if (e.target.value === "__custom__") {
                          setIsCustomModel(true);
                          setSelectedModel("");
                          persistCurrentConfig({ model: "" });
                        } else {
                          setSelectedModel(e.target.value);
                          persistCurrentConfig({ model: e.target.value });
                        }
                      }}
                      style={{
                        background: "transparent",
                        border: "none",
                        outline: "none",
                        color: selectedModel ? "var(--aurora-accent)" : "var(--aurora-fg1)",
                        fontSize: 12,
                        fontWeight: selectedModel ? 600 : 500,
                        cursor: "pointer",
                        maxWidth: "min(200px, 50vw)",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        minWidth: 0,
                      }}
                    >
                      {((capabilities?.models && capabilities.models.length > 0)
                        ? capabilities.models
                        : (FALLBACK_AGENT_MODELS[executionMode] || [])
                      ).map((m) => (
                        <option key={m.id} value={m.id} title={m.desc} style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                          {m.name}
                        </option>
                      ))}
                      <option value="__custom__" style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-accent)" }}>
                        {isZh ? "✏️ 自定义输入任意模型..." : "✏️ Custom model..."}
                      </option>
                    </select>
                    <button
                      type="button"
                      onClick={() => reloadCapabilities(true)}
                      disabled={isRefreshingCaps}
                      title={isZh ? "点击自动从设备与官方在线拉取最新模型" : "Sync latest models from device & upstream"}
                      style={{
                        background: "none",
                        border: "none",
                        padding: "2px 2px",
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "var(--aurora-fg3)",
                        opacity: isRefreshingCaps ? 0.5 : 0.8,
                        transition: "color 0.15s ease, opacity 0.15s ease",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = "var(--aurora-accent)")}
                      onMouseLeave={(e) => (e.currentTarget.style.color = "var(--aurora-fg3)")}
                    >
                      <Icon name="refresh" size={12} className={isRefreshingCaps ? "animate-spin" : ""} />
                    </button>
                  </div>
                )
              )}

              {/* Agent Reasoning Effort selector (Low / Medium / High) */}
              {["codex", "claude", "antigravity", "workbuddy"].includes(executionMode) && (capabilities?.supports_effort || executionMode === "codex" || executionMode === "workbuddy") && (
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    background: selectedEffort ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                    border: "1px solid",
                    borderColor: selectedEffort ? "var(--aurora-accent)" : "var(--aurora-border)",
                    borderRadius: 10,
                    padding: "4px 10px",
                    fontSize: 12,
                    maxWidth: "100%",
                    minWidth: 0,
                  }}
                  title={isZh ? "调节推理思考深度 (Reasoning Effort)" : "Adjust reasoning effort"}
                >
                  <Icon name="brain" size={13} style={{ color: selectedEffort ? "var(--aurora-accent)" : "var(--aurora-fg3)", flexShrink: 0 }} />
                  <select
                    value={selectedEffort}
                    onChange={(e) => {
                      setSelectedEffort(e.target.value);
                      persistCurrentConfig({ effort: e.target.value });
                    }}
                    style={{
                      background: "transparent",
                      border: "none",
                      outline: "none",
                      color: selectedEffort ? "var(--aurora-accent)" : "var(--aurora-fg1)",
                      fontSize: 12,
                      fontWeight: selectedEffort ? 600 : 500,
                      cursor: "pointer",
                      maxWidth: "min(170px, 40vw)",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                    }}
                  >
                    {(capabilities?.effort_options && capabilities.effort_options.length > 0
                      ? capabilities.effort_options
                      : [
                          { id: "", name: isZh ? "⚡ 默认 Effort (跟随配置)" : "⚡ Default Effort" },
                          { id: "low", name: "Low (快速/轻量思考)" },
                          { id: "medium", name: "Medium (标准思考量)" },
                          { id: "high", name: "High (深度推理/高思考量)" },
                        ]
                    ).map((opt) => (
                      <option key={opt.id} value={opt.id} title={opt.desc} style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                        {opt.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Own worktree and branch for the agent */}
              {["codex", "claude", "antigravity", "workbuddy"].includes(executionMode) && (
                <button
                  type="button"
                  onClick={() => {
                    const next = !worktreeMode;
                    setWorktreeMode(next);
                    persistCurrentConfig({ worktree: next });
                  }}
                  aria-pressed={worktreeMode}
                  title={worktreeMode ? t.taskRun.worktreeOn : t.taskRun.worktreeOff}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    background: worktreeMode ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                    border: "1px solid",
                    borderColor: worktreeMode ? "var(--aurora-accent)" : "var(--aurora-border)",
                    borderRadius: 10,
                    padding: "4px 10px",
                    fontSize: 12,
                    color: worktreeMode ? "var(--aurora-accent)" : "var(--aurora-fg2)",
                    fontWeight: worktreeMode ? 600 : 500,
                    cursor: "pointer",
                  }}
                >
                  <Icon name="layers" size={13} />
                  {t.taskRun.worktree}
                </button>
              )}

              {/* Agent Project selector */}
              {["codex", "claude", "antigravity", "workbuddy"].includes(executionMode) && (
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    background: "var(--aurora-chip)",
                    border: "1px solid var(--aurora-border)",
                    borderRadius: 10,
                    padding: "4px 10px",
                    fontSize: 12,
                    maxWidth: "100%",
                    minWidth: 0,
                  }}
                  title={isZh ? "关联项目代码库" : "Associate project repository"}
                >
                  <Icon name="code" size={13} style={{ color: "var(--aurora-fg3)", flexShrink: 0 }} />
                  <select
                    value={selectedProjectId}
                    onChange={(e) => handleSelectProject(e.target.value)}
                    style={{
                      background: "transparent",
                      border: "none",
                      outline: "none",
                      color: "var(--aurora-fg1)",
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: "pointer",
                      maxWidth: "min(200px, 50vw)",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                    }}
                  >
                    <option value="" style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                      {projects.length === 0 ? (isZh ? "暂无项目" : "No projects") : (isZh ? "选择项目 (可选)..." : "Select project (optional)...")}
                    </option>
                    {selectedProjectId && !projects.some((p) => p.id === selectedProjectId) && (() => {
                      const fallbackTitle = resolveSafeProjectName({
                        projectId: selectedProjectId,
                        projectTitle: selectedProjectTitle,
                        projects,
                        cwd,
                        isZh,
                      });
                      return (
                        <option value={selectedProjectId} style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                          📁 {fallbackTitle}
                        </option>
                      );
                    })()}
                    {projects.map((p) => {
                      const safeOptionTitle = resolveSafeProjectName({
                        projectId: p.id,
                        projectTitle: p.title || p.slug,
                        isZh,
                      });
                      return (
                        <option key={p.id} value={p.id} style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                          📁 {safeOptionTitle}
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}

              {/* Agent Historical Session selector */}
              {["codex", "claude", "antigravity", "workbuddy"].includes(executionMode) && (
                selectedProjectId ? (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      background: selectedSessionId ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                      border: "1px solid",
                      borderColor: selectedSessionId ? "var(--aurora-accent)" : "var(--aurora-border)",
                      borderRadius: 10,
                      padding: "4px 10px",
                      fontSize: 12,
                      maxWidth: "100%",
                      minWidth: 0,
                    }}
                    title={isZh ? "续接该项目下的历史会话" : "Resume historical session"}
                  >
                    <Icon name="clock" size={13} style={{ color: selectedSessionId ? "var(--aurora-accent)" : "var(--aurora-fg3)", flexShrink: 0 }} />
                    <select
                      value={selectedSessionId}
                      onChange={(e) => handleSelectSession(e.target.value)}
                      disabled={loadingSessions}
                      style={{
                        background: "transparent",
                        border: "none",
                        outline: "none",
                        color: selectedSessionId ? "var(--aurora-accent)" : "var(--aurora-fg1)",
                        fontSize: 12,
                        fontWeight: selectedSessionId ? 600 : 500,
                        cursor: "pointer",
                        maxWidth: "min(220px, 55vw)",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        minWidth: 0,
                      }}
                    >
                      <option value="" style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                        {loadingSessions ? (isZh ? "加载会话列表中..." : "Loading sessions...") : (isZh ? "➕ 新建独立会话" : "➕ New Session")}
                      </option>
                      {selectedSessionId && !sessions.some((s) => (s.session_id || s.conversation_id) === selectedSessionId) && (() => {
                        const isCurrentActive = Boolean(
                          activeConversation &&
                          (activeConversation.config?.session_id === selectedSessionId ||
                           activeConversation.id === selectedSessionId)
                        );
                        const matchedConv = isCurrentActive
                          ? activeConversation
                          : conversations.find((c) => c.config?.session_id === selectedSessionId || c.id === selectedSessionId);
                        const fallbackTitle = matchedConv?.title || (selectedSessionId.length > 25 ? selectedSessionId.slice(0, 25) + "..." : selectedSessionId);
                        return (
                          <option value={selectedSessionId} style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                            💬 {fallbackTitle.length > 25 ? fallbackTitle.slice(0, 25) + "..." : fallbackTitle}
                          </option>
                        );
                      })()}
                      {sessions.map((s) => {
                        const sid = s.session_id || s.conversation_id;
                        const isHeavy = s.compact_recommended || s.message_count > 35 || (s.file_size_bytes && s.file_size_bytes > 300_000);
                        const tag = isHeavy ? " [⚠️ 建议瘦身]" : "";
                        return (
                          <option key={sid} value={sid} style={{ background: "var(--aurora-surface-solid)", color: "var(--aurora-fg1)" }}>
                            💬 {s.title ? (s.title.length > 25 ? s.title.slice(0, 25) + "..." : s.title) : (sid ? sid.slice(0, 10) + "..." : "会话")}{tag}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                ) : (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      background: "var(--aurora-chip)",
                      border: "1px dashed var(--aurora-border)",
                      borderRadius: 10,
                      padding: "4px 10px",
                      fontSize: 12,
                      color: "var(--aurora-fg3)",
                      opacity: 0.8,
                    }}
                    title={isZh ? "请先选择项目以查看该项目的历史会话列表" : "Select a project to view its historical sessions"}
                  >
                    <Icon name="clock" size={13} style={{ color: "var(--aurora-fg3)", opacity: 0.6, flexShrink: 0 }} />
                    <span>{isZh ? "选项目看历史会话" : "Select project for sessions"}</span>
                  </div>
                )
              )}
            </div>

            {/* Active Resume Session Banner & Historical Context Preview */}
            {selectedSessionId && (() => {
              const activeSession = sessions.find((s) => (s.session_id || s.conversation_id) === selectedSessionId);
              const isCurrentActive = Boolean(
                activeConversation &&
                (activeConversation.config?.session_id === selectedSessionId ||
                 activeConversation.id === selectedSessionId)
              );
              const matchedConv = isCurrentActive
                ? activeConversation
                : conversations.find((c) => c.config?.session_id === selectedSessionId || c.id === selectedSessionId);

              const sessionTitle = activeSession?.title || matchedConv?.title || selectedSessionId;

              let msgs: Array<{ role: string; content: string; timestamp?: string; subagent_name?: string }> = activeSession?.messages || [];
              if (msgs.length === 0 && isCurrentActive && turns.length > 0) {
                msgs = turns.map((t) => ({
                  role: t.role,
                  content: t.content,
                }));
              }
              const previewMsgs = msgs.slice(-5);
              const totalCount = activeSession?.message_count || (isCurrentActive ? (totalTurns || turns.length) : msgs.length);
              const isHeavy = activeSession?.compact_recommended || totalCount > 35 || ((activeSession?.file_size_bytes || 0) > 300_000);

              return (
                <div style={{ marginBottom: 10 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "6px 12px",
                      background: compactMode ? "rgba(16, 185, 129, 0.08)" : "var(--aurora-accent-soft)",
                      border: `1px solid ${compactMode ? "rgba(16, 185, 129, 0.5)" : "var(--aurora-accent)"}`,
                      borderRadius: showSessionContext ? "10px 10px 0 0" : 10,
                      fontSize: 12,
                      color: "var(--aurora-fg1)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }}>
                      <Icon name={compactMode ? "sparkles" : "clock"} size={14} style={{ color: compactMode ? "#10b981" : "var(--aurora-accent)", flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, color: compactMode ? "#10b981" : "var(--aurora-accent)", flexShrink: 0 }}>
                        {compactMode ? (isZh ? "🌟 智能瘦身续接:" : "🌟 Compact resume:") : (isZh ? "续接历史会话:" : "Resuming session:")}
                      </span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--aurora-fg2)", fontWeight: 500 }}>
                        {sessionTitle}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--aurora-fg3)", flexShrink: 0 }}>
                        ({isZh ? `共 ${totalCount} 条消息` : `${totalCount} msgs`})
                      </span>
                      {isHeavy && (
                        <span style={{ fontSize: 10.5, padding: "1px 6px", borderRadius: 4, background: "rgba(245, 158, 11, 0.15)", color: "#f59e0b", fontWeight: 600, flexShrink: 0 }}>
                          ⚠️ {isZh ? "建议瘦身" : "Long"}
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                      <button
                        type="button"
                        onClick={() => {
                          const next = !compactMode;
                          setCompactMode(next);
                          persistCurrentConfig({ compact_mode: next });
                        }}
                        style={{
                          background: compactMode ? "rgba(16, 185, 129, 0.18)" : "var(--aurora-chip)",
                          border: `1px solid ${compactMode ? "#10b981" : "var(--aurora-border)"}`,
                          color: compactMode ? "#10b981" : "var(--aurora-fg2)",
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: 11,
                          padding: "2px 8px",
                          borderRadius: 6,
                          fontWeight: compactMode ? 600 : 500,
                          transition: "all 0.15s ease",
                        }}
                        title={compactMode ? (isZh ? "已开启智能记忆压缩（轻装接续）" : "Smart compaction active") : (isZh ? "切换为智能瘦身模式" : "Switch to smart compact")}
                      >
                        <Icon name="sparkles" size={11} />
                        <span>{compactMode ? (isZh ? "智能瘦身接续" : "Smart Compact") : (isZh ? "原生接续" : "Raw Resume")}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowSessionContext(!showSessionContext)}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--aurora-accent)",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 3,
                          fontSize: 11.5,
                          padding: "2px 6px",
                          borderRadius: 6,
                          fontWeight: 600,
                        }}
                        title={showSessionContext ? (isZh ? "收起历史上下文" : "Collapse context") : (isZh ? "展开历史上下文" : "Expand context")}
                      >
                        <Icon name={showSessionContext ? "chevron_up" : "chevron_down"} size={12} />
                        <span>{showSessionContext ? (isZh ? "收起上下文" : "Hide Context") : (isZh ? "预览上下文" : "Preview Context")}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSelectSession("")}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--aurora-fg3)",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 3,
                          fontSize: 11,
                          padding: "2px 6px",
                          borderRadius: 6,
                          flexShrink: 0,
                        }}
                        title={isZh ? "退出续接，开启新会话" : "Cancel resume, start new"}
                      >
                        <Icon name="close" size={12} />
                        <span>{isZh ? "退出" : "Exit"}</span>
                      </button>
                    </div>
                  </div>

                  {/* Context Preview Drawer */}
                  {showSessionContext && (
                    <div
                      style={{
                        padding: "10px 14px",
                        background: "var(--aurora-surface-solid)",
                        border: "1px solid var(--aurora-accent)",
                        borderTop: "none",
                        borderRadius: "0 0 10px 10px",
                        fontSize: 12,
                        boxShadow: "0 4px 12px rgba(0,0,0,0.06)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: 8,
                          paddingBottom: 6,
                          borderBottom: "1px solid var(--aurora-border)",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontWeight: 600, color: "var(--aurora-fg1)" }}>
                            {isZh ? "历史会话上下文 (最近交互)" : "Historical Context (Recent Turns)"}
                          </span>
                          {previewMsgs.length > 0 && (
                            <span style={{ fontSize: 11, color: "var(--aurora-fg3)" }}>
                              ({isZh ? `显示最近 ${previewMsgs.length} 条` : `Showing last ${previewMsgs.length}`})
                            </span>
                          )}
                        </div>
                        {(activeSession?.conversation_id || (isCurrentActive && activeConversation?.id)) && (
                          <a
                            href={activeSession?.conversation_id ? `/conversations/${activeSession.conversation_id}` : `/ask?id=${activeConversation!.id}`}
                            target="_blank"
                            rel="noreferrer"
                            style={{
                              color: "var(--aurora-accent)",
                              textDecoration: "none",
                              fontSize: 11.5,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                              fontWeight: 500,
                            }}
                          >
                            <span>{isZh ? "在新标签页查看完整会话" : "View Full Conversation"}</span>
                            <Icon name="external_link" size={11} />
                          </a>
                        )}
                      </div>

                      {/* Messages list */}
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                          maxHeight: "min(170px, 25vh)",
                          overflowY: "auto",
                          overscrollBehavior: "contain",
                          WebkitOverflowScrolling: "touch",
                          paddingRight: 4,
                        }}
                      >
                        {previewMsgs.length === 0 ? (
                          <div style={{ color: "var(--aurora-fg3)", textAlign: "center", padding: "12px 0", fontSize: 12 }}>
                            {isZh ? "当前会话暂无历史交互记录" : "No textual messages recorded in this session"}
                          </div>
                        ) : (
                          previewMsgs.map((m, idx) => {
                            const isUser = m.role === "user";
                            return (
                              <div
                                key={idx}
                                style={{
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: 3,
                                  background: isUser ? "var(--aurora-chip)" : "var(--aurora-surface)",
                                  border: `1px solid ${isUser ? "var(--aurora-border)" : "var(--aurora-border)"}`,
                                  borderRadius: 8,
                                  padding: "6px 10px",
                                  contentVisibility: "auto",
                                  containIntrinsicSize: "0 60px",
                                }}
                              >
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11 }}>
                                  <span style={{ fontWeight: 600, color: isUser ? "var(--aurora-accent)" : "var(--aurora-fg2)" }}>
                                    {isUser
                                      ? (isZh ? "👤 用户提问" : "👤 User")
                                      : (m.subagent_name
                                          ? `🔀 ${m.subagent_name}`
                                          : `🤖 ${executionMode === "claude" ? "Claude Code" : executionMode === "codex" ? "OpenAI Codex" : executionMode === "antigravity" ? "Google Antigravity" : executionMode === "workbuddy" ? "WorkBuddy" : "Assistant"}`)}
                                  </span>
                                  {m.timestamp && (
                                    <span style={{ color: "var(--aurora-fg3)", fontSize: 10 }}>
                                      {new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                    </span>
                                  )}
                                </div>
                                <div
                                  style={{
                                    color: "var(--aurora-fg1)",
                                    wordBreak: "break-word",
                                    lineHeight: 1.45,
                                    maxHeight: 120,
                                    overflowY: "auto",
                                    fontSize: 12,
                                  }}
                                >
                                  <MarkdownViewer content={m.content?.trim() || ""} compactText={true} />
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

            {/* Voice Recording Active Banner */}
            {isRecordingVoice && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "4px 12px",
                  marginBottom: 6,
                  borderRadius: 10,
                  background: "rgba(239, 68, 68, 0.1)",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  fontSize: 11.5,
                  color: "#ef4444",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="w-2 h-2 rounded-full bg-[#ef4444] animate-ping" />
                  <span style={{ fontWeight: 600 }}>{isZh ? "🎙️ 正在倾听吩咐... 实时转写中" : "Listening & transcribing..."}</span>
                </div>
                <button
                  type="button"
                  onClick={toggleVoiceInput}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#ef4444",
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  {isZh ? "完成倾听" : "Done"}
                </button>
              </div>
            )}

            {/* Speech Hint Floating Pill */}
            {speechHint && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "5px 12px",
                  marginBottom: 6,
                  borderRadius: 10,
                  background: "rgba(124, 58, 237, 0.12)",
                  border: "1px solid rgba(124, 58, 237, 0.3)",
                  fontSize: 12,
                  color: "#A78BFA",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span>🎙️</span>
                  <span>{speechHint}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setSpeechHint(null)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "inherit",
                    cursor: "pointer",
                    fontSize: 13,
                    opacity: 0.7,
                    padding: "0 4px",
                  }}
                >
                  ✕
                </button>
              </div>
            )}

            {/* Attached images preview list */}
            {attachedImages.length > 0 && (
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  padding: "4px 2px 10px 2px",
                  alignItems: "center",
                }}
              >
                {attachedImages.map((img) => (
                  <div
                    key={img.id}
                    style={{
                      position: "relative",
                      borderRadius: 10,
                      overflow: "hidden",
                      border: "1px solid var(--aurora-border)",
                      background: "rgba(0,0,0,0.25)",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
                    }}
                  >
                    <img
                      src={img.dataUrl}
                      alt={img.name}
                      style={{
                        width: 48,
                        height: 48,
                        objectFit: "cover",
                        display: "block",
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => removeAttachedImage(img.id)}
                      title={isZh ? "移除图片" : "Remove image"}
                      style={{
                        position: "absolute",
                        top: 2,
                        right: 2,
                        width: 16,
                        height: 16,
                        borderRadius: 999,
                        background: "rgba(0,0,0,0.75)",
                        color: "#fff",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 10,
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <span style={{ fontSize: 11, color: "var(--aurora-fg3)" }}>
                  {isZh ? `已附加 ${attachedImages.length} 张图片` : `${attachedImages.length} image(s) attached`}
                </span>
              </div>
            )}

            {/* Active Waiting Question Sticky Banner */}
            {activeWaitingQuestion && (
              <div
                onClick={() => {
                  const q = activeWaitingQuestion.question as any;
                  const targetId = `question-prompt-${q?.id || activeWaitingQuestion.taskId || "active"}`;
                  const el = document.getElementById(targetId);
                  if (el) {
                    el.scrollIntoView({ behavior: "smooth", block: "center" });
                  } else {
                    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
                  }
                }}
                style={{
                  margin: "0 0 8px 0",
                  padding: "7px 12px",
                  borderRadius: 10,
                  background: "linear-gradient(90deg, rgba(245,158,11,0.18), rgba(245,158,11,0.08))",
                  border: "1px solid rgba(245,158,11,0.4)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  cursor: "pointer",
                  boxShadow: "0 2px 10px rgba(245,158,11,0.12)",
                }}
                className="animate-pulse"
                title={isZh ? "点击定位到提问并进行回复" : "Click to view and answer the question"}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, flex: 1 }}>
                  <span style={{ color: "#D97706", display: "flex", flexShrink: 0 }}>
                    <Icon name="message" size={14} />
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: "#B45309", whiteSpace: "nowrap", flexShrink: 0 }}>
                    {isZh ? "Agent 等待确认" : "Agent waiting"}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--aurora-fg2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {(activeWaitingQuestion.question as any)?.question || (isZh ? "请回复..." : "Please respond...")}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: "var(--aurora-accent)",
                    background: "var(--aurora-surface-solid)",
                    padding: "2px 8px",
                    borderRadius: 6,
                    border: "1px solid var(--aurora-border-strong)",
                    flexShrink: 0,
                  }}
                >
                  {isZh ? "立即回复 ↓" : "Respond ↓"}
                </span>
              </div>
            )}

            {/* Smart Device Routing Recommendation Pill */}
            {suggestedDevice && (
              <div
                style={{
                  margin: "0 0 8px 0",
                  padding: "6px 12px",
                  borderRadius: 9,
                  background: "rgba(49, 134, 255, 0.1)",
                  border: "1px solid rgba(49, 134, 255, 0.3)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <span style={{ color: "var(--aurora-accent)" }}>💡</span>
                  <span style={{ color: "var(--aurora-fg2)" }}>
                    {suggestedDevice.reason}，{isZh ? "建议切换目标设备至：" : "recommended target device:"}
                  </span>
                  <strong style={{ color: "var(--aurora-fg1)" }}>{suggestedDevice.device.name}</strong>
                </div>
                <button
                  type="button"
                  onClick={() => handleDeviceChange(suggestedDevice.device.device_id)}
                  style={{
                    padding: "2px 9px",
                    borderRadius: 6,
                    fontSize: 11.5,
                    fontWeight: 600,
                    border: "1px solid var(--aurora-accent)",
                    background: "var(--aurora-accent)",
                    color: "#fff",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  {isZh ? "一键切换" : "Switch"}
                </button>
              </div>
            )}

            {/* Input box and action button */}
            <div className="flex items-end gap-1.5 sm:gap-2 w-full min-w-0 box-border">
              {/* Image Upload Button */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title={isZh ? "上传图片或截图 (支持直接粘贴 Ctrl+V / Cmd+V)" : "Upload image (supports Ctrl+V / Cmd+V)"}
                style={{
                  borderRadius: 11,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: attachedImages.length > 0 ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                  border: `1px solid ${attachedImages.length > 0 ? "var(--aurora-accent)" : "var(--aurora-border)"}`,
                  color: attachedImages.length > 0 ? "var(--aurora-accent)" : "var(--aurora-fg3)",
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                  flexShrink: 0,
                  boxSizing: "border-box",
                }}
                className="w-9 h-9 sm:w-[38px] sm:h-[38px] hover:text-[var(--aurora-fg1)] hover:border-[var(--aurora-border-strong)]"
              >
                <Icon name="image" size={16} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: "none" }}
                onChange={handleFileChange}
              />

              <label
                className="aurora-input !px-2.5 sm:!px-3 !py-1.5 sm:!py-2 !min-h-[36px] sm:!min-h-[38px]"
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: "var(--aurora-chip)",
                  border: "1px solid var(--aurora-border)",
                  boxSizing: "border-box",
                  alignItems: "flex-start",
                  borderRadius: 11,
                }}
              >
                <span className="hidden sm:inline-flex" style={{ color: "var(--aurora-fg3)", flexShrink: 0, marginTop: 3 }}>
                  <Icon
                    name={
                      executionMode === "shell"
                        ? "terminal"
                        : executionMode === "claude" || executionMode === "codex" || executionMode === "antigravity" || executionMode === "workbuddy"
                        ? "code"
                        : selectedDevice === "ask_only"
                        ? "sparkles"
                        : "brain"
                    }
                    size={15}
                  />
                </span>
                <textarea
                  ref={inputElRef}
                  rows={1}
                  value={input}
                  onChange={handleInputChange}
                  onPaste={handlePaste}
                  onFocus={() => {
                    setTimeout(() => {
                      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
                    }, 120);
                  }}
                  onKeyDown={onKeyDown}
                  placeholder={placeholderText}
                  disabled={streaming}
                  style={{
                    minWidth: 0,
                    width: "100%",
                    height: 20,
                    maxHeight: 160,
                    lineHeight: "20px",
                    padding: 0,
                    margin: 0,
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    color: "var(--aurora-fg1)",
                    resize: "none",
                    overflowY: "hidden",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontSize: 13.5,
                  }}
                />
              </label>
              {/* Voice Input Button */}
              <button
                type="button"
                onClick={toggleVoiceInput}
                title={isRecordingVoice ? (isZh ? "停止倾听" : "Stop listening") : (isZh ? "语音吩咐 (按键说话)" : "Voice input")}
                style={{
                  borderRadius: 11,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: isRecordingVoice ? "rgba(239, 68, 68, 0.16)" : "var(--aurora-chip)",
                  border: isRecordingVoice ? "1px solid #ef4444" : "1px solid var(--aurora-border)",
                  color: isRecordingVoice ? "#ef4444" : "var(--aurora-fg3)",
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                  flexShrink: 0,
                  boxSizing: "border-box",
                }}
                className={`w-9 h-9 sm:w-[38px] sm:h-[38px] ${isRecordingVoice ? "animate-pulse shadow-sm" : "hover:text-[var(--aurora-fg1)]"}`}
              >
                <Icon name="microphone" size={15} />
              </button>
              {isReconnecting && (
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "0 10px",
                    height: 36,
                    borderRadius: 11,
                    background: "rgba(245, 158, 11, 0.15)",
                    border: "1px solid rgba(245, 158, 11, 0.35)",
                    color: "#f59e0b",
                    fontSize: 12,
                    fontWeight: 500,
                    flexShrink: 0,
                  }}
                  className="animate-pulse"
                >
                  <Icon name="refresh" size={12} className="animate-spin" />
                  <span>正在恢复流式同步...</span>
                </div>
              )}
              {streaming ? (
                <Btn
                  variant="danger"
                  icon="close"
                  onClick={stopRun}
                  style={{
                    flexShrink: 0,
                    height: 36,
                    padding: "0 12px",
                    borderRadius: 11,
                    background: "rgba(239, 68, 68, 0.18)",
                    border: "1px solid rgba(239, 68, 68, 0.45)",
                    color: "#ef4444",
                  }}
                >
                  {t.ask.stop}
                </Btn>
              ) : (
                <Btn
                  onClick={send}
                  disabled={!input.trim() && attachedImages.length === 0}
                  icon={executionMode === "shell" ? "terminal" : executionMode !== "ai" ? "rocket" : selectedDevice === "ask_only" ? "search" : "rocket"}
                  style={{ flexShrink: 0, height: 36, padding: "0 12px", borderRadius: 11 }}
                >
                  {t.ask.send}
                </Btn>
              )}
            </div>
          </div>
        </div>
      </footer>
    </div>

      {/* AI Subscription Quotas Popover */}
      <AgentQuotaPopover
        isOpen={quotaOpen}
        onClose={() => setQuotaOpen(false)}
        deviceId={selectedDevice}
        initialData={quotasData}
        onDataChange={setQuotasData}
      />

      {/* Conversation Share Modal (Single & Multiple) */}
      <ShareModal
        open={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
        kind="conversation"
        targetId={shareTargetId}
        title={shareTitle}
      />

      {/* History Drawer Overlay & Sidebar */}
      {historyOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          {/* Backdrop */}
          <div
            onClick={() => setHistoryOpen(false)}
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0, 0, 0, 0.45)",
              backdropFilter: "blur(4px)",
            }}
          />

          {/* Drawer content */}
          <div
            style={{
              position: "relative",
              width: "min(380px, 90vw)",
              height: "100%",
              background: "var(--aurora-surface-solid)",
              borderLeft: "1px solid var(--aurora-border)",
              boxShadow: "-8px 0 32px rgba(0, 0, 0, 0.16)",
              display: "flex",
              flexDirection: "column",
              zIndex: 1,
            }}
          >
            {/* Drawer Header */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
                padding: "16px 20px",
                borderBottom: "1px solid var(--aurora-border)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon name="clock" size={18} style={{ color: "var(--aurora-accent)" }} />
                  <span style={{ fontSize: 15, fontWeight: 600, color: "var(--aurora-fg1)" }}>
                    {t.ask.historyTitle}
                  </span>
                  {conversations.length > 0 && (
                    <span
                      style={{
                        fontSize: 11,
                        padding: "2px 7px",
                        borderRadius: 999,
                        background: "var(--aurora-chip)",
                        color: "var(--aurora-fg3)",
                      }}
                    >
                      {historySearchQuery ? `${filteredConversations.length}/${conversations.length}` : conversations.length}
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => {
                      const next = !batchSelectMode;
                      setBatchSelectMode(next);
                      if (!next) setSelectedConvIds(new Set());
                    }}
                    title={batchSelectMode ? (isZh ? "退出多选" : "Exit selection") : (isZh ? "多选分享" : "Batch share")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 4,
                      padding: "0 8px",
                      height: 30,
                      borderRadius: 8,
                      background: batchSelectMode ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                      border: batchSelectMode ? "1px solid var(--aurora-accent)" : "1px solid var(--aurora-border)",
                      color: batchSelectMode ? "var(--aurora-accent)" : "var(--aurora-fg2)",
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    <Icon name="share" size={13} />
                    <span>{batchSelectMode ? (isZh ? "退出" : "Cancel") : (isZh ? "多选" : "Select")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={startNewChat}
                    title={t.ask.newChat}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      background: "var(--aurora-chip)",
                      border: "1px solid var(--aurora-border)",
                      color: "var(--aurora-fg2)",
                      cursor: "pointer",
                    }}
                  >
                    <Icon name="plus" size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setHistoryOpen(false)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      background: "transparent",
                      border: "none",
                      color: "var(--aurora-fg3)",
                      cursor: "pointer",
                    }}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
              </div>

              {selectedDevice && selectedDevice !== "auto" && selectedDevice !== "ask_only" && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={() => {
                      setHistoryFilterDevice(false);
                      void loadConversations(false);
                    }}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 14,
                      fontSize: 11.5,
                      fontWeight: !historyFilterDevice ? 600 : 400,
                      cursor: "pointer",
                      border: "1px solid",
                      borderColor: !historyFilterDevice ? "var(--aurora-accent)" : "var(--aurora-border)",
                      background: !historyFilterDevice ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                      color: !historyFilterDevice ? "var(--aurora-accent)" : "var(--aurora-fg3)",
                    }}
                  >
                    🌐 全部设备
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setHistoryFilterDevice(true);
                      void loadConversations(true);
                    }}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 14,
                      fontSize: 11.5,
                      fontWeight: historyFilterDevice ? 600 : 400,
                      cursor: "pointer",
                      border: "1px solid",
                      borderColor: historyFilterDevice ? "var(--aurora-accent)" : "var(--aurora-border)",
                      background: historyFilterDevice ? "var(--aurora-accent-soft)" : "var(--aurora-chip)",
                      color: historyFilterDevice ? "var(--aurora-accent)" : "var(--aurora-fg3)",
                    }}
                  >
                    🖥️ 当前设备 ({devices.find((d) => d.device_id === selectedDevice)?.name || selectedDevice.slice(0, 8)})
                  </button>
                </div>
              )}

              {/* 会话过滤搜索框 */}
              <div
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  width: "100%",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: 10,
                    display: "flex",
                    alignItems: "center",
                    pointerEvents: "none",
                    color: "var(--aurora-fg4)",
                  }}
                >
                  <Icon name="search" size={13} />
                </div>
                <input
                  type="text"
                  value={historySearchQuery}
                  onChange={(e) => setHistorySearchQuery(e.target.value)}
                  placeholder={isZh ? "搜索会话标题或设备 ID..." : "Search sessions or device..."}
                  style={{
                    width: "100%",
                    padding: "6px 28px 6px 30px",
                    borderRadius: 8,
                    fontSize: 12.5,
                    border: "1px solid var(--aurora-border)",
                    background: "var(--aurora-chip)",
                    color: "var(--aurora-fg1)",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
                {historySearchQuery && (
                  <button
                    type="button"
                    onClick={() => setHistorySearchQuery("")}
                    style={{
                      position: "absolute",
                      right: 8,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 18,
                      height: 18,
                      borderRadius: "50%",
                      background: "transparent",
                      border: "none",
                      color: "var(--aurora-fg4)",
                      cursor: "pointer",
                    }}
                  >
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>
            </div>

            {/* Drawer List */}
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "12px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {loadingHistory ? (
                <div style={{ textAlign: "center", padding: "40px 0", color: "var(--aurora-fg4)", fontSize: 13 }}>
                  {isZh ? "加载中..." : "Loading..."}
                </div>
              ) : filteredConversations.length === 0 ? (
                <div
                  style={{
                    textAlign: "center",
                    padding: "48px 20px",
                    color: "var(--aurora-fg4)",
                    fontSize: 13,
                  }}
                >
                  {historySearchQuery ? (isZh ? "未找到匹配的会话" : "No matching sessions found") : t.ask.noHistory}
                </div>
              ) : (
                filteredConversations.map((c) => {
                  const isActive = c.id === activeConversationId;
                  const dateStr = c.updated_at
                    ? new Date(c.updated_at).toLocaleString(undefined, {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "";
                  return (
                    <div
                      key={c.id}
                      onFocus={() => void prefetchConversationTurns(c.id)}
                      onClick={() => {
                        if (batchSelectMode) {
                          const next = new Set(selectedConvIds);
                          if (next.has(c.id)) next.delete(c.id);
                          else next.add(c.id);
                          setSelectedConvIds(next);
                        } else {
                          loadConversation(c.id);
                        }
                      }}
                      style={{
                        padding: "11px 13px",
                        borderRadius: 10,
                        background: selectedConvIds.has(c.id)
                          ? "var(--aurora-accent-soft)"
                          : isActive
                          ? "var(--aurora-chip)"
                          : "transparent",
                        border: "1px solid",
                        borderColor: selectedConvIds.has(c.id)
                          ? "var(--aurora-accent)"
                          : isActive
                          ? "var(--aurora-accent)"
                          : "transparent",
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                      }}
                      onMouseEnter={(e) => {
                        void prefetchConversationTurns(c.id);
                        if (!isActive && !selectedConvIds.has(c.id)) {
                          e.currentTarget.style.background = "var(--aurora-chip)";
                          e.currentTarget.style.borderColor = "var(--aurora-border)";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive && !selectedConvIds.has(c.id)) {
                          e.currentTarget.style.background = "transparent";
                          e.currentTarget.style.borderColor = "transparent";
                        }
                      }}
                    >
                      {batchSelectMode && (
                        <input
                          type="checkbox"
                          checked={selectedConvIds.has(c.id)}
                          onChange={() => {}}
                          style={{
                            width: 16,
                            height: 16,
                            accentColor: "var(--aurora-accent)",
                            cursor: "pointer",
                            flexShrink: 0,
                          }}
                        />
                      )}
                      {editingConvId === c.id ? (
                        <div
                          style={{ flex: 1, display: "flex", alignItems: "center", gap: 6 }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="text"
                            autoFocus
                            value={editingConvTitle}
                            onChange={(e) => setEditingConvTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                renameConversation(c.id, editingConvTitle);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                setEditingConvId(null);
                              }
                            }}
                            style={{
                              flex: 1,
                              padding: "4px 8px",
                              borderRadius: 6,
                              fontSize: 12.5,
                              border: "1px solid var(--aurora-accent)",
                              background: "var(--aurora-surface-solid)",
                              color: "var(--aurora-fg1)",
                              outline: "none",
                              minWidth: 0,
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => renameConversation(c.id, editingConvTitle)}
                            title="保存"
                            style={{
                              background: "transparent",
                              border: "none",
                              color: "var(--aurora-accent)",
                              cursor: "pointer",
                              padding: 4,
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <Icon name="check" size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingConvId(null)}
                            title="取消"
                            style={{
                              background: "transparent",
                              border: "none",
                              color: "var(--aurora-fg4)",
                              cursor: "pointer",
                              padding: 4,
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <Icon name="close" size={14} />
                          </button>
                        </div>
                      ) : (
                        <>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                fontSize: 13.5,
                                fontWeight: isActive ? 600 : 500,
                                color: isActive ? "var(--aurora-accent)" : "var(--aurora-fg1)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                lineHeight: 1.4,
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                              }}
                            >
                              {c.config?.pinned && (
                                <span
                                  title={isZh ? "已置顶会话" : "Pinned"}
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    color: "#f59e0b",
                                    flexShrink: 0,
                                  }}
                                >
                                  <Icon name="pin" size={12} />
                                </span>
                              )}
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                                {c.title || t.ask.title}
                              </span>
                            </div>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                fontSize: 11.5,
                                color: "var(--aurora-fg4)",
                                marginTop: 4,
                              }}
                            >
                              <span>{dateStr}</span>
                              {c.device_id && (
                                <>
                                  <span>·</span>
                                  <span
                                    style={{
                                      padding: "1px 5px",
                                      borderRadius: 4,
                                      background: "var(--aurora-chip)",
                                      fontSize: 10,
                                      fontFamily: "monospace",
                                    }}
                                  >
                                    {c.device_id.slice(0, 8)}
                                  </span>
                                </>
                              )}
                              <span>·</span>
                              <span>{t.ask.turnsCount.replace("{n}", String(c.message_count))}</span>
                            </div>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 2 }} onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={(e) => togglePinConversation(e, c.id, c.config?.pinned)}
                              title={c.config?.pinned ? (isZh ? "取消置顶" : "Unpin") : (isZh ? "置顶会话" : "Pin to top")}
                              style={{
                                background: "transparent",
                                border: "none",
                                color: c.config?.pinned ? "#f59e0b" : "var(--aurora-fg4)",
                                cursor: "pointer",
                                padding: 6,
                                borderRadius: 6,
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                opacity: c.config?.pinned ? 1 : 0.6,
                                transition: "all 0.15s ease",
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.color = "#f59e0b";
                                e.currentTarget.style.opacity = "1";
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.color = c.config?.pinned ? "#f59e0b" : "var(--aurora-fg4)";
                                e.currentTarget.style.opacity = c.config?.pinned ? "1" : "0.6";
                              }}
                            >
                              <Icon name="pin" size={13} />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openSingleShare(c.id, c.title);
                              }}
                              title={isZh ? "分享此会话" : "Share conversation"}
                              style={{
                                background: "transparent",
                                border: "none",
                                color: "var(--aurora-fg4)",
                                cursor: "pointer",
                                padding: 6,
                                borderRadius: 6,
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                opacity: 0.6,
                                transition: "all 0.15s ease",
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.color = "var(--aurora-accent)";
                                e.currentTarget.style.opacity = "1";
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.color = "var(--aurora-fg4)";
                                e.currentTarget.style.opacity = "0.6";
                              }}
                            >
                              <Icon name="share" size={13} />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingConvId(c.id);
                                setEditingConvTitle(c.title || "");
                              }}
                              title={isZh ? "重命名会话" : "Rename"}
                              style={{
                                background: "transparent",
                                border: "none",
                                color: "var(--aurora-fg4)",
                                cursor: "pointer",
                                padding: 6,
                                borderRadius: 6,
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                opacity: 0.6,
                                transition: "all 0.15s ease",
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.color = "var(--aurora-accent)";
                                e.currentTarget.style.opacity = "1";
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.color = "var(--aurora-fg4)";
                                e.currentTarget.style.opacity = "0.6";
                              }}
                            >
                              <Icon name="edit" size={13} />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => deleteConversation(e, c.id)}
                              title={t.ask.deleteConfirm}
                              style={{
                                background: "transparent",
                                border: "none",
                                color: "var(--aurora-fg4)",
                                cursor: "pointer",
                                padding: 6,
                                borderRadius: 6,
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                opacity: 0.6,
                                transition: "all 0.15s ease",
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.color = "#ef4444";
                                e.currentTarget.style.opacity = "1";
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.color = "var(--aurora-fg4)";
                                e.currentTarget.style.opacity = "0.6";
                              }}
                            >
                              <Icon name="trash" size={14} />
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })
              )}
              {batchSelectMode && (
                <div
                  style={{
                    position: "sticky",
                    bottom: 0,
                    margin: "12px -16px -16px -16px",
                    padding: "12px 16px",
                    background: "var(--aurora-surface-solid)",
                    borderTop: "1px solid var(--aurora-border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    zIndex: 10,
                    backdropFilter: "blur(12px)",
                  }}
                >
                  <div style={{ fontSize: 12, color: "var(--aurora-fg2)", fontWeight: 500 }}>
                    {isZh ? "已选择 " : "Selected "}
                    <span style={{ color: "var(--aurora-accent)", fontWeight: 700 }}>{selectedConvIds.size}</span>
                    {isZh ? " 个对话" : " sessions"}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => {
                        if (selectedConvIds.size === filteredConversations.length) {
                          setSelectedConvIds(new Set());
                        } else {
                          setSelectedConvIds(new Set(filteredConversations.map((c) => c.id)));
                        }
                      }}
                      style={{
                        padding: "5px 10px",
                        borderRadius: 8,
                        fontSize: 11.5,
                        background: "var(--aurora-chip)",
                        border: "1px solid var(--aurora-border)",
                        color: "var(--aurora-fg2)",
                        cursor: "pointer",
                      }}
                    >
                      {selectedConvIds.size === filteredConversations.length
                        ? (isZh ? "取消全选" : "Deselect")
                        : (isZh ? "全选" : "Select all")}
                    </button>
                    <Btn
                      variant="primary"
                      size="sm"
                      icon="share"
                      disabled={selectedConvIds.size === 0}
                      onClick={openBatchShare}
                    >
                      {isZh ? "生成多对话分享链接 ↗" : "Batch Share ↗"}
                    </Btn>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Sources Drawer Overlay & Sidebar */}
      {sourcesOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          {/* Backdrop */}
          <div
            onClick={() => setSourcesOpen(false)}
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0, 0, 0, 0.45)",
              backdropFilter: "blur(4px)",
            }}
          />

          {/* Drawer content */}
          <div
            style={{
              position: "relative",
              width: "min(460px, 92vw)",
              height: "100%",
              background: "var(--aurora-surface-solid)",
              borderLeft: "1px solid var(--aurora-border)",
              boxShadow: "-8px 0 32px rgba(0, 0, 0, 0.16)",
              display: "flex",
              flexDirection: "column",
              zIndex: 1,
            }}
          >
            {/* Drawer Header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 20px",
                borderBottom: "1px solid var(--aurora-border)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon name="book" size={18} style={{ color: "var(--aurora-accent)" }} />
                <span style={{ fontSize: 15, fontWeight: 600, color: "var(--aurora-fg1)" }}>
                  {t.ask.sources}
                </span>
                {selectedSources.length > 0 && (
                  <span
                    style={{
                      fontSize: 11,
                      padding: "2px 7px",
                      borderRadius: 999,
                      background: "rgba(56, 189, 248, 0.15)",
                      color: "var(--aurora-accent)",
                      fontWeight: 600,
                    }}
                  >
                    {selectedSources.length}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setSourcesOpen(false)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  background: "transparent",
                  border: "none",
                  color: "var(--aurora-fg3)",
                  cursor: "pointer",
                }}
              >
                <Icon name="close" size={16} />
              </button>
            </div>

            {/* Drawer List */}
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "14px",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              {selectedSources.map((s, si) => (
                <div
                  key={s.id || si}
                  style={{
                    padding: "14px 16px",
                    borderRadius: 12,
                    background: "var(--aurora-bg)",
                    border: "1px solid var(--aurora-border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.03)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: "var(--aurora-accent)",
                        }}
                      >
                        [{si + 1}]
                      </span>
                      <ToolGlyph id={s.tool_id} size={16} />
                      {s.category && (
                        <span
                          style={{
                            fontSize: 10.5,
                            padding: "2px 7px",
                            borderRadius: 6,
                            background: "var(--aurora-surface-solid)",
                            border: "1px solid var(--aurora-border)",
                            color: "var(--aurora-fg3)",
                            fontWeight: 500,
                          }}
                        >
                          {s.category}
                        </span>
                      )}
                    </div>
                    {s.synced_at && (
                      <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>
                        {formatRelativeTime(s.synced_at, isZh)}
                      </span>
                    )}
                  </div>

                  <Link
                    href={`/documents/${s.id}`}
                    target="_blank"
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--aurora-fg1)",
                      textDecoration: "none",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      lineHeight: 1.4,
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.title || s.relative_path}
                    </span>
                    <Icon name="external_link" size={13} style={{ flexShrink: 0, opacity: 0.6 }} />
                  </Link>

                  {s.excerpt && (
                    <div
                      style={{
                        fontSize: 12,
                        lineHeight: 1.6,
                        color: "var(--aurora-fg2)",
                        background: "var(--aurora-surface-solid)",
                        borderRadius: 8,
                        padding: "10px 12px",
                        border: "1px solid var(--aurora-border)",
                        borderLeft: "3px solid var(--aurora-accent)",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        maxHeight: 180,
                        overflowY: "auto",
                      }}
                    >
                      {formatExcerpt(s.excerpt)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 栏 3: 右侧媒体独立视窗 (桌面端并列第三栏，移动端滑出全屏抽屉) */}
      <MediaInspectorPanel />
    </div>
  );
}

export default function AskPage() {
  return (
    <Suspense fallback={<div style={{ color: "var(--aurora-fg4)", textAlign: "center", marginTop: 80 }}>加载中...</div>}>
      <MediaInspectorProvider>
        <AskPageContent />
      </MediaInspectorProvider>
    </Suspense>
  );
}
