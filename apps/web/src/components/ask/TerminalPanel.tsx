"use client";

// A real terminal on the device the conversation works on, opened in the project folder (daemon node-pty).
// Output comes as an SSE stream, keystrokes go up in small batches. The terminal id is kept per device and
// folder in sessionStorage, so reopening the drawer (or reloading the page) re-attaches to the same shell.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/aurora/Icon";
import { authFetch, getApiBase } from "@/lib/server-endpoint";
import "@xterm/xterm/css/xterm.css";

type Status = "connecting" | "ready" | "exited" | "error";

/** Keystrokes typed within this many ms go up in one request. */
export const INPUT_BATCH_MS = 8;

export function terminalStorageKey(deviceId: string, cwd: string): string {
  return `memento_term:${deviceId}:${cwd}`;
}

/** Parses an SSE chunk stream into its `data:` payloads (keepalive comments skipped). */
export function parseSseFrames(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    const line = part.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;
    try {
      events.push(JSON.parse(line.slice(6)));
    } catch {
      // half a frame from a cut connection: dropped
    }
  }
  return { events, rest };
}

async function post(path: string, body: unknown): Promise<Response> {
  return authFetch(`${getApiBase()}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export function TerminalPanel({ deviceId, cwd, isZh }: { deviceId: string; cwd: string; isZh: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const termIdRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    let pending = "";
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanup: (() => void) | undefined;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !hostRef.current) return;
      const dark = document.documentElement.getAttribute("data-theme") === "dark";
      const term = new Terminal({
        fontFamily: 'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, "Noto Sans Mono CJK SC", monospace',
        fontSize: 12.5,
        lineHeight: 1.2,
        cursorBlink: true,
        scrollback: 5000,
        allowProposedApi: false,
        theme: dark
          ? { background: "#101018", foreground: "#E4E1F4", cursor: "#C4B5FD", selectionBackground: "#6D28D955" }
          : { background: "#FBFBFD", foreground: "#1F1B2E", cursor: "#6D28D9", selectionBackground: "#6D28D933" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      try {
        fit.fit();
      } catch {
        // not laid out yet
      }

      const key = terminalStorageKey(deviceId, cwd);
      const previous = sessionStorage.getItem(key) || undefined;
      const openRes = await post("/api/terminal/open", { device_id: deviceId, cwd, cols: term.cols, rows: term.rows, ...(previous ? { term_id: previous } : {}) })
        .then(async (r) => (r.ok ? r.json() : r.status === 404 && previous
          // the old shell is gone (closed, or idle too long): start a new one
          ? post("/api/terminal/open", { device_id: deviceId, cwd, cols: term.cols, rows: term.rows }).then(async (r2) => (r2.ok ? r2.json() : Promise.reject(new Error((await r2.json().catch(() => ({}))).detail || r2.statusText))))
          : Promise.reject(new Error((await r.json().catch(() => ({}))).detail || r.statusText))))
        .catch((e: Error) => {
          if (!disposed) {
            setError(e.message);
            setStatus("error");
          }
          return null;
        });
      if (disposed || !openRes) {
        term.dispose();
        return;
      }
      const termId: string = openRes.term_id;
      termIdRef.current = termId;
      sessionStorage.setItem(key, termId);

      const flush = () => {
        flushTimer = undefined;
        if (!pending) return;
        const data = pending;
        pending = "";
        void post(`/api/terminal/${termId}/input`, { data });
      };
      const dataSub = term.onData((d) => {
        pending += d;
        if (!flushTimer) flushTimer = setTimeout(flush, INPUT_BATCH_MS);
      });
      const onResize = () => {
        try {
          fit.fit();
        } catch {
          return;
        }
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => void post(`/api/terminal/${termId}/resize`, { cols: term.cols, rows: term.rows }), 120);
      };
      const ro = new ResizeObserver(onResize);
      ro.observe(hostRef.current!);
      cleanup = () => {
        ro.disconnect();
        dataSub.dispose();
        term.dispose();
      };

      try {
        const res = await authFetch(`${getApiBase()}/api/terminal/${termId}/stream`, { signal: abort.signal });
        if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const { events, rest } = parseSseFrames(buf);
          buf = rest;
          for (const evt of events as { type: string; data?: string }[]) {
            if (evt.type === "ready") {
              setStatus("ready");
              term.focus();
            } else if (evt.type === "output" && evt.data) term.write(evt.data);
            else if (evt.type === "exit") {
              sessionStorage.removeItem(key);
              setStatus("exited");
            }
          }
        }
      } catch (e) {
        if (!disposed && (e as Error).name !== "AbortError") {
          setError((e as Error).message || (isZh ? "终端连接断开" : "Terminal disconnected"));
          setStatus("error");
        }
      }
    })();

    return () => {
      disposed = true;
      abort.abort();
      if (flushTimer) clearTimeout(flushTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      cleanup?.();
      // The shell keeps running (re-attached next time); "关闭终端" ends it
    };
  }, [cwd, deviceId, generation, isZh]);

  const closeShell = async () => {
    const id = termIdRef.current;
    if (id) await post(`/api/terminal/${id}/close`, {}).catch(() => undefined);
    sessionStorage.removeItem(terminalStorageKey(deviceId, cwd));
    setStatus("exited");
  };

  return (
    <div className="flex flex-col min-h-0 h-full" data-testid="terminal-panel">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--aurora-border)] text-[11.5px] text-[var(--aurora-fg3)] min-w-0">
        <Icon name="terminal" size={13} style={{ color: "var(--aurora-accent)", flexShrink: 0 }} />
        <span className="font-mono truncate flex-1 min-w-0" title={cwd}>{cwd || "~"}</span>
        <span className="shrink-0">
          {status === "connecting" ? (isZh ? "连接中…" : "Connecting…") : status === "ready" ? (isZh ? "已连接" : "Connected") : status === "exited" ? (isZh ? "已退出" : "Exited") : (isZh ? "出错" : "Error")}
        </span>
        {status === "ready" ? (
          <button type="button" onClick={() => void closeShell()} className="shrink-0 px-2 py-0.5 rounded-md border border-[var(--aurora-border)] hover:text-[#EF4444] cursor-pointer">
            {isZh ? "关闭终端" : "Close"}
          </button>
        ) : status !== "connecting" ? (
          <button type="button" onClick={() => { setError(""); setStatus("connecting"); setGeneration((g) => g + 1); }} className="shrink-0 px-2 py-0.5 rounded-md border border-[var(--aurora-border)] hover:text-[var(--aurora-accent)] cursor-pointer">
            {isZh ? "新开一个" : "New"}
          </button>
        ) : null}
      </div>
      {error && <div className="px-3 py-2 text-[12px] text-[#EF4444] break-words">{error}</div>}
      <div ref={hostRef} className="flex-1 min-h-[260px] px-2 py-1.5 overflow-hidden" style={{ background: "var(--aurora-surface-mute)" }} />
    </div>
  );
}
