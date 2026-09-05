"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getApiBase, authFetch, DeviceSummary } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { Icon, ToolGlyph } from "@/components/aurora/Icon";
import { Btn, Chip, Glass, GhostInput, TopBar } from "@/components/aurora/primitives";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";
import ExecutionCard, { ToolCallItem } from "@/components/ExecutionCard";

interface Source {
  id: string;
  title: string;
  relative_path: string;
  tool_id: string;
  category: string;
  synced_at: string | null;
  excerpt: string;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  toolCalls?: ToolCallItem[];
  error?: boolean;
}

export default function AskPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>("auto");
  const [cwd, setCwd] = useState<string>("");
  const [showCwd, setShowCwd] = useState<boolean>(false);

  const { t } = useI18n();
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch online/registered devices
  useEffect(() => {
    authFetch(`${getApiBase()}/api/devices`)
      .then((r) => r.json())
      .then((d: DeviceSummary[]) => {
        setDevices(d || []);
      })
      .catch(() => setDevices([]));
  }, []);

  // Follow the stream as tokens land.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  // Abort any in-flight stream if the user navigates away mid-answer.
  useEffect(() => () => abortRef.current?.abort(), []);

  const sendWithText = useCallback(async (textToSend: string) => {
    const question = textToSend.trim();
    if (!question || streaming) return;

    // Snapshot history BEFORE appending
    const history = turns
      .filter((x) => !x.error)
      .map((x) => ({ role: x.role, content: x.content }));

    setInput("");
    setTurns((prev) => [
      ...prev,
      { role: "user", content: question },
      { role: "assistant", content: "", toolCalls: [] },
    ]);
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Mutate the last (assistant) turn as deltas arrive.
    const patchLast = (fn: (turn: Turn) => Turn) =>
      setTurns((prev) => {
        const next = [...prev];
        const i = next.length - 1;
        if (i >= 0 && next[i].role === "assistant") next[i] = fn(next[i]);
        return next;
      });

    try {
      const res = await authFetch(`${getApiBase()}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          history,
          device_id: selectedDevice,
          cwd: cwd.trim() || undefined,
          agent_mode: selectedDevice !== "ask_only",
        }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        patchLast((x) => ({ ...x, content: t.ask.error, error: true }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let evt: {
            type: string;
            text?: string;
            sources?: Source[];
            message?: string;
            name?: string;
            args?: Record<string, unknown>;
            device_name?: string;
            result?: ToolCallItem["result"];
          };
          try {
            evt = JSON.parse(line.slice(6));
          } catch {
            continue;
          }

          if (evt.type === "sources") {
            patchLast((x) => ({ ...x, sources: evt.sources ?? [] }));
          } else if (evt.type === "tool_call") {
            patchLast((x) => {
              const calls = [...(x.toolCalls || [])];
              calls.push({
                name: evt.name || "",
                args: evt.args || {},
                device_name: evt.device_name,
              });
              return { ...x, toolCalls: calls };
            });
          } else if (evt.type === "tool_result") {
            patchLast((x) => {
              const calls = [...(x.toolCalls || [])];
              const idx = calls
                .map((c, i) => (!c.result ? i : -1))
                .filter((i) => i >= 0)
                .pop();
              if (idx !== undefined && idx >= 0) {
                calls[idx] = { ...calls[idx], result: evt.result };
              } else if (calls.length > 0) {
                calls[calls.length - 1] = { ...calls[calls.length - 1], result: evt.result };
              }
              return { ...x, toolCalls: calls };
            });
          } else if (evt.type === "delta" && evt.text) {
            patchLast((x) => ({ ...x, content: x.content + evt.text }));
          } else if (evt.type === "error") {
            patchLast((x) => ({ ...x, content: evt.message || t.ask.error, error: true }));
          }
        }
      }
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        patchLast((x) => ({ ...x, content: x.content || t.ask.error, error: true }));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [cwd, selectedDevice, streaming, turns, t]);

  const send = useCallback(() => {
    sendWithText(input);
  }, [input, sendWithText]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const currentDev = devices.find((d) => d.device_id === selectedDevice);
  const placeholderText =
    selectedDevice === "ask_only"
      ? t.ask.placeholderAskOnly
      : currentDev
      ? `在 ${currentDev.name} 上执行任务或提问，例如：「检查 git 状态」...`
      : t.ask.placeholderAgent;

  return (
    <div className="max-w-4xl mx-auto pb-6">
      <TopBar
        title={t.ask.title}
        subtitle={t.ask.subtitle}
        right={
          turns.length > 0 ? (
            <Btn
              onClick={() => {
                abortRef.current?.abort();
                setTurns([]);
              }}
            >
              {t.ask.clear}
            </Btn>
          ) : undefined
        }
      />

      {turns.length === 0 && (
        <Glass padding={32} radius={20} style={{ textAlign: "center", marginBottom: 20 }}>
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
                  setInput(s.label);
                  sendWithText(s.label);
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 14px",
                  borderRadius: 9999,
                  background: "rgba(255,255,255,0.05)",
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
      <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 20 }}>
        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <div key={i} style={{ display: "flex", justifyContent: "flex-end" }}>
              <div
                style={{
                  background: "var(--aurora-accent-soft)",
                  color: "var(--aurora-fg1)",
                  padding: "11px 16px",
                  borderRadius: 16,
                  maxWidth: "80%",
                  fontSize: 14,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  boxShadow: "0 2px 10px rgba(0,0,0,0.1)",
                }}
              >
                {turn.content}
              </div>
            </div>
          ) : (
            <Glass key={i} padding={20} radius={18}>
              {/* Render tool executions (ExecutionCards) */}
              {turn.toolCalls && turn.toolCalls.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  {turn.toolCalls.map((call, ci) => (
                    <ExecutionCard key={ci} call={call} />
                  ))}
                </div>
              )}

              {/* Render assistant text output */}
              {turn.content ? (
                <div className="prose prose-sm max-w-none" style={{ fontSize: 14, lineHeight: 1.6 }}>
                  <MarkdownViewer content={turn.content} />
                </div>
              ) : (
                (!turn.toolCalls || turn.toolCalls.length === 0) && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--aurora-fg4)", fontSize: 13 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: "var(--aurora-accent)",
                        animation: "pulse 1s infinite",
                      }}
                    />
                    {t.ask.thinking}
                  </div>
                )
              )}

              {/* Sources citations */}
              {turn.sources && turn.sources.length > 0 && (
                <div style={{ marginTop: 14, borderTop: "1px solid var(--aurora-border)", paddingTop: 12 }}>
                  <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginBottom: 8, fontWeight: 500 }}>
                    {t.ask.sources}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {turn.sources.map((s, si) => (
                      <Link key={s.id} href={`/documents/${s.id}`} style={{ textDecoration: "none" }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "7px 10px",
                            border: "1px solid var(--aurora-border)",
                            borderRadius: 12,
                            background: "rgba(255,255,255,0.02)",
                          }}
                        >
                          <span style={{ fontSize: 11, color: "var(--aurora-accent)", fontWeight: 600, flexShrink: 0 }}>
                            [{si + 1}]
                          </span>
                          <ToolGlyph id={s.tool_id} size={18} />
                          <span
                            style={{
                              fontSize: 12.5,
                              color: "var(--aurora-fg2)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {s.title || s.relative_path}
                          </span>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </Glass>
          )
        )}
        <div ref={bottomRef} />
      </div>

      {/* Sticky Bottom Interactive Console Bar */}
      <div
        style={{
          position: "sticky",
          bottom: 16,
          background: "var(--aurora-card, rgba(17, 24, 39, 0.85))",
          backdropFilter: "blur(16px)",
          border: "1px solid var(--aurora-border)",
          borderRadius: 18,
          padding: 10,
          boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
        }}
      >
        {/* Device & environment toolbelt */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          {/* Target device selector */}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "rgba(255,255,255,0.05)",
              border: "1px solid var(--aurora-border)",
              borderRadius: 10,
              padding: "3px 8px",
              fontSize: 12,
            }}
          >
            <Icon name="devices" size={13} style={{ color: "var(--aurora-accent)" }} />
            <select
              value={selectedDevice}
              onChange={(e) => setSelectedDevice(e.target.value)}
              style={{
                background: "transparent",
                border: "none",
                outline: "none",
                color: "var(--aurora-fg1)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              <option value="auto" style={{ background: "#1e293b", color: "#fff" }}>
                {t.ask.autoDispatch}
              </option>
              {devices.map((d) => (
                <option key={d.device_id} value={d.device_id} style={{ background: "#1e293b", color: "#fff" }}>
                  🖥️ {d.name} ({d.device_id.slice(0, 8)})
                </option>
              ))}
              <option value="ask_only" style={{ background: "#1e293b", color: "#fff" }}>
                {t.ask.askOnly}
              </option>
            </select>
          </div>

          {/* Optional working directory selector */}
          {selectedDevice !== "ask_only" && (
            showCwd ? (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid var(--aurora-border)",
                  borderRadius: 10,
                  padding: "3px 8px",
                  flex: 1,
                  minWidth: 160,
                }}
              >
                <Icon name="folder" size={13} style={{ color: "var(--aurora-fg3)" }} />
                <input
                  type="text"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder={t.ask.cwdPlaceholder}
                  style={{
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    color: "var(--aurora-fg1)",
                    fontSize: 12,
                    fontFamily: "monospace",
                    width: "100%",
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowCwd(false)}
                  style={{ background: "none", border: "none", color: "var(--aurora-fg4)", cursor: "pointer", padding: 0 }}
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
                  background: cwd ? "rgba(56, 189, 248, 0.12)" : "rgba(255,255,255,0.04)",
                  border: "1px solid",
                  borderColor: cwd ? "var(--aurora-accent)" : "var(--aurora-border)",
                  borderRadius: 10,
                  padding: "3px 9px",
                  fontSize: 11.5,
                  color: cwd ? "var(--aurora-accent)" : "var(--aurora-fg3)",
                  cursor: "pointer",
                }}
              >
                <Icon name="folder" size={12} />
                <span>{cwd ? cwd : t.ask.cwdLabel}</span>
              </button>
            )
          )}
        </div>

        {/* Input box and action button */}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <GhostInput
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholderText}
            icon={selectedDevice === "ask_only" ? "sparkles" : "terminal"}
            wrapStyle={{ flex: 1 }}
            disabled={streaming}
          />
          {streaming ? (
            <Btn onClick={() => abortRef.current?.abort()}>{t.ask.stop}</Btn>
          ) : (
            <Btn onClick={send} disabled={!input.trim()} icon={selectedDevice === "ask_only" ? "search" : "rocket"}>
              {t.ask.send}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}
