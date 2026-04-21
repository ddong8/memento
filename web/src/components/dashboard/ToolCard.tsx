"use client";

import Link from "next/link";
import type { ToolSummary } from "@/lib/api-client";
import { ToolGlyph, TOOL_HUE } from "@/components/aurora/Icon";
import { Glass } from "@/components/aurora/primitives";
import { formatBytes, timeAgo } from "@/lib/constants";

export default function ToolCard({ tool }: { tool: ToolSummary }) {
  const tg = TOOL_HUE[tool.id] ?? TOOL_HUE.claude_code;
  return (
    <Link href={`/tools/${tool.id}`} style={{ textDecoration: "none" }}>
      <Glass hover padding={20} radius={20} accent={`hsla(${tg.h},80%,55%,0.25)`}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <ToolGlyph id={tool.id} size={38} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3
              style={{
                margin: 0,
                fontSize: 15,
                fontWeight: 600,
                color: "var(--aurora-fg1)",
                letterSpacing: "-0.01em",
                textTransform: "capitalize",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {tool.display_name}
            </h3>
            <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>{timeAgo(tool.last_sync_at ?? "")}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 24 }}>
          <div>
            <div style={{ fontSize: 24, fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.03em", lineHeight: 1 }}>
              {tool.total_files}
            </div>
            <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginTop: 4 }}>files</div>
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.02em", lineHeight: 1.2 }}>
              {formatBytes(tool.total_size_bytes)}
            </div>
            <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginTop: 4 }}>size</div>
          </div>
        </div>
      </Glass>
    </Link>
  );
}
