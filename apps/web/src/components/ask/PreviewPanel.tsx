"use client";

// Preview a dev server running on the conversation's device: pick a listening port, the page loads in a
// sandboxed iframe through the server's preview relay (/api/preview/t/<token>/), which works from anywhere.
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/aurora/Icon";
import { authFetch, getApiBase } from "@/lib/server-endpoint";

interface Port {
  port: number;
  process: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(`${getApiBase()}${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { detail?: string }).detail || res.statusText);
  return data as T;
}

export function PreviewPanel({ deviceId, isZh }: { deviceId: string; isZh: boolean }) {
  const [ports, setPorts] = useState<Port[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<{ port: number; url: string } | null>(null);
  const [frameKey, setFrameKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setPorts((await call<{ ports: Port[] }>(`/api/preview/ports?device_id=${encodeURIComponent(deviceId)}`)).ports);
    } catch (e) {
      setError((e as Error).message);
      setPorts(null);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openPort = async (port: number) => {
    try {
      const s = await call<{ url: string }>("/api/preview/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: deviceId, port }),
      });
      setOpen({ port, url: `${getApiBase()}${s.url}` });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (open) {
    return (
      <div className="flex flex-col h-full min-h-0" data-testid="preview-frame">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--aurora-border)] text-[12px] min-w-0">
          <button type="button" onClick={() => setOpen(null)} className="p-1 text-[var(--aurora-fg3)] hover:text-[var(--aurora-accent)] cursor-pointer" title={isZh ? "返回端口列表" : "Back"}>
            <Icon name="arrow_left" size={13} />
          </button>
          <span className="font-mono text-[var(--aurora-fg2)] truncate flex-1 min-w-0">localhost:{open.port}</span>
          <button type="button" onClick={() => setFrameKey((k) => k + 1)} className="p-1 text-[var(--aurora-fg3)] hover:text-[var(--aurora-accent)] cursor-pointer" title={isZh ? "刷新" : "Reload"}>
            <Icon name="refresh" size={13} />
          </button>
          <a href={open.url} target="_blank" rel="noreferrer" className="p-1 text-[var(--aurora-fg3)] hover:text-[var(--aurora-accent)]" title={isZh ? "在新标签页打开" : "Open in a new tab"}>
            <Icon name="external_link" size={13} />
          </a>
        </div>
        <iframe
          key={frameKey}
          src={open.url}
          title={`localhost:${open.port}`}
          className="flex-1 w-full min-h-[320px] bg-white border-0"
          sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
        />
        <div className="px-3 py-1.5 text-[11px] text-[var(--aurora-fg3)] border-t border-[var(--aurora-border)]">
          {isZh ? "经服务器中转：页面能正常浏览和操作，热更新（WebSocket）不经过中转，改了代码点刷新。" : "Relayed through the server: hot reload (WebSocket) isn't, reload after changes."}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3 sm:p-4" data-testid="preview-ports">
      <div className="flex items-center gap-2">
        <div className="text-[12.5px] font-semibold text-[var(--aurora-fg1)] flex-1">{isZh ? "这台设备上正在运行的网页服务" : "Web servers running on this device"}</div>
        <button type="button" onClick={() => void load()} className="p-1 text-[var(--aurora-fg3)] hover:text-[var(--aurora-accent)] cursor-pointer" title={isZh ? "刷新" : "Refresh"}>
          <Icon name="refresh" size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      {error && <div className="text-[12.5px] text-[#EF4444] rounded-xl border border-[#EF4444]/30 bg-[#EF4444]/5 p-3 break-words">{error}</div>}
      {ports && ports.length === 0 && !error && (
        <div className="text-[12.5px] text-[var(--aurora-fg3)] py-6 text-center leading-relaxed">
          {isZh ? "没有发现开发服务。让智能体或在终端里启动一个（如 npm run dev），再点刷新。" : "No dev server found. Start one (npm run dev), then refresh."}
        </div>
      )}
      {ports && ports.length > 0 && (
        <div className="rounded-xl border border-[var(--aurora-border)] divide-y divide-[var(--aurora-border)] overflow-hidden">
          {ports.map((p) => (
            <button key={p.port} type="button" onClick={() => void openPort(p.port)} className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-[var(--aurora-chip)] cursor-pointer">
              <Icon name="eye" size={14} style={{ color: "var(--aurora-accent)", flexShrink: 0 }} />
              <span className="font-mono text-[13px] text-[var(--aurora-fg1)]">localhost:{p.port}</span>
              <span className="text-[11.5px] text-[var(--aurora-fg3)] truncate">{p.process}</span>
              <Icon name="chevron_right" size={13} className="ml-auto" style={{ color: "var(--aurora-fg4)" }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
