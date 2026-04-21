"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { getApiBase, authFetch } from "@/lib/api-client";
import { ToolGlyph, PlatformGlyph, Icon } from "@/components/aurora/Icon";
import { Glass, TopBar } from "@/components/aurora/primitives";

interface Device {
  id: string;
  name: string;
  device_id: string;
  last_heartbeat: string | null;
  created_at: string;
  document_count: number;
  tools: string[];
}

function useTimeAgo(t: ReturnType<typeof useI18n>["t"]) {
  return (iso: string | null) => {
    if (!iso) return t.never;
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return t.justNow;
    if (mins < 60) return `${mins}${t.mAgo}`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}${t.hAgo}`;
    return `${Math.floor(hrs / 24)}${t.dAgo}`;
  };
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [discoveries, setDiscoveries] = useState<Record<string, Record<string, { root?: string }>>>({});
  const { t, locale } = useI18n();
  const timeAgo = useTimeAgo(t);

  useEffect(() => {
    authFetch(`${getApiBase()}/api/devices`)
      .then((r) => r.json())
      .then((devs: Device[]) => {
        setDevices(devs);
        for (const d of devs) {
          authFetch(`${getApiBase()}/api/devices/${d.id}/discovery`)
            .then((r) => r.json())
            .then((disc) => setDiscoveries((prev) => ({ ...prev, [d.id]: disc.tools || {} })))
            .catch(() => {});
        }
      })
      .catch(console.error);
  }, []);

  return (
    <div className="max-w-5xl mx-auto">
      <TopBar title={t.devices.title} subtitle={t.devices.subtitle} />

      {devices.length === 0 ? (
        <Glass padding={40} radius={22} style={{ textAlign: "center" }}>
          <div
            style={{
              width: 56, height: 56, borderRadius: 16, margin: "0 auto 16px",
              background: "var(--aurora-brand-grad)",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 12px 40px -10px rgba(124,58,237,0.5)",
            }}
          >
            <Icon name="devices" size={26} style={{ color: "#fff" }} strokeWidth={2} />
          </div>
          <p style={{ fontSize: 15, fontWeight: 500, color: "var(--aurora-fg1)", marginBottom: 4 }}>
            {t.devices.noDevices}
          </p>
          <p style={{ fontSize: 13, color: "var(--aurora-fg4)", marginBottom: 14 }}>{t.devices.installHint}</p>
          <pre
            style={{
              display: "block",
              background: "#111827",
              color: "#34D399",
              borderRadius: 12,
              padding: 14,
              fontSize: 13,
              maxWidth: 540,
              margin: "0 auto",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              textAlign: "left",
              whiteSpace: "pre",
              overflow: "auto",
            }}
          >
{`pip install memento-brain-collector    # ${t.devices.snippetCollectorOnly}
# ${t.devices.snippetMetaOption}
pip install memento-brain

memento-collector setup`}
          </pre>
        </Glass>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {devices.map((d) => {
            const isOnline =
              d.last_heartbeat && Date.now() - new Date(d.last_heartbeat).getTime() < 300000;
            const toolsShown = d.tools.filter((tool) => tool !== "system");
            return (
              <Glass key={d.id} padding={22} radius={20}>
                <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                  <PlatformGlyph name={d.name} size={48} />
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
                      <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.02em" }}>
                        {d.name}
                      </h3>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          fontSize: 11,
                          color: isOnline ? "#10B981" : "var(--aurora-fg4)",
                          fontWeight: 500,
                          padding: "2px 9px",
                          borderRadius: 9999,
                          background: isOnline ? "rgba(16,185,129,0.12)" : "var(--aurora-chip)",
                        }}
                      >
                        <span
                          style={{
                            width: 6, height: 6, borderRadius: 9999,
                            background: isOnline ? "#10B981" : "var(--aurora-fg4)",
                            boxShadow: isOnline ? "0 0 8px #10B981" : "none",
                          }}
                        />
                        {isOnline ? t.online : timeAgo(d.last_heartbeat)}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12, color: "var(--aurora-fg3)", flexWrap: "wrap" }}>
                      <span>
                        <b style={{ color: "var(--aurora-fg1)" }}>{d.document_count}</b> {t.files}
                      </span>
                      <span style={{ color: "var(--aurora-fg5)" }}>·</span>
                      <span style={{ fontFamily: "ui-monospace,monospace", color: "var(--aurora-fg4)" }}>
                        {d.device_id.slice(0, 8)}
                      </span>
                      <span style={{ color: "var(--aurora-fg5)" }}>·</span>
                      <span>
                        {t.devices.registered}: {new Date(d.created_at).toLocaleDateString(locale)}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: "flex" }}>
                    {toolsShown.map((tid, j) => (
                      <div key={tid} style={{ marginLeft: j === 0 ? 0 : -10 }}>
                        <ToolGlyph id={tid} size={30} />
                      </div>
                    ))}
                  </div>
                </div>

                {discoveries[d.id] && Object.keys(discoveries[d.id]).length > 0 && (
                  <div
                    style={{
                      borderTop: "1px solid var(--aurora-border)",
                      marginTop: 14,
                      paddingTop: 12,
                      display: "flex",
                      flexDirection: "column",
                      gap: 5,
                    }}
                  >
                    {Object.entries(discoveries[d.id]).map(([tool, info]) => (
                      <div key={tool} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11 }}>
                        <span
                          style={{
                            fontWeight: 500,
                            color: "var(--aurora-fg2)",
                            minWidth: 100,
                            textTransform: "capitalize",
                          }}
                        >
                          {tool.replace("_", " ")}
                        </span>
                        <code
                          style={{
                            color: "var(--aurora-fg4)",
                            fontFamily: "ui-monospace,monospace",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {info.root}
                        </code>
                      </div>
                    ))}
                  </div>
                )}
              </Glass>
            );
          })}
        </div>
      )}
    </div>
  );
}
