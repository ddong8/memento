"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SearchHit, getApiBase, authFetch } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { useDevice } from "@/lib/device-context";
import { Icon, ToolGlyph } from "@/components/aurora/Icon";

const RECENT_KEY = "dr_recent_searches";
const MAX_RECENT = 6;
const DEBOUNCE_MS = 220;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string").slice(0, MAX_RECENT) : [];
  } catch {
    // Private windows / disabled site data throw on access, not just return null.
    return [];
  }
}

function pushRecent(q: string) {
  try {
    const next = [q, ...loadRecent().filter((x) => x !== q)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* non-fatal — recents are a convenience, not state we depend on */
  }
}

/**
 * Global Cmd/Ctrl+K search. Mounted once inside the authenticated shell so
 * every page can reach memory without navigating to /search first.
 *
 * Hits the hybrid endpoint, so results are keyword + BGE-M3 vector fused —
 * "那次部署卡住怎么解决的" finds the conversation even with no literal match.
 */
export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [semanticUsed, setSemanticUsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Guards against an older in-flight request overwriting a newer one's
  // results — with a 30s semantic ceiling, out-of-order replies are likely.
  const seqRef = useRef(0);
  const router = useRouter();
  const { t } = useI18n();
  const { selectedDeviceId } = useDevice();

  /* ── open/close on Cmd+K ─────────────────────────────────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setRecent(loadRecent());
      // Autofocus must wait for the input to actually mount.
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery("");
      setHits([]);
      setActive(0);
      setSemanticUsed(false);
    }
  }, [open]);

  /* ── debounced search ────────────────────────────────────────────────── */
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const seq = ++seqRef.current;
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q, offset: "0", limit: "8" });
        if (selectedDeviceId) params.set("device_id", selectedDeviceId);
        const res = await authFetch(`${getApiBase()}/api/search?${params}`);
        const data = await res.json();
        if (seq !== seqRef.current) return; // a newer query already landed
        setHits(data.results ?? []);
        setSemanticUsed(Boolean(data.semantic_used));
        setActive(0);
      } catch {
        if (seq === seqRef.current) setHits([]);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, selectedDeviceId]);

  const go = useCallback(
    (href: string) => {
      const q = query.trim();
      if (q) pushRecent(q);
      setOpen(false);
      router.push(href);
    },
    [query, router]
  );

  /* ── keyboard nav within the list ────────────────────────────────────── */
  const onInputKey = (e: React.KeyboardEvent) => {
    // +1 row for the "view all results" footer action.
    const max = hits.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % (max + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + max + 1) % (max + 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active < max && hits[active]) go(`/documents/${hits[active].id}`);
      else if (query.trim()) go(`/search?q=${encodeURIComponent(query.trim())}`);
    }
  };

  // Keep the highlighted row visible when arrowing past the fold.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const showRecent = !query.trim() && recent.length > 0;

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(0,0,0,0.42)",
        backdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "12vh 16px 16px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="aurora-card"
        style={{
          width: "100%",
          maxWidth: 640,
          borderRadius: 18,
          overflow: "hidden",
          padding: 0,
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* input row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 16px",
            borderBottom: "1px solid var(--aurora-border)",
          }}
        >
          <Icon name="search" size={17} style={{ color: "var(--aurora-fg3)", flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder={t.palette.placeholder}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              fontSize: 15,
              color: "var(--aurora-fg1)",
            }}
          />
          {loading && (
            <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>{t.palette.searching}</span>
          )}
          {!loading && semanticUsed && (
            <span
              title={t.searchPage.semanticOn}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                color: "var(--aurora-accent)",
              }}
            >
              <Icon name="sparkles" size={12} />
              {t.searchPage.semanticOn}
            </span>
          )}
        </div>

        {/* results */}
        <div ref={listRef} style={{ overflowY: "auto", flex: 1 }}>
          {showRecent && (
            <div style={{ padding: "10px 16px" }}>
              <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginBottom: 8 }}>
                {t.palette.recent}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {recent.map((r) => (
                  <button
                    key={r}
                    onClick={() => setQuery(r)}
                    style={{
                      border: "1px solid var(--aurora-border)",
                      background: "transparent",
                      borderRadius: 999,
                      padding: "4px 10px",
                      fontSize: 12,
                      color: "var(--aurora-fg2)",
                      cursor: "pointer",
                    }}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
          )}

          {hits.map((h, i) => (
            <div
              key={h.id}
              data-idx={i}
              onClick={() => go(`/documents/${h.id}`)}
              onMouseEnter={() => setActive(i)}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "10px 16px",
                cursor: "pointer",
                background: i === active ? "var(--aurora-accent-soft)" : "transparent",
              }}
            >
              <ToolGlyph id={h.tool_id} size={22} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontSize: 13.5,
                    color: "var(--aurora-fg1)",
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {h.title || h.relative_path}
                </div>
                {h.snippet && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--aurora-fg3)",
                      lineHeight: 1.5,
                      maxHeight: 34,
                      overflow: "hidden",
                    }}
                  >
                    {h.snippet.slice(0, 160)}
                  </div>
                )}
              </div>
              {h.matched_semantically && (
                <Icon
                  name="sparkles"
                  size={12}
                  style={{ color: "var(--aurora-accent)", flexShrink: 0, marginTop: 3 }}
                />
              )}
            </div>
          ))}

          {query.trim() && !loading && hits.length === 0 && (
            <div style={{ padding: "22px 16px", textAlign: "center", fontSize: 13, color: "var(--aurora-fg4)" }}>
              {t.palette.noResults}
            </div>
          )}

          {query.trim() && (
            <div
              data-idx={hits.length}
              onClick={() => go(`/search?q=${encodeURIComponent(query.trim())}`)}
              onMouseEnter={() => setActive(hits.length)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 16px",
                cursor: "pointer",
                borderTop: "1px solid var(--aurora-border)",
                fontSize: 12.5,
                color: "var(--aurora-fg2)",
                background: active === hits.length ? "var(--aurora-accent-soft)" : "transparent",
              }}
            >
              <Icon name="grid" size={13} />
              {t.palette.viewAll}
            </div>
          )}
        </div>

        <div
          style={{
            padding: "8px 16px",
            borderTop: "1px solid var(--aurora-border)",
            fontSize: 11,
            color: "var(--aurora-fg4)",
          }}
        >
          {t.palette.hint}
        </div>
      </div>
    </div>
  );
}
