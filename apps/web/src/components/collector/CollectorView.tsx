"use client";

import { useEffect, useRef, useState } from "react";
import { desktop, mcpSnippets, type DaemonState, type DesktopInfo, type MementoDesktop } from "@/lib/desktop";
import { fmt, useI18n } from "@/lib/i18n";
import { Btn, Chip, Glass, TopBar } from "@/components/aurora/primitives";
import { BrandMark } from "@/components/aurora/BrandMark";

const RELEASES = "https://github.com/ddong8/memento/releases/latest";

export function CollectorView({ hideTopBar = false }: { hideTopBar?: boolean }) {
  const { t } = useI18n();
  const c = t.collector;
  const [bridge, setBridge] = useState<MementoDesktop | null | undefined>(undefined);
  const [state, setState] = useState<DaemonState | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const d = desktop();
    setBridge(d);
    if (!d) return;
    const refresh = () => d.daemon.status().then(setState).catch(() => {});
    refresh();
    d.daemon.logs().then(setLogs).catch(() => {});
    d.info().then(setInfo).catch(() => {});
    const offStatus = d.daemon.onStatus((status) => setState((s) => (s ? { ...s, status } : s)));
    const offMode = d.daemon.onMode(() => refresh());
    const offLog = d.daemon.onLog((line) => setLogs((l) => [...l.slice(-299), line]));
    const timer = setInterval(refresh, 15_000);
    return () => {
      offStatus();
      offMode();
      offLog();
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  const act = async (name: "resync" | "rediscover" | "sync-profile", done: string) => {
    if (!bridge) return;
    setBusy(name);
    setNotice(null);
    try {
      await bridge.daemon.action(name);
      setNotice(done);
      setState(await bridge.daemon.status());
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (bridge === undefined) return null;
  if (!bridge) {
    return (
      <div className="w-full">
        {!hideTopBar && <TopBar title={c.title} subtitle={c.subtitle} />}
        <Glass padding={22} radius={18}>
          <p style={{ margin: "0 0 14px", fontSize: 13.5, color: "var(--aurora-fg2)", lineHeight: 1.6 }}>{c.desktopOnly}</p>
          <a href={RELEASES} target="_blank" rel="noreferrer">
            <Btn size="sm" icon="arrow_down">{c.download}</Btn>
          </a>
        </Glass>
      </div>
    );
  }

  const status = state?.status;
  const active = state?.mode === "running" || state?.mode === "external";
  const tools = Object.entries(status?.tools ?? {});
  const tone = active ? (status?.online ? "success" : "warn") : state?.mode === "crashed" ? "danger" : "neutral";

  return (
    <div className="w-full">
      {!hideTopBar && <TopBar title={c.title} subtitle={c.subtitle} />}

      <Glass padding="clamp(14px, 3vw, 20px)" radius={18} style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Chip tone={tone}>{state?.label ?? t.loading}</Chip>
          {active && <Chip tone={status?.online ? "success" : "warn"}>{status?.online ? c.online : c.offline}</Chip>}
          <span style={{ flex: 1 }} />
          {info && <span style={{ fontSize: 12, color: "var(--aurora-fg3)" }}>Memento {info.version}</span>}
        </div>
        {status && (
          <div style={{ marginTop: 12, fontSize: 13, color: "var(--aurora-fg2)", lineHeight: 1.7 }}>
            <div>{fmt(c.device, { name: status.deviceName })}</div>
            <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "var(--aurora-fg3)" }}>{status.deviceId}</div>
            {status.runningTasks.length > 0 && <div>{fmt(c.runningTasks, { n: status.runningTasks.length })}</div>}
          </div>
        )}
        {state?.mode === "flutter" && <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "var(--aurora-fg3)", lineHeight: 1.55 }}>{c.flutterHint}</p>}
        {state?.mode === "no-token" && <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "var(--aurora-fg3)" }}>{c.noTokenHint}</p>}
        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <Btn variant="glass" size="sm" icon="refresh" disabled={!active || busy !== null} onClick={() => act("rediscover", c.rediscovered)}>
            {c.rediscover}
          </Btn>
          <Btn variant="glass" size="sm" icon="user" disabled={!active || busy !== null} onClick={() => act("sync-profile", c.profileSynced)}>
            {c.syncProfile}
          </Btn>
          <Btn variant="ghost" size="sm" disabled={!active || busy !== null} onClick={() => act("resync", c.resyncQueued)}>
            {c.resync}
          </Btn>
        </div>
        {notice && <p style={{ margin: "10px 0 0", fontSize: 12.5, color: "var(--aurora-fg2)" }}>{notice}</p>}
      </Glass>

      {tools.length > 0 && (
        <Glass padding="clamp(14px, 3vw, 20px)" radius={18} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)", marginBottom: 8 }}>{fmt(c.tools, { n: tools.length })}</div>
          {tools.map(([id, tool]) => (
            <div key={id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "7px 0", borderTop: "1px solid var(--aurora-border)" }}>
              <BrandMark id={id} size={18} colored />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, color: "var(--aurora-fg1)" }}>{id}</div>
                <div style={{ fontSize: 11.5, color: "var(--aurora-fg3)", fontFamily: "ui-monospace, monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {String(tool.root ?? "")}
                </div>
              </div>
              <span style={{ fontSize: 12, color: "var(--aurora-fg3)" }}>{fmt(c.projects, { n: tool.projects?.length ?? 0 })}</span>
            </div>
          ))}
        </Glass>
      )}

      {info && (
        <Glass padding="clamp(14px, 3vw, 20px)" radius={18} style={{ marginBottom: 14 }}>
          <label style={{ display: "flex", gap: 12, alignItems: "flex-start", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={info.openAtLogin}
              onChange={async (e) => {
                const on = await bridge.setOpenAtLogin(e.target.checked);
                setInfo((i) => (i ? { ...i, openAtLogin: on } : i));
              }}
              style={{ marginTop: 3, width: 15, height: 15, accentColor: "var(--aurora-accent)" }}
            />
            <span>
              <span style={{ display: "block", fontSize: 14, color: "var(--aurora-fg1)" }}>{c.autostart}</span>
              <span style={{ display: "block", fontSize: 12, color: "var(--aurora-fg3)", marginTop: 2 }}>{c.autostartHint}</span>
            </span>
          </label>
          {info.packaged && (
            <Btn variant="ghost" size="sm" style={{ marginTop: 12 }} onClick={() => bridge.checkForUpdates()}>
              {c.checkUpdates}
            </Btn>
          )}
        </Glass>
      )}

      {info?.mcp && (
        <Glass padding="clamp(14px, 3vw, 20px)" radius={18} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)" }}>{c.mcpTitle}</div>
          <p style={{ margin: "4px 0 10px", fontSize: 12.5, color: "var(--aurora-fg3)", lineHeight: 1.55 }}>{c.mcpHint}</p>
          {(() => {
            const snippets = mcpSnippets(info.mcp);
            const items: { key: keyof typeof snippets; label: string }[] = [
              { key: "claude", label: c.mcpClaude },
              { key: "codex", label: c.mcpCodex },
              { key: "json", label: c.mcpJson },
            ];
            return items.map(({ key, label }) => (
              <div key={key} style={{ marginTop: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ flex: 1, fontSize: 12.5, color: "var(--aurora-fg2)" }}>{label}</span>
                  <Btn
                    variant="ghost"
                    size="sm"
                    icon={copied === key ? "check" : "copy"}
                    onClick={() => {
                      navigator.clipboard?.writeText(snippets[key]).then(() => {
                        setCopied(key);
                        setTimeout(() => setCopied(null), 1500);
                      });
                    }}
                  >
                    {copied === key ? c.copied : c.copy}
                  </Btn>
                </div>
                <pre
                  style={{
                    margin: 0,
                    padding: 10,
                    borderRadius: 8,
                    fontSize: 11.5,
                    lineHeight: 1.5,
                    background: "var(--aurora-surface-mute)",
                    color: "var(--aurora-fg2)",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {snippets[key]}
                </pre>
              </div>
            ));
          })()}
        </Glass>
      )}

      <Glass padding="clamp(14px, 3vw, 20px)" radius={18}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)", marginBottom: 8 }}>{c.logs}</div>
        <pre
          ref={logRef}
          style={{
            margin: 0,
            maxHeight: 360,
            overflow: "auto",
            fontSize: 11.5,
            lineHeight: 1.55,
            padding: 12,
            borderRadius: 10,
            background: "var(--aurora-surface-mute)",
            color: "var(--aurora-fg2)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {logs.length ? logs.join("\n") : c.noLogs}
        </pre>
      </Glass>
    </div>
  );
}
