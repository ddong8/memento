import { authFetch, getApiBase } from "@/lib/api-client";

/**
 * Project conversations and the timeline load each session's latest (or, oldest-first, earliest)
 * PREVIEW_MESSAGES messages; the rest come with 「展开全部」. One long session alone used to be
 * 840 KB of the 880 KB first page, so the page waited seconds on a phone. Nothing is dropped:
 * message_count stays the true total and the button fetches every message of that session.
 */
export const PREVIEW_MESSAGES = 40;

export function sessionsUrl(projectId: string, offset: number, order: "asc" | "desc"): string {
  return (
    `${getApiBase()}/api/projects/${projectId}/conversations` +
    `?session_offset=${offset}&session_limit=5&order=${order}&max_messages_per_session=${PREVIEW_MESSAGES}`
  );
}

/** Every message of one session, oldest first. */
export async function fetchWholeSession<M>(projectId: string, conversationId: string): Promise<M[]> {
  const res = await authFetch(
    `${getApiBase()}/api/projects/${projectId}/conversations` +
      `?conversation_id=${encodeURIComponent(conversationId)}&session_limit=1&order=asc&artifacts=false`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { sessions?: { messages?: M[] }[] };
  return data.sessions?.[0]?.messages ?? [];
}

/** Label for the button standing in for the messages not loaded yet. */
export function hiddenLabel(hidden: number, order: "asc" | "desc", locale: string): string {
  if (locale === "zh-CN") return order === "desc" ? `展开前面 ${hidden} 条` : `展开其余 ${hidden} 条`;
  return order === "desc" ? `Show ${hidden} earlier` : `Show ${hidden} more`;
}
