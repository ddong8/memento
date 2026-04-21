"use client";

import { useState } from "react";
import Link from "next/link";
import { SearchResult, getApiBase, authFetch } from "@/lib/api-client";
import { useI18n, fmt } from "@/lib/i18n";
import { useDevice } from "@/lib/device-context";
import { Icon, ToolGlyph } from "@/components/aurora/Icon";
import { Btn, Chip, Glass, GhostInput, TopBar } from "@/components/aurora/primitives";

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [toolFilter, setToolFilter] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const { t } = useI18n();
  const { selectedDeviceId } = useDevice();

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ q: query, offset: "0", limit: "20" });
      if (toolFilter) params.set("tool", toolFilter);
      if (selectedDeviceId) params.set("device_id", selectedDeviceId);
      const res = await authFetch(`${getApiBase()}/api/search?${params}`);
      setResult(await res.json());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
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
          {result.results.map((r) => (
            <Link key={r.id} href={`/documents/${r.id}`} style={{ textDecoration: "none" }}>
              <Glass hover padding={18} radius={18}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                  <ToolGlyph id={r.tool_id} size={26} />
                  <Chip>{r.category}</Chip>
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
                      ? r.snippet.split(new RegExp(`(${result.query})`, "i")).map((p, j) =>
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
              <p style={{ color: "var(--aurora-fg4)", fontSize: 13 }}>No results</p>
            </Glass>
          )}
        </div>
      )}
    </div>
  );
}
