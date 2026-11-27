// Profile block & scope helpers shared by ingest, project-exclusion and profile routes (server/server/services/profile_service.py).

export const PROFILE_MAX_CHARS = 1800;
export const SCOPED_MAX_CHARS = 800;
export const PROFILE_BEGIN = "<!-- memento:begin";
export const PROFILE_END = "<!-- memento:end -->";
const PROFILE_BLOCK_RE = /<!-- memento:begin[^>]*-->[\s\S]*?<!-- memento:end -->\n?/g;
const SCOPE_HEADING_RE = /^##\s*(项目|设备)\s*[:：]\s*(.+?)\s*$/;

export interface ProfileScopes {
  general: string;
  projects: Record<string, string[]>;
  devices: Record<string, string[]>;
}

export function stripProfileBlock(text: string): string {
  if (!text || !text.includes(PROFILE_BEGIN)) return text;
  return text.replace(PROFILE_BLOCK_RE, "");
}

export function splitProfileScopes(content: string): ProfileScopes {
  const scopes: ProfileScopes = { general: "", projects: {}, devices: {} };
  const general: string[] = [];
  let current: string[] | null = null;
  for (const line of (content || "").split("\n")) {
    const m = SCOPE_HEADING_RE.exec(line.trim());
    if (m) {
      const bucket = m[1] === "项目" ? scopes.projects : scopes.devices;
      const name = m[2]!;
      if (!bucket[name]) bucket[name] = [];
      current = bucket[name]!;
      continue;
    }
    if (current === null) {
      general.push(line);
    } else if (line.trim() && !line.trimStart().startsWith("#")) {
      current.push(line.replace(/\s+$/, ""));
    }
  }
  scopes.general = general.join("\n").trim();
  return scopes;
}

export function joinProfileScopes(scopes: ProfileScopes): string {
  const parts: string[] = [];
  if (scopes.general.trim()) parts.push(scopes.general.trim());
  for (const [label, bucket] of [
    ["项目", scopes.projects],
    ["设备", scopes.devices],
  ] as const) {
    for (const [name, lines] of Object.entries(bucket)) {
      if (lines.length) parts.push(`## ${label}：${name}\n${lines.join("\n")}`);
    }
  }
  return parts.join("\n\n");
}

export function cleanDeviceName(name: string | null | undefined): string {
  const text = (name || "").trim().replace(/\s*\([^)]*\)\s*$/, "");
  return text.replace(/\.local$/, "").trim();
}

export function normScopeName(name: string): string {
  return (name || "").replace(/[\s_-]+/g, "").toLowerCase();
}
