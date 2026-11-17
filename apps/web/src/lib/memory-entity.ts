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
