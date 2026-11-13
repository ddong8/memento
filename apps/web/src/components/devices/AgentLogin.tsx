"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fmt, useI18n } from "@/lib/i18n";
import { getApiBase, authFetch } from "@/lib/api-client";
import { Icon, ToolGlyph } from "@/components/aurora/Icon";
import { Btn, Glass } from "@/components/aurora/primitives";

type AgentId = "claude" | "codex" | "agy";

/** What the device's daemon says about one agent CLI (packages/daemon/src/agent-login.ts) */
export interface LoginState {
  agent: AgentId;
  state: "logged_in" | "logged_out" | "waiting" | "failed" | "missing" | "unsupported";
  url?: string;
  user_code?: string;
  needs_code?: boolean;
  expires_at?: number;
  account?: string;
  detail?: string;
}

const AGENTS: { id: AgentId; tool: string; label: string }[] = [
  { id: "claude", tool: "claude_code", label: "Claude Code" },
  { id: "codex", tool: "codex", label: "Codex" },
  { id: "agy", tool: "antigravity", label: "Antigravity" },
];

async function call(deviceId: string, action: string, agent = "", code = ""): Promise<LoginState & { agents?: LoginState[] }> {
  const r = await authFetch(`${getApiBase()}/api/devices/${deviceId}/agent-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, agent, code }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof j.detail === "string" ? j.detail : `HTTP ${r.status}`);
  return j;
}

/** Signs the agent CLIs on a device (a Linux executor nobody sits at) in from the page. */
export function AgentLoginModal({ device, onClose }: { device: { id: string; name: string }; onClose: () => void }) {
  const { t } = useI18n();
  const [states, setStates] = useState<Partial<Record<AgentId, LoginState>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<AgentId | null>(null);
  const [codes, setCodes] = useState<Partial<Record<AgentId, string>>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const statesRef = useRef(states);
  statesRef.current = states;

  const put = (s: LoginState) => setStates((m) => ({ ...m, [s.agent]: s }));

  useEffect(() => {
    let alive = true;
    call(device.id, "status")
      .then((r) => {
        if (!alive) return;
        const m: Partial<Record<AgentId, LoginState>> = {};
        for (const s of r.agents ?? []) m[s.agent] = s;
        setStates(m);
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [device.id]);

  const waiting = AGENTS.filter((a) => states[a.id]?.state === "waiting");
  const codexWaiting = states.codex?.state === "waiting";

  // Countdown for the links, and Codex's approval noticed by polling
  useEffect(() => {
    if (!waiting.length) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [waiting.length]);

  useEffect(() => {
    if (!codexWaiting) return;
    const iv = setInterval(() => {
      call(device.id, "poll", "codex")
        .then((s) => {
          if (statesRef.current.codex?.state === "waiting") put(s);
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(iv);
  }, [codexWaiting, device.id]);

  const close = useCallback(() => {
    for (const a of AGENTS) {
      if (statesRef.current[a.id]?.state === "waiting") void call(device.id, "cancel", a.id).catch(() => {});
    }
    onClose();
  }, [device.id, onClose]);

  const start = async (agent: AgentId) => {
    setBusy(agent);
    setCodes((c) => ({ ...c, [agent]: "" }));
    try {
      put(await call(device.id, "start", agent));
    } catch (e) {
      put({ agent, state: "failed", detail: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const submit = async (agent: AgentId) => {
    const code = (codes[agent] ?? "").trim();
    if (!code) return;
    setBusy(agent);
    try {
      put(await call(device.id, "submit", agent, code));
    } catch (e) {
      put({ agent, state: "failed", detail: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1600);
    });
  };

  const badge = (s?: LoginState) => {
    if (!s) return { text: "…", color: "var(--aurora-fg4)" };
    if (s.state === "logged_in") return { text: t.devices.loginStateIn, color: "#34d399" };
    if (s.state === "missing") return { text: t.devices.loginStateMissing, color: "var(--aurora-fg4)" };
    if (s.state === "unsupported") return { text: t.devices.loginStateUnsupported, color: "var(--aurora-fg4)" };
    return { text: t.devices.loginStateOut, color: "#fbbf24" };
  };

  return (
    <div
      onClick={() => !busy && close()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        background: "rgba(10,8,20,0.65)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560, width: "100%", maxHeight: "90vh", overflowY: "auto" }}>
        <Glass padding={26} radius={22}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--aurora-fg1)" }}>{t.devices.loginTitle}</h3>
            <button
              onClick={() => !busy && close()}
              aria-label="Close"
              style={{ background: "transparent", border: 0, cursor: "pointer", padding: 4, color: "var(--aurora-fg3)" }}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <p style={{ margin: "0 0 16px", fontSize: 13, lineHeight: 1.6, color: "var(--aurora-fg3)" }}>
            {fmt(t.devices.loginSubtitle, { name: device.name })}
          </p>

          {loading && <div style={{ fontSize: 13, color: "var(--aurora-fg4)" }}>{t.devices.loginChecking}</div>}
          {error && <div style={{ fontSize: 13, color: "#f87171" }}>{error}</div>}

          {!loading && !error && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {AGENTS.map((a) => {
                const s = states[a.id];
                const b = badge(s);
                const isWaiting = s?.state === "waiting";
                const left = isWaiting && s?.expires_at ? Math.max(0, Math.round((s.expires_at - now) / 1000)) : null;
                const expired = left === 0;
                const canStart = s && !["logged_in", "missing", "unsupported"].includes(s.state);
                return (
                  <div
                    key={a.id}
                    style={{
                      border: "1px solid var(--aurora-line, rgba(255,255,255,0.08))",
                      borderRadius: 14,
                      padding: 14,
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <ToolGlyph id={a.tool} size={26} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)" }}>{a.label}</div>
                        <div style={{ fontSize: 12, color: b.color, marginTop: 1 }}>
                          {b.text}
                          {s?.account ? ` · ${s.account}` : ""}
                        </div>
                      </div>
                      {canStart && (!isWaiting || expired) && (
                        <Btn size="sm" variant="glass" icon="lock" onClick={() => start(a.id)} disabled={!!busy}>
                          {busy === a.id ? "…" : s?.state === "logged_out" ? t.devices.loginStart : t.devices.loginRelogin}
                        </Btn>
                      )}
                    </div>

                    {s?.state === "missing" && <div style={{ fontSize: 12, color: "var(--aurora-fg4)" }}>{t.devices.loginMissingHint}</div>}
                    {s?.detail && !isWaiting && s.state !== "logged_in" && (
                      <div style={{ fontSize: 12, color: s.state === "failed" ? "#f87171" : "var(--aurora-fg4)" }}>{s.detail}</div>
                    )}
                    {a.id === "agy" && s?.state === "logged_out" && (
                      <div style={{ fontSize: 12, color: "var(--aurora-fg4)" }}>{t.devices.loginAgyHint}</div>
                    )}

                    {isWaiting && s?.url && !expired && (
                      <>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                          <a href={s.url} target="_blank" rel="noreferrer noopener" style={{ textDecoration: "none" }}>
                            <Btn size="sm" icon="external_link">{t.devices.loginOpen}</Btn>
                          </a>
                          <Btn size="sm" variant="ghost" icon={copied === `${a.id}-url` ? "check" : "copy"} onClick={() => copy(`${a.id}-url`, s.url!)}>
                            {t.devices.loginCopyLink}
                          </Btn>
                          {left !== null && (
                            <span style={{ fontSize: 12, color: left < 20 ? "#fbbf24" : "var(--aurora-fg4)", marginLeft: "auto" }}>
                              {fmt(t.devices.loginLeft, { s: String(left) })}
                            </span>
                          )}
                        </div>

                        {s.user_code && (
                          <>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <code
                                style={{
                                  fontSize: 22,
                                  fontWeight: 700,
                                  letterSpacing: 3,
                                  fontFamily: "var(--font-mono)",
                                  color: "var(--aurora-fg1)",
                                  padding: "6px 12px",
                                  borderRadius: 10,
                                  background: "rgba(255,255,255,0.06)",
                                }}
                              >
                                {s.user_code}
                              </code>
                              <Btn size="sm" variant="ghost" icon={copied === `${a.id}-code` ? "check" : "copy"} onClick={() => copy(`${a.id}-code`, s.user_code!)} />
                            </div>
                            <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--aurora-fg3)" }}>{t.devices.loginCodexStep}</div>
                          </>
                        )}

                        {s.needs_code && (
                          <>
                            <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--aurora-fg3)" }}>{t.devices.loginCodeStep}</div>
                            <div style={{ display: "flex", gap: 8 }}>
                              <input
                                value={codes[a.id] ?? ""}
                                onChange={(e) => setCodes((c) => ({ ...c, [a.id]: e.target.value }))}
                                onKeyDown={(e) => e.key === "Enter" && void submit(a.id)}
                                placeholder={t.devices.loginCodePlaceholder}
                                autoComplete="off"
                                spellCheck={false}
                                style={{
                                  flex: 1,
                                  minWidth: 0,
                                  fontSize: 13,
                                  fontFamily: "var(--font-mono)",
                                  padding: "8px 12px",
                                  borderRadius: 10,
                                  border: "1px solid var(--aurora-line, rgba(255,255,255,0.12))",
                                  background: "rgba(255,255,255,0.04)",
                                  color: "var(--aurora-fg1)",
                                  outline: "none",
                                }}
                              />
                              <Btn size="sm" onClick={() => submit(a.id)} disabled={!!busy || !(codes[a.id] ?? "").trim()}>
                                {busy === a.id ? t.devices.loginSubmitting : t.devices.loginSubmit}
                              </Btn>
                            </div>
                          </>
                        )}
                      </>
                    )}
                    {isWaiting && expired && <div style={{ fontSize: 12, color: "#fbbf24" }}>{t.devices.loginExpired}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </Glass>
      </div>
    </div>
  );
}
