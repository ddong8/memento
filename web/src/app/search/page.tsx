"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { SearchResult, getApiBase, authFetch } from "@/lib/api-client";
import { useI18n, fmt } from "@/lib/i18n";
import { useDevice } from "@/lib/device-context";
import { Icon, ToolGlyph } from "@/components/aurora/Icon";
import { Btn, Chip, Glass, GhostInput, TopBar } from "@/components/aurora/primitives";

/** Escape regex metacharacters before building a highlight pattern.
 *  Without this, searching "c++" or "foo(" throws inside the RegExp
 *  constructor and takes the whole result list down with it. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function SearchPageInner() {
  const searchParams = useSearchParams();
  const initialQ = searchParams.get("q") ?? "";

  const [query, setQuery] = useState(initialQ);
  const [toolFilter, setToolFilter] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const { t } = useI18n();
  const { selectedDeviceId } = useDevice();

  const runSearch = useCallback(
    async (q: string, tool: string) => {
      if (!q.trim()) return;
      setLoading(true);
      try {
        const params = new URLSearchParams({ q, offset: "0", limit: "20" });
        if (tool) params.set("tool", tool);
        if (selectedDeviceId) params.set("device_id", selectedDeviceId);
        const res = await authFetch(`${getApiBase()}/api/search?${params}`);
        setResult(await res.json());
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    },
    [selectedDeviceId]
  );

  // Deep link: /search?q=... — the command palette's "view all results" lands
  // here, so run the query on arrival instead of showing an empty form.
  useEffect(() => {
    if (initialQ.trim()) runSearch(initialQ, "");
    // Only on mount / when the URL query itself changes.
  }, [initialQ, runSearch]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    runSearch(query, toolFilter);
  };

  return (
    <div className="max-w-5xl mx-auto">
      <TopBar
        title={t.searchPage.title}
        subtitle={result ? fmt(t.searchPage.results, { total: result.total, query: result.query }) : "Search conversations, memory, plans, notes"}
      />

      <form onSubmit={handleSearch} style={{ display: "flex", gap: 10, marginBottom: 22, flexWrap: "wrap" }}>
        <GhostInput
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.searchPage.placeholder}
          icon="search"
          wrapStyle={{ flex: 1, minWidth: 240 }}
        />
        <label className="aurora-input" style={{ minWidth: 160 }}>
          <Icon name="grid" size={15} style={{ color: "var(--aurora-fg3)" }} />
          <select value={toolFilter} onChange={(e) => setToolFilter(e.target.value)}>
            <option value="">{t.searchPage.allTools}</option>
            <option value="claude_code">Claude Code</option>
            <option value="openclaw">OpenClaw</option>
            <option value="codex">Codex</option>
            <option value="antigravity">Antigravity</option>
            <option value="obsidian">Obsidian</option>
            <option value="cursor">Cursor</option>
          </select>
        </label>
        <Btn type="submit" disabled={loading} icon={loading ? undefined : "search"}>
          {loading ? "…" : t.search}
        </Btn>
      </form>

      {result && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Say which engine actually answered — a silent keyword fallback
              when the embedding server is down otherwise looks like bad
              semantic recall. */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
            {result.semantic_used ? (
              <>
                <Icon name="sparkles" size={12} style={{ color: "var(--aurora-accent)" }} />
                <span style={{ color: "var(--aurora-accent)" }}>{t.searchPage.semanticOn}</span>
              </>
            ) : (
              <span style={{ color: "var(--aurora-fg4)" }} title={t.searchPage.semanticHint}>
                {t.searchPage.semanticOff}
              </span>
            )}
          </div>

          {result.results.map((r) => (
            <Link key={r.id} href={`/documents/${r.id}`} style={{ textDecoration: "none" }}>
              <Glass hover padding={18} radius={18}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                  <ToolGlyph id={r.tool_id} size={26} />
                  <Chip>{r.category}</Chip>
                  {r.matched_semantically && (
                    <Chip tone="accent" icon="sparkles">
                      {t.searchPage.matchedSemantically}
                    </Chip>
                  )}
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--aurora-fg4)",
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 320,
                    }}
                  >
                    {r.relative_path}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 500,
                    color: "var(--aurora-fg1)",
                    marginBottom: 6,
                    letterSpacing: "-0.01em",
                  }}
                >
                  {r.title || r.relative_path}
                </div>
                {r.snippet && (
                  <div
                    style={{
                      fontSize: 13,
                      color: "var(--aurora-fg3)",
                      lineHeight: 1.55,
                      letterSpacing: "-0.005em",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      maxHeight: 80,
                      overflow: "hidden",
                    }}
                  >
                    {result.query
                      ? r.snippet.split(new RegExp(`(${escapeRegExp(result.query)})`, "i")).map((p, j) =>
                          p.toLowerCase() === result.query.toLowerCase() ? (
                            <mark
                              key={j}
                              style={{
                                background: "var(--aurora-accent-soft)",
                                color: "var(--aurora-accent)",
                                padding: "0 4px",
                                borderRadius: 4,
                                fontWeight: 500,
                              }}
                            >
                              {p}
                            </mark>
                          ) : (
                            <span key={j}>{p}</span>
                          )
                        )
                      : r.snippet}
                  </div>
                )}
              </Glass>
            </Link>
          ))}
          {result.results.length === 0 && (
            <Glass padding={36} radius={20} style={{ textAlign: "center" }}>
              <p style={{ color: "var(--aurora-fg4)", fontSize: 13 }}>{t.searchPage.noResults}</p>
            </Glass>
          )}
        </div>
      )}
    </div>
  );
}

// useSearchParams forces client-side rendering up to the nearest Suspense
// boundary; without one, a production build of this static route fails with
// "Missing Suspense boundary with useSearchParams" (it works fine in dev,
// so the error only shows up at build time).
export default function SearchPage() {
  return (
    <Suspense fallback={null}>
      <SearchPageInner />
    </Suspense>
  );
}
