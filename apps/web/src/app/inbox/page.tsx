"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { authFetch, getApiBase } from "@/lib/api-client";
import { Btn, Chip, Glass, TopBar } from "@/components/aurora/primitives";
import TodoPanel from "@/components/todos/TodoPanel";

interface InboxItem {
  token: string;
  kind: "timeline" | "daily" | "memory" | string;
  target_id: string;
  title: string | null;
  expires_at: string | null;
  created_at: string;
  owner_label: string | null;
}

export default function InboxPage() {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const dateFmt = locale === "zh-CN" ? "zh-CN" : "en-US";

  useEffect(() => {
    authFetch(`${getApiBase()}/api/share/inbox`)
      .then((r) => r.json())
      .then((rows: InboxItem[]) => setItems(rows))
      .catch(() => setItems([]))
      .finally(() => setLoaded(true));
  }, []);

  const kindLabel = (k: string) =>
    k === "timeline" ? t.inbox.kindTimeline :
    k === "daily" ? t.inbox.kindDaily :
    k === "memory" ? t.inbox.kindMemory :
    k;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <TopBar title={t.nav.inbox || "工作待办"} />
      <TodoPanel />

      <div className="pt-2">
        <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--aurora-fg1)", marginBottom: 4 }}>
          {t.inbox.title}
        </h3>
        <p style={{ fontSize: 13, color: "var(--aurora-fg3)", marginBottom: 16 }}>
          {t.inbox.subtitle}
        </p>

      <Glass padding={6} radius={20}>
        {loaded && items.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--aurora-fg4)", fontSize: 13, padding: 32 }}>
            {t.inbox.empty}
          </div>
        )}
        {items.map((it, i) => (
          <div key={it.token} style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "14px 16px", flexWrap: "wrap",
            borderTop: i === 0 ? "none" : "1px solid var(--aurora-border)",
          }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <Chip tone="accent">{kindLabel(it.kind)}</Chip>
                <span style={{ fontSize: 14, fontWeight: 500, color: "var(--aurora-fg1)" }}>
                  {it.title || it.target_id}
                </span>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 4, fontSize: 11, color: "var(--aurora-fg4)", flexWrap: "wrap" }}>
                <span>{t.inbox.sharedBy}: <strong style={{ color: "var(--aurora-fg3)" }}>{it.owner_label || "—"}</strong></span>
                <span>· {new Date(it.created_at).toLocaleDateString(dateFmt)}</span>
                {it.expires_at && (
                  <span>· {t.inbox.expiresAt}: {new Date(it.expires_at).toLocaleDateString(dateFmt)}</span>
                )}
              </div>
            </div>
            <Link href={`/s/${it.token}`} style={{ textDecoration: "none" }}>
              <Btn size="sm" icon="external_link">{t.inbox.open}</Btn>
            </Link>
          </div>
        ))}
      </Glass>
      </div>
    </div>
  );
}
