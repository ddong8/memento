"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getApiBase, authFetch } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { Icon, ToolGlyph } from "@/components/aurora/Icon";
import { Btn, Glass, GhostInput, TopBar } from "@/components/aurora/primitives";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";

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
  error?: boolean;
}

export default function AskPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const { t } = useI18n();
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Follow the stream as tokens land.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  // Abort any in-flight stream if the user navigates away mid-answer.
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || streaming) return;

    // Snapshot history BEFORE appending, so the model doesn't see the
    // question twice (it is sent separately as `question`).
    const history = turns
      .filter((x) => !x.error)
      .map((x) => ({ role: x.role, content: x.content }));

    setInput("");
    setTurns((prev) => [
      ...prev,
      { role: "user", content: question },
      { role: "assistant", content: "" },
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
        body: JSON.stringify({ question, history }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        patchLast((x) => ({ ...x, content: t.ask.error, error: true }));
        return;
      }

      // SSE over POST — EventSource only does GET, so parse the stream by hand.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Frames are separated by a blank line; keep any partial tail.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let evt: { type: string; text?: string; sources?: Source[]; message?: string };
          try {
            evt = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (evt.type === "sources") {
            patchLast((x) => ({ ...x, sources: evt.sources ?? [] }));
          } else if (evt.type === "delta" && evt.text) {
            patchLast((x) => ({ ...x, content: x.content + evt.text }));
          } else if (evt.type === "error") {
            patchLast((x) => ({ ...x, content: evt.message || t.ask.error, error: true }));
          }
        }
      }
    } catch (err) {
      // An abort is the user pressing Stop — keep whatever streamed so far.
      if ((err as Error)?.name !== "AbortError") {
        patchLast((x) => ({ ...x, content: x.content || t.ask.error, error: true }));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [input, streaming, turns, t]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Enter sends; Shift+Enter is a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
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
        <Glass padding={40} radius={20} style={{ textAlign: "center", marginBottom: 18 }}>
          <Icon name="sparkles" size={26} style={{ color: "var(--aurora-accent)" }} />
          <p style={{ color: "var(--aurora-fg3)", fontSize: 14, marginTop: 10 }}>{t.ask.empty}</p>
        </Glass>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 18 }}>
        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <div key={i} style={{ display: "flex", justifyContent: "flex-end" }}>
              <div
                style={{
                  background: "var(--aurora-accent-soft)",
                  color: "var(--aurora-fg1)",
                  padding: "10px 15px",
                  borderRadius: 16,
                  maxWidth: "80%",
                  fontSize: 14,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {turn.content}
              </div>
            </div>
          ) : (
            <Glass key={i} padding={18} radius={18}>
              {turn.content ? (
                <div className="prose prose-sm max-w-none" style={{ fontSize: 14 }}>
                  <MarkdownViewer content={turn.content} />
                </div>
              ) : (
                <span style={{ color: "var(--aurora-fg4)", fontSize: 13 }}>{t.ask.thinking}</span>
              )}

              {turn.sources && turn.sources.length > 0 && (
                <div style={{ marginTop: 14, borderTop: "1px solid var(--aurora-border)", paddingTop: 12 }}>
                  <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginBottom: 8 }}>
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

      <div style={{ display: "flex", gap: 10, position: "sticky", bottom: 16 }}>
        <GhostInput
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t.ask.placeholder}
          icon="sparkles"
          wrapStyle={{ flex: 1 }}
          disabled={streaming}
        />
        {streaming ? (
          <Btn onClick={() => abortRef.current?.abort()}>{t.ask.stop}</Btn>
        ) : (
          <Btn onClick={send} disabled={!input.trim()} icon="search">
            {t.ask.send}
          </Btn>
        )}
      </div>
    </div>
  );
}
