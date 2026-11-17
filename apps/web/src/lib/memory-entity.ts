// Looks up a knowledge-graph entity for the memory page's "jump to entity" clicks.
//
// GET /api/memory/entities/{id} only takes a UUID (anything else is a 422) and answers a missing
// entity with 200 {"error": "not found"}. The page used to render whatever came back, so clicking
// a core-memory rule (its key, e.g. "correction_042b76c0", is not an entity) crashed the page.

export interface EntityDetail {
  id: string;
  name: string;
  type: string;
  summary: string | null;
  stale_at?: string | null;
  stale_reason?: string | null;
  aliases?: { name: string; type: string; summary?: string; merged_at?: string; replaced_at?: string }[];
  observations: { content: string; observed_at: string | null }[];
  outgoing_relations: { target_name: string; target_type: string; relation: string; target_id?: string }[];
  incoming_relations: { source_name: string; source_type: string; relation: string; source_id?: string }[];
}

/** GET a path under the API base, e.g. `(p) => authFetch(getApiBase() + p)`. */
export type MemoryGet = (path: string) => Promise<Response>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isEntityDetail(v: unknown): v is EntityDetail {
  const d = v as EntityDetail | null;
  return (
    !!d &&
    typeof d.id === "string" &&
    Array.isArray(d.observations) &&
    Array.isArray(d.outgoing_relations) &&
    Array.isArray(d.incoming_relations)
  );
}

/** The entity's detail by id, or null when it is missing or the request fails. */
export async function fetchEntityDetail(id: string, get: MemoryGet): Promise<EntityDetail | null> {
  try {
    const resp = await get(`/api/memory/entities/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    const detail: unknown = await resp.json();
    return isEntityDetail(detail) ? detail : null;
  } catch {
    return null;
  }
}

/** The entity's detail by id or exact name (case-insensitive), or null when there is no such entity. */
export async function findEntityDetail(idOrName: string, get: MemoryGet): Promise<EntityDetail | null> {
  const key = idOrName.trim();
  if (!key) return null;
  if (UUID_RE.test(key)) return fetchEntityDetail(key, get);
  // The search puts entities named exactly `key` first.
  try {
    const resp = await get(`/api/memory/search?q=${encodeURIComponent(key)}&limit=5`);
    if (!resp.ok) return null;
    const hits: unknown = await resp.json();
    if (!Array.isArray(hits)) return null;
    const hit = hits.find(
      (h) => h?.type === "entity" && typeof h.id === "string" && String(h.name ?? "").toLowerCase() === key.toLowerCase()
    );
    return hit ? fetchEntityDetail(hit.id, get) : null;
  } catch {
    return null;
  }
}

/** A scenario memory (category resonance_scenario), stored as JSON for mind resonance. */
export interface ScenarioMemory {
  name: string;
  mindset: string;
  keywords: string[];
  project: string | null;
}

/**
 * The scenario inside a memory's content, or null for an ordinary memory. The rule tree printed
 * the JSON as is ({"id": ..., "name": ..., "keywords": [...]}); it reads as name, mindset, keywords.
 */
export function parseScenario(content: string | null | undefined): ScenarioMemory | null {
  const text = (content || "").trim();
  if (!text.startsWith("{")) return null;
  try {
    const d = JSON.parse(text) as Record<string, unknown>;
    const name = typeof d.name === "string" ? d.name : typeof d.id === "string" ? d.id : "";
    const mindset = typeof d.mindset === "string" ? d.mindset : "";
    if (!name && !mindset) return null;
    const keywords = Array.isArray(d.keywords) ? d.keywords.filter((k): k is string => typeof k === "string" && !!k) : [];
    const project = typeof d.target_project === "string" && d.target_project ? d.target_project : null;
    return { name, mindset, keywords, project };
  } catch {
    return null;
  }
}
