import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Json, RemoteClient } from "./remote.js";

export const INSTRUCTIONS =
  "Personal AI memory — search conversations, recall knowledge, explore project context from your Memento data. " +
  "For instant mental alignment (心领神会) with the user's implicit intent, domain mindset, scenario iron rules, active graph entities, and pitfalls, call mind_resonance. " +
  "Before deploying, releasing, migrating a database, deleting or changing data, pushing, or changing config, " +
  "call memory_check_rule: it returns the user's iron rules, pitfalls hit before on similar work, and skills to follow. " +
  "After a failure whose cause you found and fixed, call memory_pitfall. When the user says to do something later, " +
  "call todo_add; when asked what's left, call todo_list.";

const s = (v: unknown): string => (v == null ? "" : String(v));
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Json[]) : []);
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const day = (v: unknown) => s(v).slice(0, 10);
/** Subagent sidecars and transient files that only clutter lists. */
const isNoise = (path: unknown) => s(path).endsWith(".meta.json") || s(path).includes(".resolved");
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

type Text = { content: { type: "text"; text: string }[] };
const text = (t: string): Text => ({ content: [{ type: "text", text: t }] });
const failed = (what: string, e: unknown) => text(`${what}: ${e instanceof Error ? e.message : String(e)}`);

async function findProject(remote: RemoteClient, name: string): Promise<Json | undefined> {
  const projects = await remote.get<Json[]>("/api/projects");
  const q = name.toLowerCase();
  return projects.find((p) => s(p.title).toLowerCase().includes(q));
}

export function todoLine(t: Json): string {
  const extra = [t.due ? `due ${s(t.due)}` : "", s(t.project)].filter(Boolean);
  return `- [${s(t.id).slice(0, 8)}] ${s(t.title)}${extra.length ? ` (${extra.join(", ")})` : ""}`;
}

/** The best matching published skill for `query`, by slug and word overlap. */
export function bestSkill(skills: Json[], query: string): Json | undefined {
  const q = query.toLowerCase();
  const words = q.replaceAll("-", " ").split(/\s+/).filter((w) => w.length > 1);
  const terms = words.length ? words : [q];
  const score = (sk: Json) => {
    const hay = `${s(sk.slug)} ${s(sk.title)} ${s(sk.description)} ${s(sk.project)}`.toLowerCase();
    return (s(sk.slug) === q ? 10 : 0) + terms.filter((w) => hay.includes(w)).length;
  };
  let best: Json | undefined;
  let bestScore = 0;
  for (const sk of skills) {
    const sc = score(sk);
    if (sc > bestScore) {
      best = sk;
      bestScore = sc;
    }
  }
  return best;
}

export async function dailySummary(remote: RemoteClient, date?: string): Promise<string> {
  const target = date || localToday();
  const data = await remote.getDaily(target);
  const total = Number(data.total_messages ?? 0);
  if (!total) return `No activity recorded on ${target}.`;
  const overview = obj(data.overview);
  const toolStats = obj(overview.tool_stats) as Record<string, number>;
  const conversations = arr(overview.conversations);
  const summaries = arr(data.summaries);
  const parts = [`# Activity Summary — ${target}`, `\n**Total messages**: ${total}\n`, "## Tools"];
  for (const [tool, count] of Object.entries(toolStats).sort((a, b) => b[1] - a[1])) parts.push(`- **${tool}**: ${count} messages`);
  if (conversations.length) {
    parts.push("\n## Top Conversations");
    for (const c of conversations.slice(0, 10)) {
      parts.push(`- [${s(c.tool_id)}] **${s(c.title) || s(c.id).slice(0, 8)}** (${Number(c.user_messages ?? 0)}↑ ${Number(c.assistant_messages ?? 0)}↓)`);
    }
  }
  if (summaries.length) for (const sm of summaries) parts.push(`\n## ${s(sm.title) || "AI Summary"}\n${s(sm.summary)}`);
  else parts.push(`\n*No AI summary yet. Generate one at ${remote.baseUrl}/daily/${target}*`);
  return parts.join("\n");
}

export async function projectContext(remote: RemoteClient, projectName: string): Promise<string> {
  const match = await findProject(remote, projectName);
  if (!match) return `No project found matching '${projectName}'.`;
  const project = await remote.get<Json>(`/api/projects/${s(match.id)}`, { include_content: "true" });
  const parts = [`# Project: ${s(project.title) || projectName}`, `**Tool**: ${s(project.tool_id)}`];
  if (project.source_path) parts.push(`**Path**: \`${s(project.source_path)}\``);
  const docs = arr(project.documents).filter((d) => !isNoise(d.relative_path));
  const inlined = docs.filter((d) => d.content);
  const listed = docs.filter((d) => !d.content);
  if (inlined.length) {
    parts.push(`\n## Curated documents (${inlined.length})`);
    for (const d of inlined) {
      parts.push(`\n### [${s(d.category)}] ${s(d.title) || s(d.relative_path)}`, `*${s(d.relative_path)}*`);
      if (d.ai_summary) parts.push(`\n**AI summary**: ${s(d.ai_summary)}`);
      parts.push("", s(d.content));
    }
  }
  if (listed.length) {
    parts.push(`\n## Other documents (${listed.length})`);
    for (const d of listed.slice(0, 20)) parts.push(`- [${s(d.category)}] ${s(d.title) || s(d.relative_path)} — \`${s(d.id)}\``);
  }
  return parts.join("\n");
}

async function coreMemory(remote: RemoteClient, category?: string): Promise<string> {
  // Pitfalls are most of it and memory_check_rule picks the ones that fit the work at hand
  if (!category) return s((await remote.get<Json>("/api/memory/core/markdown", { exclude: "pitfall" })).markdown);
  const memories = (await remote.get<Json[]>("/api/memory/core", { active_only: "true", recall: "true", category })).filter((m) => !m.is_folder);
  if (!memories.length) return `No core memories found for category '${category}'.`;
  return [`# Core Memories (${category})`, ...memories.map((m) => `- **[${s(m.key)}]** (${s(m.confidence ?? 1)}): ${s(m.content)}`)].join("\n");
}

/** The Memento MCP server: tools and resources over the remote API. */
export function createServer(remote: RemoteClient, version = "0.1.0"): McpServer {
  const server = new McpServer({ name: "Memento", version }, { instructions: INSTRUCTIONS });

  // ---- find ----------------------------------------------------------------

  server.registerTool(
    "memory_search",
    {
      description:
        "Search your personal AI memory using semantic + full-text hybrid search. Use this to find past conversations, decisions, solutions, and knowledge from all your AI tools (Claude Code, Cursor, Codex, Windsurf, etc.).",
      inputSchema: {
        query: z.string().describe("Natural language search query"),
        limit: z.number().int().optional().describe("Max results to return (default 5)"),
        tool_filter: z.string().optional().describe("Optional tool filter (claude_code, codex, cursor, antigravity, workbuddy, openclaw, obsidian)"),
        days: z.number().int().optional().describe("Optional time filter — only search last N days"),
      },
    },
    async ({ query, limit, tool_filter, days }) => {
      try {
        const results = await remote.search(query, limit ?? 5, tool_filter, days);
        if (!results.length) return text("No matching memories found.");
        return text(
          results
            .map(
              (r, i) =>
                `## Result ${i + 1}: ${s(r.title) || s(r.relative_path) || "Untitled"} (${s(r.tool_id)})\n` +
                `**Source**: ${s(r.relative_path)}\n**Date**: ${day(r.synced_at)}\n` +
                (r.id ? `**Doc id**: \`${s(r.id)}\`\n` : "") +
                `\n${s(r.snippet)}\n`,
            )
            .join("\n---\n\n"),
        );
      } catch (e) {
        return failed("Search failed", e);
      }
    },
  );

  server.registerTool(
    "memory_recall",
    {
      description: "Recall recent memories by category, project, and optional date.",
      inputSchema: {
        category: z.string().optional().describe("Memory category (conversation, memory, identity, plan, config, learning, skill, note); default conversation"),
        project: z.string().optional().describe("Optional project name filter"),
        days: z.number().int().optional().describe("How far back to look (default 7 days, ignored if date given)"),
        limit: z.number().int().optional().describe("Max items to return (default 10)"),
        date: z.string().optional().describe("Optional specific date (YYYY-MM-DD), overrides days"),
      },
    },
    async ({ category = "conversation", project, days = 7, limit = 10, date }) => {
      if (date) {
        try {
          const data = await remote.getDaily(date);
          const conversations = arr(obj(data.overview).conversations);
          if (!conversations.length) return text(`No conversations on ${date}.`);
          return text(
            [
              `# Conversations on ${date}\n`,
              ...conversations
                .slice(0, limit)
                .map((c) => `- [${s(c.tool_id)}] **${s(c.title) || s(c.id).slice(0, 8)}** (${Number(c.user_messages ?? 0)}↑ ${Number(c.assistant_messages ?? 0)}↓)`),
            ].join("\n"),
          );
        } catch (e) {
          return failed(`Could not load conversations for ${date}`, e);
        }
      }
      let tools: Json[];
      try {
        tools = await remote.get<Json[]>("/api/tools");
      } catch (e) {
        return failed("Failed to list tools", e);
      }
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const files: Json[] = [];
      await Promise.all(
        tools.map(async (tool) => {
          try {
            for (const f of await remote.get<Json[]>(`/api/tools/${s(tool.id)}/files`, { category })) files.push({ ...f, _tool_id: s(tool.id) });
          } catch {
            // skip a tool that fails
          }
        }),
      );
      let filtered = files.filter((f) => s(f.synced_at) >= cutoff && !isNoise(f.relative_path));
      if (project) filtered = filtered.filter((f) => s(f.relative_path).toLowerCase().includes(project.toLowerCase()));
      filtered.sort((a, b) => s(b.synced_at).localeCompare(s(a.synced_at)));
      if (!filtered.length) return text(`No ${category} memories in last ${days} days.`);
      return text(
        [
          `# Recent ${category} (last ${days} days)\n`,
          ...filtered.slice(0, limit).map((f) => `- [${s(f._tool_id)}] **${s(f.title) || s(f.relative_path)}** — ${day(f.synced_at)}${f.id ? ` — \`${s(f.id)}\`` : ""}`),
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "memory_context",
    {
      description:
        "Get project context — meta + the FULL CONTENT of curated docs (identity / memory / plan / learning / note), plus a list of recent conversations. Conversation bodies are not inlined — use memory_conversation(doc_id) to drill into one, or memory_blueprint(project_name) for everything including knowledge-graph context.",
      inputSchema: { project_name: z.string().describe("Project name to look up (fuzzy match)") },
    },
    async ({ project_name }) => {
      try {
        return text(await projectContext(remote, project_name));
      } catch (e) {
        return failed("Project lookup failed", e);
      }
    },
  );

  server.registerTool(
    "memory_blueprint",
    {
      description:
        "One-shot project blueprint — project meta + FULL content of identity / memory / plan / learning files + recent conversations' AI summaries + related knowledge-graph entities with observations and relations. Use at the START of a new session for maximum context with one call.",
      inputSchema: {
        project_name: z.string().describe("Project name (fuzzy match)"),
        recent_conversations: z.number().int().optional().describe("How many recent conversation summaries to include (default 10; 0 to omit)"),
      },
    },
    async ({ project_name, recent_conversations = 10 }) => {
      let match: Json | undefined;
      try {
        match = await findProject(remote, project_name);
      } catch (e) {
        return failed("Failed to list projects", e);
      }
      if (!match) return text(`No project found matching '${project_name}'.`);
      let bp: Json;
      try {
        bp = await remote.get<Json>(`/api/projects/${s(match.id)}/blueprint`, { recent_convs: recent_conversations });
      } catch (e) {
        return failed("Blueprint fetch failed", e);
      }
      const proj = obj(bp.project);
      const counts = obj(bp.counts);
      const out = [
        `# Blueprint — ${s(proj.title) || project_name}`,
        `**Tool**: \`${s(proj.tool_id)}\`  ·  **Path**: \`${s(proj.source_path) || "?"}\``,
        `_curated=${s(counts.curated_docs ?? 0)} · recent_convs=${s(counts.recent_conversations ?? 0)} · entities=${s(counts.entities ?? 0)} · observations=${s(counts.total_observations ?? 0)}_`,
        "",
      ];
      const curated = arr(bp.curated_docs);
      if (curated.length) {
        out.push("## Curated documents");
        for (const d of curated) {
          out.push(`\n### [${s(d.category)}] ${s(d.title) || s(d.relative_path)}`, `*${s(d.relative_path)}*  ·  *${day(d.synced_at)}*`);
          if (d.ai_summary) out.push(`\n**AI summary**: ${s(d.ai_summary)}`);
          out.push("", s(d.content) || "*(empty)*");
        }
        out.push("");
      }
      const entities = arr(obj(bp.knowledge_graph).entities);
      if (entities.length) {
        out.push("## Knowledge graph");
        for (const e of entities) {
          out.push(`\n### ${s(e.name)} (${s(e.entity_type)})`);
          if (e.summary) out.push(s(e.summary));
          const rels = arr(e.relations);
          if (rels.length) out.push("\n**Relations:**", ...rels.map((r) => `- ${s(r.relation)} → **${s(r.target_name)}** (${s(r.target_type)})`));
          const obs = arr(e.observations);
          if (obs.length) out.push("\n**Observations:**", ...obs.map((o) => `- ${o.observed_at ? `[${day(o.observed_at)}] ` : ""}${s(o.content)}`));
        }
        out.push("");
      }
      const convs = arr(bp.recent_conversations);
      if (convs.length) {
        out.push("## Recent conversations");
        for (const c of convs) {
          out.push(`\n### ${s(c.title) || "Untitled"} (${day(c.synced_at)}, ${s(c.tool_id)})`, `_doc id: \`${s(c.id)}\`  ·  call \`memory_conversation(doc_id)\` for full text_`);
          if (c.ai_summary) out.push("", s(c.ai_summary));
        }
      }
      return text(out.join("\n"));
    },
  );

  // ---- write ---------------------------------------------------------------

  server.registerTool(
    "memory_store",
    {
      description: "Store a new observation or fact in your personal memory. Use this to save important decisions, learnings, or context for later recall.",
      inputSchema: {
        content: z.string().describe("The fact or observation to remember"),
        entity_name: z.string().optional().describe("Optional entity this relates to (e.g. project name, technology)"),
        entity_type: z.string().optional().describe("Entity type (project/tool/concept/person/technology); default concept"),
      },
    },
    async ({ content, entity_name, entity_type = "concept" }) => {
      try {
        const res = await remote.post<Json>("/api/memory/observations", { content, entity_name: entity_name ?? null, entity_type });
        return text(`Stored observation on entity **${s(res.entity_name) || entity_name || "Note"}** (${s(res.entity_id).slice(0, 8)}…)`);
      } catch (e) {
        return failed("Store failed", e);
      }
    },
  );

  // ---- overview & drill-in ---------------------------------------------------

  server.registerTool(
    "daily_summary",
    {
      description: "Get daily activity summary for a specific date.",
      inputSchema: { date_str: z.string().optional().describe("Date in YYYY-MM-DD format (default: today)") },
    },
    async ({ date_str }) => {
      try {
        return text(await dailySummary(remote, date_str));
      } catch (e) {
        return failed(`Could not load daily summary for ${date_str || localToday()}`, e);
      }
    },
  );

  server.registerTool(
    "memory_open",
    {
      description:
        "Fetch the full content of a document by its ID. Pair this with memory_search / memory_recall — those return short snippets, this returns the whole file.",
      inputSchema: { doc_id: z.string().describe("Document UUID (from a search result)") },
    },
    async ({ doc_id }) => {
      try {
        const doc = await remote.get<Json>(`/api/documents/${doc_id}`);
        let header =
          `# ${s(doc.title) || s(doc.relative_path) || "Untitled"}\n` +
          `**Tool**: ${s(doc.tool_id)}  ·  **Category**: ${s(doc.category)}  ·  **Synced**: ${day(doc.synced_at)}\n` +
          `**Path**: \`${s(doc.relative_path)}\`\n`;
        if (doc.ai_summary) header += `\n**AI summary**: ${s(doc.ai_summary)}\n`;
        return text(`${header}\n---\n${s(doc.content) || "(empty)"}`);
      } catch (e) {
        return failed("Failed to fetch document", e);
      }
    },
  );

  server.registerTool(
    "memory_conversation",
    {
      description:
        "Read the message-by-message contents of a conversation document, to quote, summarize, or pick up where a past discussion left off.",
      inputSchema: {
        doc_id: z.string().describe("Conversation document UUID"),
        limit: z.number().int().optional().describe("Max messages to return (default 50, server caps at 200)"),
        offset: z.number().int().optional().describe("Pagination offset (default 0)"),
      },
    },
    async ({ doc_id, limit = 50, offset = 0 }) => {
      try {
        const data = await remote.get<Json>(`/api/conversations/${doc_id}/messages`, { limit, offset });
        const msgs = arr(data.messages);
        const total = Number(data.total ?? msgs.length);
        if (!msgs.length) return text(`No messages in document ${doc_id}.`);
        const parts = [`# Conversation ${doc_id}\n*Messages ${offset + 1}-${offset + msgs.length} of ${total}*\n`];
        for (const m of msgs) {
          const ts = s(m.timestamp).slice(0, 19).replace("T", " ");
          let head = `## ${s(m.role) || "?"}${ts ? ` (${ts})` : ""}`;
          if (m.tool_name) head += ` — tool: \`${s(m.tool_name)}\``;
          parts.push(head);
          if (m.thinking) parts.push(`> _thinking_: ${s(m.thinking)}`);
          parts.push(s(m.content) || "(no text)");
        }
        return text(parts.join("\n\n"));
      } catch (e) {
        return failed("Failed to fetch conversation", e);
      }
    },
  );

  server.registerTool(
    "memory_graph",
    {
      description:
        "Explore the knowledge graph around an entity by name: its summary, recent observations, and incoming/outgoing relations. Use after memory_search for structured \"what do I know about X\".",
      inputSchema: {
        entity_name: z.string().describe("Entity name to look up (fuzzy match)"),
        limit: z.number().int().optional().describe("Max candidate entities when the name is ambiguous (default 5)"),
      },
    },
    async ({ entity_name, limit = 5 }) => {
      let hits: Json[];
      try {
        hits = await remote.get<Json[]>("/api/memory/search", { q: entity_name, limit });
      } catch (e) {
        return failed("Graph search failed", e);
      }
      const entities = hits.filter((h) => h.type === "entity");
      if (!entities.length) {
        const obs = hits.filter((h) => h.type === "observation");
        if (!obs.length) return text(`No entity matching '${entity_name}'.`);
        return text([`# Observations mentioning '${entity_name}'\n`, ...obs.slice(0, limit).map((o) => `- **${s(o.name)}**: ${s(o.content)}`)].join("\n"));
      }
      const primary = entities[0]!;
      let detail: Json;
      try {
        detail = await remote.get<Json>(`/api/memory/entities/${s(primary.id)}`);
      } catch (e) {
        return failed(`Found entity '${s(primary.name)}' but detail fetch failed`, e);
      }
      const parts = [`# ${s(detail.name) || s(primary.name)} (${s(detail.type) || s(detail.entity_type)})`];
      if (detail.summary) parts.push(`\n${s(detail.summary)}`);
      const outgoing = arr(detail.outgoing_relations ?? detail.outgoing);
      const incoming = arr(detail.incoming_relations ?? detail.incoming);
      if (outgoing.length) parts.push("\n## Relations (outgoing)", ...outgoing.slice(0, 20).map((r) => `- ${s(r.relation)} → **${s(r.target_name)}** (${s(r.target_type)})`));
      if (incoming.length)
        parts.push("\n## Relations (incoming)", ...incoming.slice(0, 20).map((r) => `- **${s(r.source_name)}** (${s(r.source_type)}) → ${s(r.relation)} → here`));
      const observations = arr(detail.observations);
      if (observations.length) parts.push("\n## Observations", ...observations.slice(0, 20).map((o) => `- ${o.observed_at ? `[${day(o.observed_at)}] ` : ""}${s(o.content)}`));
      if (entities.length > 1) parts.push("\n## Other candidates", ...entities.slice(1, limit).map((e) => `- ${s(e.name)} (${s(e.entity_type)})`));
      return text(parts.join("\n"));
    },
  );

  server.registerTool(
    "memory_core",
    {
      description:
        "Get the user's permanent core memory (MEMORY.md) consolidated by dreaming: distilled engineering rules, architecture decisions, project knowledge, and personal preferences. " +
        "Past pitfalls are left out (memory_check_rule returns the ones relevant to a task; category 'pitfall' lists them all).",
      inputSchema: { category: z.string().optional().describe("Optional filter ('rule', 'architecture', 'preference', 'project', 'general', 'pitfall')") },
    },
    async ({ category }) => {
      try {
        return text(await coreMemory(remote, category));
      } catch (e) {
        return failed("Core memory fetch failed", e);
      }
    },
  );

  server.registerTool(
    "memory_project_map",
    {
      description:
        "Get a global map of all projects tracked in Memento: title, primary tool and document counts. Use for a high-level overview of the user's workspace before drilling into a project.",
      inputSchema: {},
    },
    async () => {
      try {
        const projects = await remote.get<Json[]>("/api/projects");
        if (!projects.length) return text("No projects currently tracked in Memento.");
        return text(
          [
            `# Memento Workspace Project Map (${projects.length} projects)\n`,
            ...projects.map((p) => {
              const summary = s(p.summary);
              return `- **${s(p.title) || s(p.slug)}**${p.slug ? ` (\`${s(p.slug)}\`)` : ""} [${s(p.tool_id) || "universal"}] - ${s(p.document_count ?? p.doc_count ?? 0)} docs${summary ? `: ${summary}` : ""}`;
            }),
          ].join("\n"),
        );
      } catch (e) {
        return failed("Project map failed", e);
      }
    },
  );

  // ---- learning loop ---------------------------------------------------------

  server.registerTool(
    "mind_resonance",
    {
      description:
        "心领神会 (Mind Resonance): Achieve instant mental alignment and heart-to-heart understanding with the user before acting or answering. " +
        "Pre-activates the user's implicit mental model, scenario-specific iron rules, active knowledge graph entities/decisions, and past pitfall defenses. " +
        "Call this when the user gives concise requests or before embarking on complex engineering, chemistry, data, or release tasks.",
      inputSchema: {
        query: z.string().optional().describe("User instruction, prompt, or task summary"),
        project: z.string().optional().describe("Project name or workspace context"),
        action: z.string().optional().describe("Planned action type (e.g. 'coding', 'release', 'deploy', 'ui', 'chemistry')"),
      },
    },
    async ({ query, project, action }) => {
      try {
        const data = await remote.get<Json>("/api/memory/resonance", {
          action,
          format: "markdown",
          project,
          query,
        });
        return text(s(data.markdown));
      } catch (e) {
        return failed("Mind resonance failed", e);
      }
    },
  );

  server.registerTool(
    "memory_check_rule",
    {
      description:
        "Pre-flight check against the user's rules, past pitfalls, and learned skills. Call this BEFORE critical operations (release, deploy, build, db migration, deleting or changing data, git push, config change, restarting services).",
      inputSchema: {
        action_type: z.string().describe("What you are about to do (e.g. 'release', 'deploy', 'db_migration', '删除数据')"),
        project_name: z.string().optional().describe("Target project name, to include that project's pitfalls"),
        details: z.string().optional().describe("Optional specifics (commands, services, error text) to match more pitfalls"),
      },
    },
    async ({ action_type, project_name, details }) => {
      try {
        const data = await remote.get<Json>("/api/learning/check", { action: action_type, format: "markdown", project: project_name, query: details });
        return text(s(data.markdown));
      } catch (e) {
        return failed("Rule check failed", e);
      }
    },
  );

  server.registerTool(
    "memory_pitfall",
    {
      description:
        "Record a pitfall after you hit a failure, found its cause, and fixed it. Memento warns about it next time similar work comes up. Only for problems in the user's project / machines / services — not your own tool-usage mistakes, and not failures whose cause you didn't find.",
      inputSchema: {
        title: z.string().describe("One line summary"),
        symptom: z.string().describe("The error or behaviour you saw (keep the key error text)"),
        fix: z.string().describe("What fixed it"),
        cause: z.string().optional().describe("The root cause"),
        project: z.string().optional().describe("Project name"),
      },
    },
    async (args) => {
      try {
        const body = Object.fromEntries(Object.entries(args).filter(([, v]) => v));
        const res = await remote.post<Json>("/api/learning/pitfalls", body);
        return text(res.saved ? "Saved." : `Not saved: ${s(res.note)}`);
      } catch (e) {
        return failed("Save failed", e);
      }
    },
  );

  server.registerTool(
    "memory_skill",
    {
      description:
        "Skills the user approved: procedures that worked in their own environment. With a query (e.g. 'deploy memento'), returns the best matching skill's full steps; without one, lists all skills. Prefer following a skill over working it out again.",
      inputSchema: { query: z.string().optional().describe("What you want to do, or a skill name") },
    },
    async ({ query }) => {
      try {
        const skills = arr((await remote.get<Json>("/api/skills")).published);
        if (!skills.length) return text("No published skills yet.");
        if (!query) return text(skills.map((sk) => `- \`${s(sk.slug)}\` ${s(sk.title)}: ${s(sk.description)}`).join("\n"));
        const best = bestSkill(skills, query);
        if (!best) return text(`No matching skill. Available:\n${skills.map((sk) => `- \`${s(sk.slug)}\` ${s(sk.title)}`).join("\n")}`);
        return text(s(best.skill_md) || s(best.body));
      } catch (e) {
        return failed("Skill lookup failed", e);
      }
    },
  );

  server.registerTool(
    "todo_list",
    {
      description: "The user's open todos (things they said they'd do later), soonest due first.",
      inputSchema: { project: z.string().optional().describe("Only this project's todos") },
    },
    async ({ project }) => {
      try {
        const items = arr((await remote.get<Json>("/api/todos", { project })).open);
        if (!items.length) return text("No open todos.");
        return text(`# Open todos (${items.length})\n${items.map(todoLine).join("\n")}`);
      } catch (e) {
        return failed("Todo list failed", e);
      }
    },
  );

  server.registerTool(
    "todo_add",
    {
      description:
        "Record something the user wants done later (\"do this tomorrow\", \"note this down\"). Not for work you are about to do right now. The user gets a push when it falls due.",
      inputSchema: {
        title: z.string().describe("What to do, as a short verb phrase"),
        detail: z.string().optional().describe("Extra context"),
        due: z.string().optional().describe("Due date YYYY-MM-DD"),
        project: z.string().optional().describe("Project name"),
      },
    },
    async ({ title, detail, due, project }) => {
      try {
        const res = await remote.post<Json>("/api/todos", { title, detail: detail ?? null, due: due ?? null, project: project ?? null, source: "mcp" });
        return text(`${res.created ? "Added: " : "Already on the list: "}${todoLine(obj(res.todo))}`);
      } catch (e) {
        return failed("Todo add failed", e);
      }
    },
  );

  server.registerTool(
    "todo_update",
    {
      description: "Close or edit a todo. status: done | dropped | open. todo_id: the id (or its first 8 chars) from todo_list.",
      inputSchema: {
        todo_id: z.string().describe("Todo id or its 8-char prefix"),
        status: z.enum(["done", "dropped", "open"]).optional().describe("done, dropped, or open"),
        title: z.string().optional().describe("New title"),
        due: z.string().optional().describe("New due date YYYY-MM-DD ('' clears it)"),
      },
    },
    async ({ todo_id, status, title, due }) => {
      try {
        let id = todo_id;
        if (todo_id.length < 32) {
          const data = await remote.get<Json>("/api/todos");
          const matches = [...arr(data.open), ...arr(data.closed)].filter((t) => s(t.id).startsWith(todo_id));
          if (matches.length !== 1) return text(`No single todo matches '${todo_id}'.`);
          id = s(matches[0]!.id);
        }
        const fields = Object.fromEntries(Object.entries({ status, title, due }).filter(([, v]) => v !== undefined));
        const res = await remote.put<Json>(`/api/todos/${id}`, fields);
        const todo = obj(res.todo);
        return text(`Updated: ${todoLine(todo)} [${s(todo.status)}]`);
      } catch (e) {
        return failed("Todo update failed", e);
      }
    },
  );

  // ---- resources -----------------------------------------------------------

  const resourceText = (uri: URL, body: string) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: body }] });

  server.registerResource("projects", "memory://projects", { description: "All projects with document counts", mimeType: "text/markdown" }, async (uri) => {
    const projects = await remote.get<Json[]>("/api/projects");
    const lines = projects.length
      ? ["# Projects\n", ...projects.slice(0, 50).map((p) => `- **${s(p.title)}** (${s(p.tool_id)}) — ${s(p.document_count ?? 0)} files`)]
      : ["No projects found."];
    return resourceText(uri, lines.join("\n"));
  });

  server.registerResource(
    "project",
    new ResourceTemplate("memory://projects/{name}", { list: undefined }),
    { description: "One project's context", mimeType: "text/markdown" },
    async (uri, { name }) => resourceText(uri, await projectContext(remote, decodeURIComponent(String(name)))),
  );

  server.registerResource(
    "identity",
    new ResourceTemplate("memory://identity/{tool}", { list: undefined }),
    { description: "A tool's identity files (AGENTS.md, SOUL.md, ...)", mimeType: "text/markdown" },
    async (uri, { tool }) => {
      const files = await remote.get<Json[]>(`/api/tools/${String(tool)}/files`, { category: "identity" });
      if (!files.length) return resourceText(uri, `No identity files found for ${String(tool)}.`);
      const parts: string[] = [];
      for (const f of files) {
        const doc = await remote.get<Json>(`/api/documents/${s(f.id)}`);
        parts.push(`## ${s(doc.title)}\n\n${s(doc.content) || "(empty)"}`);
      }
      return resourceText(uri, parts.join("\n\n---\n\n"));
    },
  );

  server.registerResource(
    "daily",
    new ResourceTemplate("memory://daily/{date}", { list: undefined }),
    { description: "The daily report for a date (YYYY-MM-DD)", mimeType: "text/markdown" },
    async (uri, { date }) => resourceText(uri, await dailySummary(remote, String(date))),
  );

  server.registerResource("core", "memory://core", { description: "The user's consolidated MEMORY.md", mimeType: "text/markdown" }, async (uri) =>
    resourceText(uri, await coreMemory(remote)),
  );

  server.registerResource(
    "resonance",
    "memory://resonance",
    { description: "Current mind resonance context (user intent, scenario iron rules, active graph entities, defensive pitfalls)", mimeType: "text/markdown" },
    async (uri) => {
      const data = await remote.get<Json>("/api/memory/resonance", { format: "markdown" });
      return resourceText(uri, s(data.markdown));
    },
  );

  return server;
}
