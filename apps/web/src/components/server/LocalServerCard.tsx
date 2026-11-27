"use client";

// 单机模式: run Memento on this computer with Docker (desktop 1.0.167+, see apps/desktop/src/local-server.ts).
// The desktop asks for confirmation natively, starts the containers, waits for /health and switches over by itself.
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/aurora/Icon";
import { desktop, type LocalServerStatus } from "@/lib/desktop";

const DOCKER_URL = "https://www.docker.com/products/docker-desktop/";

/** What the card says about the current state, in one line. */
export function localServerSummary(st: LocalServerStatus | null, current: string): string {
  if (!st) return "正在检查这台电脑…";
  const embedded = st.engine === "embedded";
  if (!embedded && st.docker === "missing") return "需要先安装 Docker Desktop（免费），装好后回到这里点运行。";
  if (st.running && sameServer(st.url, current)) return `正在使用本机${embedded ? "内置" : ""}服务 ${st.url}`;
  if (st.running) return `本机${embedded ? "内置" : ""}服务已在运行（${st.url}），点切换就能用。`;
  if (st.installed) return `本机${embedded ? "内置" : ""}服务已停止，数据都还在，点运行接着用。`;
  if (embedded) return "无需 Docker、无需外网服务器：在这台电脑内置数据库直接运行，数据不出本机，随时可迁往服务版。";
  return "不用服务器：用 Docker 在这台电脑上跑一套只给你用的 Memento，数据不出本机。";
}

export function sameServer(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/\/+$/, "").replace("://127.0.0.1", "://localhost");
  return !!a && !!b && norm(a) === norm(b);
}

export function LocalServerCard({ currentServer }: { currentServer: string }) {
  const bridge = desktop()?.localServer;
  const [st, setSt] = useState<LocalServerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState("");
  const [error, setError] = useState("");
  const [showMigrate, setShowMigrate] = useState(false);
  const [direction, setDirection] = useState<"to-remote" | "to-local">("to-remote");
  const [remoteUrl, setRemoteUrl] = useState("https://mem.ihasy.com");
  const [remoteEmail, setRemoteEmail] = useState("");
  const [remotePassword, setRemotePassword] = useState("");
  const [migrateMsg, setMigrateMsg] = useState("");

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      setSt(await bridge.status());
    } catch {
      setSt(null);
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onProgress((l) => {
      if (typeof l === "string") setLine(l);
    });
  }, [bridge]);

  if (!bridge) return null;

  const using = !!st?.running && sameServer(st.url, currentServer);

  const run = async () => {
    setBusy(true);
    setError("");
    setLine("");
    try {
      const res = await bridge.start();
      if (!res.ok && res.code !== "cancelled") setError(res.error || "启动失败");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      const res = await bridge.stop();
      if (!res.ok && res.error && res.error !== "已取消") setError(res.error);
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const runMigrate = async () => {
    if (!bridge.migrate) return;
    setBusy(true);
    setError("");
    setMigrateMsg("");
    setLine("");
    try {
      const res = await bridge.migrate({
        direction,
        remoteUrl: remoteUrl.trim(),
        remoteEmail: remoteEmail.trim() || undefined,
        remotePassword: remotePassword || undefined,
      });
      if (!res.ok) {
        setError(res.error || "数据迁移失败");
      } else {
        const docs = res.counts?.documents ?? 0;
        const mems = res.counts?.user_memories ?? 0;
        setMigrateMsg(`迁移完成（文档 ${docs} 份、核心记忆 ${mems} 条），已自动保留本地备份：${res.backupPath || ""}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const primaryLabel = busy ? "正在启动…" : st?.running ? "切换到本机" : st?.installed ? "运行" : "在这台电脑上运行";

  return (
    <div
      data-testid="local-server-card"
      style={{
        padding: "14px 16px",
        borderRadius: 14,
        background: using ? "var(--aurora-accent-soft)" : "var(--aurora-card-bg)",
        border: `1px solid ${using ? "var(--aurora-accent)" : "var(--aurora-border)"}`,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--aurora-chip)",
            color: "var(--aurora-accent)",
          }}
        >
          <Icon name="devices" size={17} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--aurora-fg1)" }}>单机模式</span>
            {st?.running && (
              <span style={{ fontSize: 10.5, padding: "1px 6px", borderRadius: 4, background: "rgba(16,185,129,0.14)", color: "#10B981", fontWeight: 600 }}>
                运行中
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: "var(--aurora-fg3)", marginTop: 3, lineHeight: 1.55 }}>{localServerSummary(st, currentServer)}</div>
        </div>
      </div>

      {busy && line && (
        <div
          data-testid="local-server-progress"
          style={{ fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--aurora-fg3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {line}
        </div>
      )}
      {error && (
        <div style={{ fontSize: 12, color: "#DC2626", whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.5 }}>{error}</div>
      )}
      {migrateMsg && (
        <div style={{ fontSize: 12, color: "#10B981", whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.5 }}>{migrateMsg}</div>
      )}

      {showMigrate && bridge.migrate && (
        <div
          style={{
            padding: 12,
            borderRadius: 10,
            background: "var(--aurora-chip)",
            border: "1px solid var(--aurora-border)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" onClick={() => setDirection("to-remote")} style={btn(direction === "to-remote")}>
              单机迁到服务版
            </button>
            <button type="button" onClick={() => setDirection("to-local")} style={btn(direction === "to-local")}>
              服务版迁回单机
            </button>
          </div>
          <input
            type="text"
            placeholder="服务版地址（如 https://mem.ihasy.com）"
            value={remoteUrl}
            onChange={(e) => setRemoteUrl(e.target.value)}
            style={inputStyle}
          />
          <input
            type="email"
            placeholder="对方服务器登录邮箱（如当前已登录对方则可留空）"
            value={remoteEmail}
            onChange={(e) => setRemoteEmail(e.target.value)}
            style={inputStyle}
          />
          <input
            type="password"
            placeholder="对方服务器登录密码"
            value={remotePassword}
            onChange={(e) => setRemotePassword(e.target.value)}
            style={inputStyle}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={() => setShowMigrate(false)} disabled={busy} style={btn(false)}>
              收起
            </button>
            <button type="button" onClick={() => void runMigrate()} disabled={busy || !remoteUrl.trim()} style={btn(true)}>
              {busy ? "迁移中…" : "先备份再开始迁移"}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        {st?.engine !== "embedded" && st?.docker === "missing" ? (
          <button type="button" onClick={() => void desktop()?.openExternal?.(DOCKER_URL)} style={btn(true)}>
            下载 Docker Desktop
          </button>
        ) : (
          <>
            {bridge.migrate && st?.running && (
              <button type="button" onClick={() => setShowMigrate((v) => !v)} disabled={busy} style={btn(false)}>
                单机 / 服务版迁移
              </button>
            )}
            {st?.running && (
              <button type="button" onClick={() => void stop()} disabled={busy} style={btn(false)}>
                停止
              </button>
            )}
            {!using && (
              <button type="button" onClick={() => void run()} disabled={busy || !st} style={btn(true)} data-testid="local-server-run">
                {primaryLabel}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "7px 10px",
  borderRadius: 8,
  fontSize: 12,
  border: "1px solid var(--aurora-border)",
  background: "var(--aurora-card-bg)",
  color: "var(--aurora-fg1)",
  outline: "none",
};

function btn(primary: boolean): React.CSSProperties {
  return {
    padding: "6px 14px",
    borderRadius: 9,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    border: primary ? "none" : "1px solid var(--aurora-border)",
    background: primary ? "var(--aurora-accent)" : "transparent",
    color: primary ? "#fff" : "var(--aurora-fg2)",
  };
}
