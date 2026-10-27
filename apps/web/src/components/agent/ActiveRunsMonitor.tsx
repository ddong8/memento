"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api, type AskRunSummary } from "@/lib/api-client";
import { Icon } from "@/components/aurora/Icon";
import { useAuth } from "@/lib/auth-context";
import { sendLocalNotification } from "@/lib/native-notify";
import { isLiveConnected, onLiveEvent, onLiveStatus } from "@/lib/live-events";

export default function ActiveRunsMonitor() {
  const { token } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [activeChatId, setActiveChatId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("id") || localStorage.getItem("memento_last_ask_conv_id");
  });

  // 精准同步当前正在观察的会话ID，监听 URL、路由与页面内动态切换事件
  useEffect(() => {
    const syncCurrentId = (newId?: string | null) => {
      if (typeof window === "undefined") return;
      const urlId = new URLSearchParams(window.location.search).get("id");
      const storedId = localStorage.getItem("memento_last_ask_conv_id");
      setActiveChatId(newId || urlId || storedId || null);
    };

    const handleActiveChat = (e: any) => {
      syncCurrentId(e?.detail?.id);
    };
    const handlePopState = () => syncCurrentId();

    window.addEventListener("popstate", handlePopState);
    window.addEventListener("memento_active_chat_change", handleActiveChat);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("memento_active_chat_change", handleActiveChat);
    };
  }, [pathname, searchParams]);

  const currentConvId = pathname === "/ask" ? (searchParams.get("id") || activeChatId) : null;

  const [runs, setRuns] = useState<AskRunSummary[]>([]);
  const [now, setNow] = useState<number>(() => Date.now());
  const [collapsed, setCollapsed] = useState<boolean>(true);
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const [dismissedNotificationIds, setDismissedNotificationIds] = useState<Set<string>>(new Set());
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  useEffect(() => {
    const updateSize = () => setIsMobile(window.innerWidth < 768);
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  // Keep track of previously active conversation IDs so we know when one transitions to done
  const activeIdsRef = useRef<Set<string>>(new Set());
  const notifiedConvIdsRef = useRef<Set<string>>(new Set());
  const seenFinishedWhileVisibleRef = useRef<Set<string>>(new Set());
  const completedNoticeTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const locallyFinishedMapRef = useRef<Map<string, number>>(new Map());

  const hasActiveRuns = runs.some((r) => !r.done);
  const hasVisibleNotifications = runs.some(
    (r) => r.done && !dismissedNotificationIds.has(r.conversation_id)
  );

  // Local ticker every 1000ms for smooth elapsed seconds updates (only active when needed and visible)
  useEffect(() => {
    if (!hasActiveRuns && !hasVisibleNotifications) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [hasActiveRuns, hasVisibleNotifications]);

  // Poll server for active and recently finished runs
  const fetchRuns = useCallback(async () => {
    if (!token) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    try {
      // Ask for runs active or finished in the last 20 seconds
      const data = await api.listAskRuns(20);
      if (!Array.isArray(data)) return;

      const nowTs = Date.now();
      const sanitizedData = data.map((r) => {
        const finishedAtMs = locallyFinishedMapRef.current.get(r.conversation_id);
        if (finishedAtMs && nowTs - finishedAtMs < 60_000) {
          return { ...r, done: true, finished_at: r.finished_at || finishedAtMs / 1000 };
        }
        return r;
      });

      const currentActiveIds = new Set<string>();
      sanitizedData.forEach((r) => {
        if (!r.done) currentActiveIds.add(r.conversation_id);
      });

      // Check transitions: was active previously, now done
      sanitizedData.forEach((r) => {
        if (
          r.done &&
          activeIdsRef.current.has(r.conversation_id) &&
          !notifiedConvIdsRef.current.has(r.conversation_id)
        ) {
          notifiedConvIdsRef.current.add(r.conversation_id);
          const isActivelyWatching =
            pathname === "/ask" &&
            (currentConvId === r.conversation_id || !currentConvId) &&
            typeof document !== "undefined" &&
            document.visibilityState === "visible" &&
            (typeof document.hasFocus !== "function" || document.hasFocus());
          // 如果用户当前就在 /ask 页面、窗口处于前台且查看的就是该会话，直接静默消除通知
          if (isActivelyWatching) {
            seenFinishedWhileVisibleRef.current.add(r.conversation_id);
            setDismissedNotificationIds((prev) => new Set([...prev, r.conversation_id]));
          } else {
            const summaryText = (r.question || r.title || "任务执行完成").trim().slice(0, 60);
            const bodyText = r.device_name ? `${r.device_name}：${summaryText}` : summaryText;
            void sendLocalNotification(
              r.failed ? "❌ 任务出错" : "✅ 任务完成",
              bodyText,
              `/ask?id=${r.conversation_id}&scroll=bottom`,
              { skipInAppToast: true, serverBacked: true }
            );
            if (!completedNoticeTimerRef.current.has(r.conversation_id)) {
              const t = setTimeout(() => {
                setDismissedNotificationIds((prev) => new Set([...prev, r.conversation_id]));
              }, 6000);
              completedNoticeTimerRef.current.set(r.conversation_id, t);
            }
          }
        }
      });

      activeIdsRef.current = currentActiveIds;
      setRuns(sanitizedData);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("memento_active_runs_update", {
            detail: { conversation_ids: Array.from(currentActiveIds) },
          })
        );
      }
    } catch {
      // Ignore network errors during polling
    }
  }, [token, pathname, currentConvId]);

  // 监听任务结束与启动事件，实现零延迟即时响应，打破 1.5s~4s 纯轮询固有滞后
  useEffect(() => {
    const handleAskDone = (e: any) => {
      const convId = e?.detail?.conversation_id;
      if (convId) {
        locallyFinishedMapRef.current.set(convId, Date.now());
        activeIdsRef.current.delete(convId);
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("memento_active_runs_update", {
              detail: { conversation_ids: Array.from(activeIdsRef.current) },
            })
          );
        }
        const alreadyNotified = notifiedConvIdsRef.current.has(convId);
        notifiedConvIdsRef.current.add(convId);
        const isActivelyWatching =
          pathname === "/ask" &&
          (currentConvId === convId || !currentConvId) &&
          typeof document !== "undefined" &&
          document.visibilityState === "visible" &&
          (typeof document.hasFocus !== "function" || document.hasFocus());
        setRuns((prev) => {
          const target = prev.find((r) => r.conversation_id === convId);
          if (target && !isActivelyWatching && !alreadyNotified) {
            const summaryText = (target.question || target.title || "任务执行完成").trim().slice(0, 60);
            const bodyText = target.device_name ? `${target.device_name}：${summaryText}` : summaryText;
            void sendLocalNotification(
              target.failed ? "❌ 任务出错" : "✅ 任务完成",
              bodyText,
              `/ask?id=${convId}&scroll=bottom`,
              { skipInAppToast: true, serverBacked: true }
            );
          }
          return prev.map((r) =>
            r.conversation_id === convId ? { ...r, done: true, finished_at: Date.now() / 1000 } : r
          );
        });
        if (isActivelyWatching) {
          seenFinishedWhileVisibleRef.current.add(convId);
          setDismissedNotificationIds((prev) => new Set([...prev, convId]));
        }
      }
      setTimeout(fetchRuns, 150);
    };

    const handleAskStart = (e: any) => {
      const convId = e?.detail?.conversation_id;
      if (convId) {
        locallyFinishedMapRef.current.delete(convId);
        activeIdsRef.current.add(convId);
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("memento_active_runs_update", {
              detail: { conversation_ids: Array.from(activeIdsRef.current) },
            })
          );
        }
        notifiedConvIdsRef.current.delete(convId);
        seenFinishedWhileVisibleRef.current.delete(convId);
        setDismissedNotificationIds((prev) => {
          const next = new Set(prev);
          next.delete(convId);
          return next;
        });
      }
      setTimeout(fetchRuns, 150);
    };

    window.addEventListener("memento_ask_done", handleAskDone);
    window.addEventListener("memento_ask_start", handleAskStart);
    return () => {
      window.removeEventListener("memento_ask_done", handleAskDone);
      window.removeEventListener("memento_ask_start", handleAskStart);
    };
  }, [fetchRuns, pathname, currentConvId]);

  // A run starting or ending anywhere (another tab, device or the phone) is pushed: refresh at once
  const [live, setLive] = useState(isLiveConnected);
  useEffect(() => {
    if (!token) return;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => void fetchRuns(), 150);
    };
    const offEvent = onLiveEvent("ask_run", refresh);
    // A running run moving on is pushed too: show its new step without fetching the list
    const offStep = onLiveEvent("ask_run_step", (e) => {
      const step = e.data as Partial<AskRunSummary> & { conversation_id?: string };
      if (!step.conversation_id) return;
      setRuns((prev) => {
        const i = prev.findIndex((r) => r.conversation_id === step.conversation_id && !r.done);
        if (i < 0) {
          refresh(); // a run this tab hasn't listed yet
          return prev;
        }
        const next = prev.slice();
        next[i] = {
          ...prev[i],
          current_step: step.current_step ?? prev[i].current_step,
          step_type: step.step_type ?? prev[i].step_type,
          tool_name: step.tool_name ?? prev[i].tool_name,
          step_count: step.step_count ?? prev[i].step_count,
        };
        return next;
      });
    });
    const offStatus = onLiveStatus((up) => {
      setLive(up);
      if (up) refresh(); // catch up on what happened while it was down
    });
    return () => {
      offEvent();
      offStep();
      offStatus();
      if (pending) clearTimeout(pending);
    };
  }, [token, fetchRuns]);

  useEffect(() => {
    if (!token) return;
    fetchRuns();

    // Starts, steps and ends are pushed (above) and the elapsed time ticks locally, so with the push
    // connection up the poll is only a fallback: 15 s while a run is going, 2 minutes idle. Without
    // it, 2 s keeps a running run's step current and 30 s catches one starting.
    const intervalTime = hasActiveRuns ? (live ? 15_000 : 2000) : live ? 120_000 : 30000;
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void fetchRuns();
    }, intervalTime);
    return () => clearInterval(interval);
  }, [token, fetchRuns, hasActiveRuns, live]);

  const lastHiddenAtRef = useRef<number>(0);
  const autoJumpedKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!token || typeof document === "undefined") return;

    const syncAfterResume = async (fromVisibilityChange: boolean) => {
      if (document.visibilityState === "hidden") {
        lastHiddenAtRef.current = Date.now();
        return;
      }
      const hiddenSince =
        lastHiddenAtRef.current > 0
          ? lastHiddenAtRef.current
          : fromVisibilityChange
            ? Date.now() - 180_000
            : 0;
      lastHiddenAtRef.current = 0;
      try {
        const recent = await api.listAskRuns(300);
        if (!Array.isArray(recent)) return;
        setRuns(recent);
        const finishedWhileHidden = recent.find((r) => {
          if (!r.done || r.cancelled || !r.conversation_id) return false;
          if (seenFinishedWhileVisibleRef.current.has(r.conversation_id)) return false;
          const finMs = (r.finished_at || 0) * 1000;
          const key = `${r.conversation_id}:${Math.round(r.finished_at || 0)}`;
          if (autoJumpedKeysRef.current.has(key)) return false;
          if (hiddenSince > 0 && finMs >= hiddenSince - 5000) return true;
          if (activeIdsRef.current.has(r.conversation_id)) return true;
          return false;
        });
        if (finishedWhileHidden) {
          const key = `${finishedWhileHidden.conversation_id}:${Math.round(finishedWhileHidden.finished_at || 0)}`;
          autoJumpedKeysRef.current.add(key);
          seenFinishedWhileVisibleRef.current.add(finishedWhileHidden.conversation_id);
          setDismissedNotificationIds((prev) => new Set([...prev, finishedWhileHidden.conversation_id]));
          if (typeof (window as any).__memento_open_chat === "function") {
            (window as any).__memento_open_chat(finishedWhileHidden.conversation_id, { force: true });
          }
        }
      } catch {}
    };

    const onVisibilityChange = () => {
      void syncAfterResume(true);
    };
    const onFocus = () => {
      if (lastHiddenAtRef.current > 0) {
        void syncAfterResume(false);
      }
    };
    const onBlur = () => {
      if (lastHiddenAtRef.current === 0) {
        lastHiddenAtRef.current = Date.now();
      }
    };

    const onWake = () => {
      void syncAfterResume(true);
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("memento_app_active", onWake);
    window.addEventListener("memento_wake_stream", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("memento_app_active", onWake);
      window.removeEventListener("memento_wake_stream", onWake);
    };
  }, [token]);

  const activeRuns = runs.filter((r) => !r.done);
  const recentFinishedRuns = runs.filter(
    (r) => r.done && !dismissedNotificationIds.has(r.conversation_id) && (now / 1000 - (r.finished_at || 0) < 20)
  );

  // Suppress floating dock for runs that are already actively in the user's viewport on /ask
  const unobservedActiveRuns = activeRuns.filter((r) => {
    if (pathname === "/ask") {
      if (currentConvId && r.conversation_id === currentConvId) return false;
      if (activeRuns.length === 1 && (!currentConvId || currentConvId === r.conversation_id)) return false;
    }
    return true;
  });
  const showFloatingDock = unobservedActiveRuns.length > 0;

  // Handle task stop/cancel
  const handleCancel = async (e: React.MouseEvent, convId: string) => {
    e.stopPropagation();
    try {
      setCancellingId(convId);
      locallyFinishedMapRef.current.set(convId, Date.now());
      // 立即在前端标记已停止，无需等待后端与轮询回包
      setRuns((prev) =>
        prev.map((r) => (r.conversation_id === convId ? { ...r, done: true, cancelled: true } : r))
      );
      await api.cancelAskRun(convId);
      setTimeout(fetchRuns, 200);
    } catch (err) {
      console.error("Failed to cancel run:", err);
    } finally {
      setCancellingId(null);
    }
  };

  const handleDismissNotice = (e: React.MouseEvent, convId: string) => {
    e.stopPropagation();
    setDismissedNotificationIds((prev) => new Set([...prev, convId]));
  };

  const jumpToChat = (convId: string) => {
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("memento_last_ask_conv_id", convId);
        localStorage.setItem("memento_pending_jump_conv_id", convId);
      } catch {}
      if (typeof (window as any).__memento_open_chat === "function") {
        (window as any).__memento_open_chat(convId);
      } else {
        const targetUrl = `/ask?id=${encodeURIComponent(convId)}&scroll=bottom`;
        if (!window.location.pathname.startsWith("/ask")) {
          router.push(targetUrl);
        } else {
          window.history.pushState(null, "", targetUrl);
        }
        window.dispatchEvent(
          new CustomEvent("memento_switch_chat", {
            detail: { id: convId, forceReload: true, scrollToBottom: true },
          })
        );
      }
    }
  };

  // If nothing active and no recent notifications, render nothing
  if (activeRuns.length === 0 && recentFinishedRuns.length === 0) {
    return null;
  }

  // Helper to format elapsed duration
  const formatDuration = (startedAtSec: number, finishedAtSec?: number | null) => {
    const end = finishedAtSec ? finishedAtSec * 1000 : now;
    const diffSec = Math.max(0, Math.floor((end - startedAtSec * 1000) / 1000));
    const mins = Math.floor(diffSec / 60);
    const secs = diffSec % 60;
    if (mins > 0) return `${mins}分${secs}秒`;
    return `${secs}秒`;
  };

  // Mode badge stylings
  const getModeBadge = (mode?: string | null) => {
    const m = (mode || "ai").toLowerCase();
    if (m === "claude") {
      return {
        label: "Claude",
        bgColor: "rgba(168, 85, 247, 0.15)",
        borderColor: "rgba(168, 85, 247, 0.4)",
        textColor: "#c084fc",
        icon: "zap",
      };
    }
    if (m === "codex") {
      return {
        label: "Codex",
        bgColor: "rgba(16, 185, 129, 0.15)",
        borderColor: "rgba(16, 185, 129, 0.4)",
        textColor: "#34d399",
        icon: "terminal",
      };
    }
    if (m === "antigravity") {
      return {
        label: "Antigravity",
        bgColor: "rgba(14, 165, 233, 0.15)",
        borderColor: "rgba(14, 165, 233, 0.4)",
        textColor: "#38bdf8",
        icon: "rocket",
      };
    }
    if (m === "agent") {
      return {
        label: "Agent",
        bgColor: "rgba(245, 158, 11, 0.15)",
        borderColor: "rgba(245, 158, 11, 0.4)",
        textColor: "#fbbf24",
        icon: "sparkles",
      };
    }
    return {
      label: "Memento AI",
      bgColor: "rgba(99, 102, 241, 0.15)",
      borderColor: "rgba(99, 102, 241, 0.4)",
      textColor: "#818cf8",
      icon: "brain",
    };
  };

  const getStepIcon = (type?: string) => {
    if (type === "tool_call" || type === "executing") return "⚡";
    if (type === "thinking") return "🧠";
    if (type === "generating") return "✨";
    if (type === "done") return "✅";
    if (type === "error") return "❌";
    return "⚙️";
  };

  return (
    <>
      {/* 1. Finished Notifications Toasts (顶部右上角瞬态通知栏) */}
      {recentFinishedRuns.length > 0 && (
        <div
          className="fixed z-50 pointer-events-none transition-all duration-300"
          style={{
            top: isMobile ? "calc(env(safe-area-inset-top, 0px) + 54px)" : "76px",
            right: isMobile ? "12px" : "24px",
            maxWidth: isMobile ? "calc(100vw - 24px)" : "390px",
            width: "100%",
          }}
        >
          <div className="flex flex-col gap-2.5 pointer-events-auto items-end">
            {recentFinishedRuns.map((r) => {
              const isCurrentChat = currentConvId === r.conversation_id;
              if (isCurrentChat) return null; // Don't show toast if user is already watching it
              const isError = r.failed;
              return (
                <div
                  key={`notice-${r.conversation_id}`}
                  onClick={() => jumpToChat(r.conversation_id)}
                  className="group cursor-pointer rounded-2xl p-3.5 shadow-2xl backdrop-blur-xl transition-all duration-200 hover:scale-[1.02] w-full"
                  style={{
                    background: isError
                      ? "linear-gradient(135deg, rgba(239, 68, 68, 0.22), rgba(15, 23, 42, 0.95))"
                      : "linear-gradient(135deg, rgba(16, 185, 129, 0.22), rgba(15, 23, 42, 0.95))",
                    border: isError
                      ? "1px solid rgba(239, 68, 68, 0.4)"
                      : "1px solid rgba(16, 185, 129, 0.4)",
                    boxShadow: isError
                      ? "0 10px 30px -5px rgba(239, 68, 68, 0.3)"
                      : "0 10px 30px -5px rgba(16, 185, 129, 0.3)",
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-base">{isError ? "❌" : "✅"}</span>
                      <span className="text-xs font-semibold text-white tracking-wide">
                        {isError ? "智能体任务出错" : "智能体任务已完成"}
                      </span>
                      <span className="text-[11px] text-gray-400">
                        ({formatDuration(r.started_at, r.finished_at)})
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-medium text-emerald-400 group-hover:underline flex items-center gap-0.5">
                        查看成果 <Icon name="arrow_right" size={12} />
                      </span>
                      <button
                        onClick={(e) => handleDismissNotice(e, r.conversation_id)}
                        className="p-1 text-gray-400 hover:text-white rounded-lg transition-colors ml-1"
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-gray-300 line-clamp-1 pl-6">
                    {r.question || r.title || "（无描述）"}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 2. Active Runs Floating Dock (右侧靠中间垂直居中，零功能冲突，单手大拇指舒适区) */}
      {showFloatingDock && (
        <div
          className="fixed z-50 pointer-events-none transition-all duration-300 ease-out"
          style={{
            top: "48%",
            right: collapsed ? (isMobile ? "8px" : "16px") : (isMobile ? "12px" : "20px"),
            transform: "translateY(-50%)",
            maxWidth: isMobile ? "calc(100vw - 24px)" : "390px",
            width: collapsed ? "auto" : (isMobile ? "calc(100vw - 24px)" : "390px"),
          }}
        >
          <div className="pointer-events-auto flex flex-col items-end">
            {collapsed ? (
              <div
                onClick={() => setCollapsed(false)}
                className="cursor-pointer flex items-center gap-2 px-3 py-1.5 rounded-full shadow-2xl backdrop-blur-2xl border transition-all duration-200 hover:scale-[1.04] ml-auto group"
                style={{
                  background: "linear-gradient(135deg, rgba(15, 23, 42, 0.95), rgba(30, 41, 59, 0.92))",
                  borderColor: "rgba(56, 189, 248, 0.45)",
                  boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.6), 0 0 15px rgba(56, 189, 248, 0.25)",
                }}
                title="点击展开查看后台智能体任务详情"
              >
                <span className="relative flex h-2 w-2 flex-shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                <span className="text-xs font-semibold text-white tracking-wide whitespace-nowrap">
                  智能体运行中
                </span>
                <span className="text-[11px] font-mono text-emerald-400 bg-emerald-950/60 px-1.5 py-0.2 rounded-full border border-emerald-500/30 whitespace-nowrap">
                  {formatDuration(unobservedActiveRuns[0].started_at)}
                </span>
                {unobservedActiveRuns.length > 1 && (
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-sky-500/25 text-sky-300 font-mono">
                    +{unobservedActiveRuns.length - 1}
                  </span>
                )}
                <span className="text-[11px] text-sky-400 flex items-center gap-0.5 opacity-90 font-medium whitespace-nowrap pl-0.5 group-hover:underline">
                  展开 <Icon name="chevron_down" size={12} />
                </span>
              </div>
            ) : (
              <div
                className="rounded-2xl shadow-2xl backdrop-blur-2xl transition-all duration-300 overflow-hidden w-full flex flex-col"
                style={{
                  background: "linear-gradient(145deg, rgba(15, 23, 42, 0.96), rgba(30, 41, 59, 0.94))",
                  border: "1px solid rgba(56, 189, 248, 0.35)",
                  boxShadow: "0 20px 45px -10px rgba(0, 0, 0, 0.7), 0 0 25px rgba(56, 189, 248, 0.2)",
                  maxHeight: "min(480px, 70vh)",
                }}
              >
                {/* Header bar */}
                <div className="flex items-center justify-between px-3.5 py-2.5 bg-white/5 border-b border-white/10 shrink-0">
                  <div className="flex items-center gap-2.5">
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                    </span>
                    <span className="text-xs font-semibold text-white tracking-wide flex items-center gap-1.5">
                      后台智能体运行中
                      <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-sky-500/20 text-sky-300 font-mono">
                        {unobservedActiveRuns.length}
                      </span>
                    </span>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setCollapsed(true)}
                      title="收起为精简胶囊"
                      className="px-2 py-1 rounded-lg text-gray-300 hover:text-white hover:bg-white/10 transition-colors flex items-center gap-1 text-[11px]"
                    >
                      <span>收起</span>
                      <Icon name="chevron_up" size={13} />
                    </button>
                  </div>
                </div>

                {/* Expanded list of active runs */}
                <div
                  className="divide-y divide-white/5 overflow-y-auto flex-1"
                  style={{
                    overscrollBehavior: "contain",
                    WebkitOverflowScrolling: "touch",
                  }}
                >
                  {unobservedActiveRuns.map((run) => {
                    const badge = getModeBadge(run.execution_mode);
                    const isCurrentChat = currentConvId === run.conversation_id;
                    const isCancelling = cancellingId === run.conversation_id;

                    return (
                      <div
                        key={run.conversation_id}
                        className="p-3.5 flex flex-col gap-2 hover:bg-white/[0.03] transition-colors"
                      >
                        {/* Top status info line */}
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {/* Mode tag */}
                            <span
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border"
                              style={{
                                background: badge.bgColor,
                                borderColor: badge.borderColor,
                                color: badge.textColor,
                              }}
                            >
                              <span>{badge.label}</span>
                            </span>

                            {/* Model or device info */}
                            {run.model && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-white/5 text-gray-300 font-mono border border-white/10">
                                {run.model}
                              </span>
                            )}
                            {run.device_name && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-white/5 text-gray-400 border border-white/10">
                                💻 {run.device_name}
                              </span>
                            )}
                          </div>

                          {/* Live Timer */}
                          <div className="flex items-center gap-1 font-mono text-xs text-emerald-400 bg-emerald-950/40 px-2 py-0.5 rounded-full border border-emerald-500/30 flex-shrink-0">
                            <Icon name="clock" size={11} />
                            <span>{formatDuration(run.started_at)}</span>
                          </div>
                        </div>

                        {/* Question / Task title */}
                        <div className="text-xs font-medium text-white line-clamp-1">
                          {run.question || run.title || "后台长任务"}
                        </div>

                        {/* Current Step (Dynamic updates like Claude Code / Workbuddy) */}
                        <div
                          className="rounded-xl px-2.5 py-2 flex items-center gap-2 border"
                          style={{
                            background: "rgba(15, 23, 42, 0.6)",
                            borderColor: "rgba(56, 189, 248, 0.2)",
                          }}
                        >
                          <span className="text-sm flex-shrink-0 animate-pulse">
                            {getStepIcon(run.step_type)}
                          </span>
                          <span className="text-[11px] text-sky-200 line-clamp-1 font-mono flex-1">
                            {run.current_step || "正在深度思考与执行任务..."}
                          </span>
                        </div>

                        {/* Action buttons */}
                        <div className="flex items-center justify-between gap-2 pt-1">
                          <span className="text-[10px] text-gray-400">
                            已接收 {run.events} 个事件帧
                          </span>

                          <div className="flex items-center gap-1.5">
                            {/* Jump to chat button */}
                            <button
                              type="button"
                              onClick={() => jumpToChat(run.conversation_id)}
                              className="px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all"
                              style={{
                                background: isCurrentChat
                                  ? "rgba(255, 255, 255, 0.1)"
                                  : "linear-gradient(135deg, rgba(56, 189, 248, 0.2), rgba(99, 102, 241, 0.2))",
                                border: "1px solid rgba(56, 189, 248, 0.4)",
                                color: isCurrentChat ? "#94a3b8" : "#38bdf8",
                              }}
                            >
                              <span>{isCurrentChat ? "当前所在对话" : "直达对话"}</span>
                              <Icon name="arrow_right" size={11} />
                            </button>

                            {/* Cancel / Stop button */}
                            <button
                              type="button"
                              disabled={isCancelling}
                              onClick={(e) => handleCancel(e, run.conversation_id)}
                              className="px-2 py-1 rounded-lg text-xs font-medium text-rose-300 hover:text-white bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 transition-all flex items-center gap-1"
                            >
                              <span>{isCancelling ? "停止中..." : "终止"}</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
