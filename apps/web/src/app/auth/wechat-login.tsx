"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { Btn } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";

/** WeChat logo mark SVG */
export function WechatMark({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M8.5 2C4.36 2 1 4.91 1 8.5c0 2.03 1.05 3.86 2.69 5.09-.13.56-.63 1.95-.69 2.15-.08.26.1.25.21.18.9-.55 2.1-1.32 2.65-1.68.85.25 1.76.38 2.64.38.16 0 .32 0 .48-.01-.29-.75-.48-1.57-.48-2.43 0-3.69 3.58-6.68 8-6.68.27 0 .54.01.81.04C16.32 4.3 12.72 2 8.5 2zm-2.25 4.5c.69 0 1.25.56 1.25 1.25S6.94 9 6.25 9 5 8.44 5 7.75 5.56 6.5 6.25 6.5zm5 0c.69 0 1.25.56 1.25 1.25S11.94 9 11.25 9 10 8.44 10 7.75s.56-1.25 1.25-1.25zM16 9.5c-3.59 0-6.5 2.46-6.5 5.5s2.91 5.5 6.5 5.5c.74 0 1.45-.11 2.11-.31.45.31 1.45.94 2.18 1.39.09.05.24.06.17-.15-.05-.16-.46-1.3-.56-1.76 1.36-1.02 2.1-2.45 2.1-4.17 0-3.04-2.91-5.5-6.5-5.5zm-2 3.5c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm4 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1z" />
    </svg>
  );
}

export function WechatLoginSection() {
  const [ticket, setTicket] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [status, setStatus] = useState<"pending" | "success" | "expired" | "error">("pending");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [countdown, setCountdown] = useState<number>(300);
  const [copied, setCopied] = useState<boolean>(false);
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const [isWeChat, setIsWeChat] = useState<boolean>(false);
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const countdownTimerRef = useRef<NodeJS.Timeout | null>(null);
  const fetchingRef = useRef<boolean>(false);
  const completedRef = useRef<boolean>(false);
  const { setAccessToken } = useAuth();

  useEffect(() => {
    if (typeof window !== "undefined") {
      const ua = window.navigator.userAgent.toLowerCase();
      setIsMobile(/iphone|ipad|ipod|android/i.test(ua));
      setIsWeChat(/micromessenger/i.test(ua));
    }
  }, []);

  // Fetch a new ticket
  const fetchNewTicket = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      setLoading(true);
      setErrorMsg("");
      setStatus("pending");
      setCountdown(300);
      completedRef.current = false;
      const res = await api.getWechatTicket();
      setTicket(res.ticket);
    } catch {
      setErrorMsg("获取登录口令失败，请点击刷新");
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    fetchNewTicket();
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    };
  }, [fetchNewTicket]);

  // Countdown timer
  useEffect(() => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    if (status !== "pending") return;

    countdownTimerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          setStatus("expired");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    };
  }, [ticket, status]);

  const handleSuccess = useCallback((accessToken: string) => {
    if (completedRef.current) return;
    completedRef.current = true;
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setStatus("success");

    // Synchronously persist token so browser and AuthProvider pick it up immediately
    try {
      localStorage.setItem("dr_token", accessToken);
    } catch { /* noop */ }

    // Notify desktop client if running inside desktop iframe
    void setAccessToken(accessToken).catch(() => {});

    let next: string | null = null;
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      next = params.get("next");
    }
    const dest = next && next.startsWith("/") && !/^\/[/\\]/.test(next) ? next : "/ask";

    // Brief delay for the user to see the green checkmark before navigation
    setTimeout(() => {
      window.location.replace(dest);
    }, 300);
  }, [setAccessToken]);

  const checkPoll = useCallback(async () => {
    if (!ticket || status !== "pending" || completedRef.current) return;
    try {
      const res = await api.pollWechatTicket(ticket);
      if (res.status === "success" && res.access_token) {
        handleSuccess(res.access_token);
      } else if (res.status === "expired" || res.status === "not_found") {
        setStatus("expired");
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      } else if (res.status === "account_disabled") {
        setStatus("error");
        setErrorMsg(res.detail || "账号已被停用");
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      } else if (res.status === "registration_closed") {
        setStatus("error");
        setErrorMsg(res.detail || "系统暂未开放注册");
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      }
    } catch {
      // network blip — keep polling
    }
  }, [ticket, status, handleSuccess]);

  // Polling ticket status every 1000ms
  useEffect(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (!ticket || status !== "pending") return;

    pollTimerRef.current = setInterval(checkPoll, 1000);

    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [ticket, status, checkPoll]);

  // Instant poll when user returns to window/tab
  useEffect(() => {
    const handleActive = () => {
      if (document.visibilityState === "visible") {
        void checkPoll();
      }
    };
    window.addEventListener("focus", handleActive);
    document.addEventListener("visibilitychange", handleActive);
    return () => {
      window.removeEventListener("focus", handleActive);
      document.removeEventListener("visibilitychange", handleActive);
    };
  }, [checkPoll]);

  const legacyCopy = (text: string) => {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.setAttribute("readonly", "");
      el.style.position = "absolute";
      el.style.left = "-9999px";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    } catch { /* noop */ }
  };

  const copyCode = () => {
    if (!ticket) return;
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(ticket).catch(() => legacyCopy(ticket));
      } else {
        legacyCopy(ticket);
      }
    } catch {
      legacyCopy(ticket);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOpenWeChat = () => {
    if (!ticket) return;
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(ticket).catch(() => legacyCopy(ticket));
      } else {
        legacyCopy(ticket);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      legacyCopy(ticket);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }

    if (isMobile && !isWeChat) {
      window.location.href = "weixin://";
    }
  };

  const minutes = Math.floor(countdown / 60);
  const seconds = countdown % 60;
  const timeFormatted = `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
      {/* QR Code Container */}
      <div
        style={{
          position: "relative",
          width: 172,
          height: 172,
          borderRadius: 16,
          background: "#ffffff",
          padding: 8,
          boxShadow: "0 8px 30px -6px rgba(0,0,0,0.12)",
          border: "1px solid var(--aurora-border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <Image
          src="/wechat-qrcode.png"
          alt="公众号二维码"
          width={156}
          height={156}
          priority
          style={{
            borderRadius: 12,
            opacity: status === "expired" ? 0.2 : 1,
            filter: status === "expired" ? "blur(3px)" : "none",
            transition: "all 0.3s ease",
            WebkitTouchCallout: "default",
          }}
        />

        {/* Expired Overlay */}
        {status === "expired" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              background: "rgba(255, 255, 255, 0.85)",
              backdropFilter: "blur(4px)",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--aurora-fg2)" }}>
              口令已过期
            </span>
            <Btn size="sm" variant="glass" onClick={fetchNewTicket}>
              刷新二维码
            </Btn>
          </div>
        )}

        {/* Success Overlay */}
        {status === "success" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              background: "rgba(16, 185, 129, 0.95)",
              color: "#ffffff",
            }}
          >
            <Icon name="check" size={32} strokeWidth={2.5} />
            <span style={{ fontSize: 14, fontWeight: 600 }}>验证成功</span>
          </div>
        )}
      </div>

      {isMobile && (
        <span style={{ fontSize: 11, color: "var(--aurora-fg4)", marginTop: -6 }}>
          长按二维码可识别或保存到相册
        </span>
      )}
      {!isMobile && isWeChat && (
        <span style={{ fontSize: 11, color: "var(--aurora-fg4)", marginTop: -6 }}>
          右键二维码可直接「识别图中的二维码」关注
        </span>
      )}

      {/* Passcode Card */}
      <div
        style={{
          width: "100%",
          padding: "12px 14px",
          borderRadius: 14,
          background: "var(--aurora-bg2)",
          border: "1px solid var(--aurora-border)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
          <span style={{ fontSize: 11, color: "var(--aurora-fg4)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            登录口令
          </span>
          <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>
            {status === "pending" && !loading ? `${timeFormatted} 有效` : ""}
          </span>
        </div>

        {/* Code Display */}
        <div
          onClick={copyCode}
          title="点击复制"
          style={{
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 26,
            fontWeight: 700,
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            color: "var(--aurora-accent)",
            letterSpacing: "0.15em",
            padding: "2px 0",
          }}
        >
          {loading ? "••••••" : ticket ? ticket.split("").join(" ") : "------"}
          {!loading && ticket && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: copied ? "var(--aurora-accent)" : "var(--aurora-fg4)",
                letterSpacing: "normal",
                padding: "2px 6px",
                borderRadius: 6,
                background: "var(--aurora-bg3)",
              }}
            >
              {copied ? "已复制" : "复制"}
            </span>
          )}
        </div>
      </div>

      {/* Universal Quick Action Button - Always visible on all browsers */}
      {status === "pending" && !loading && (
        <button
          type="button"
          onClick={handleOpenWeChat}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            padding: "11px 16px",
            borderRadius: 12,
            background: "#07C160",
            color: "#ffffff",
            fontSize: 14,
            fontWeight: 600,
            border: "none",
            cursor: "pointer",
            boxShadow: "0 4px 14px rgba(7,193,96,0.30)",
            transition: "all 0.15s ease",
          }}
        >
          <WechatMark size={18} />
          {isWeChat
            ? (copied ? "口令已复制，请在微信对话框发送" : "一键复制口令并在微信发送")
            : isMobile
            ? (copied ? "已复制口令，正在前往微信…" : "复制口令并打开微信")
            : (copied ? "口令已复制！请发送给公众号「深度部署」" : "一键复制 6 位口令")}
        </button>
      )}

      {/* Guide Steps */}
      <div
        style={{
          width: "100%",
          fontSize: 12,
          color: "var(--aurora-fg3)",
          lineHeight: 1.6,
          textAlign: "left",
          padding: "0 4px",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ color: "var(--aurora-accent)", fontWeight: 600 }}>1.</span>
          <span>
            {isMobile && isWeChat
              ? "长按上方二维码识别关注公众号「深度部署」"
              : isWeChat
              ? "在微信中向「深度部署」公众号发送口令（未关注可右键二维码识别）"
              : isMobile
              ? "关注「深度部署」公众号（可在微信搜索或长按二维码保存）"
              : "微信扫码关注公众号「深度部署」"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ color: "var(--aurora-accent)", fontWeight: 600 }}>2.</span>
          <span>
            {isMobile && !isWeChat
              ? "点击上方「复制口令并打开微信」并向公众号发送口令"
              : "向公众号发送上方 6 位数字口令"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ color: "var(--aurora-accent)", fontWeight: 600 }}>3.</span>
          <span>发送后本页面<strong>自动完成登录</strong></span>
        </div>
      </div>

      {/* Status Bar */}
      {status === "pending" && !loading && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: "var(--aurora-fg4)",
            marginTop: 2,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "#10B981",
              boxShadow: "0 0 8px rgba(16,185,129,0.8)",
              animation: "pulse 2s infinite ease-in-out",
            }}
          />
          <span>等待微信扫码与发送口令…</span>
        </div>
      )}

      {errorMsg && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            background: "rgba(239,68,68,0.10)",
            color: "#B91C1C",
            fontSize: 12,
            width: "100%",
            textAlign: "center",
          }}
        >
          {errorMsg}
        </div>
      )}
    </div>
  );
}
