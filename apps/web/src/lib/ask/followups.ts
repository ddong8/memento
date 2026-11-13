import type { Turn } from "./turns";

/**
 * A message the user sent while a reply was still running. "sent": the running agent took it and reads it
 * at its next step; "queued": nothing running could take it (no agent task yet, an agent that doesn't read
 * input mid-run, or it came too late), so it goes out as the next message once this reply ends.
 */
export interface FollowUp {
  id: string;
  text: string;
  /** When it was typed (ms): queued ones go out in this order. */
  at: number;
  /** Pasted with it: never steered (the agents take text mid-run), so it waits for the next message. */
  images?: string[];
  status: "sending" | "sent" | "queued";
  /**
   * The server keeps it (POST …/followups, or the device reported it late / unsupported): it comes back
   * from there when the reply ends, so a page closed or put in the background meanwhile doesn't lose it.
   */
  held?: boolean;
}

/** A follow-up the server kept for the conversation's next message. */
export interface HeldFollowUp {
  text: string;
  /** Seconds since the epoch, as the server stores it. */
  at?: number;
}

const TERMINAL = new Set(["succeeded", "failed", "timeout", "cancelled"]);

/**
 * The device task of the running reply that can take a follow-up: an agent (not a shell command) still
 * running in the last assistant turn. The latest one when the reply started several.
 */
export function steerableTaskId(turns: readonly Turn[]): string | null {
  const last = turns[turns.length - 1];
  if (last?.role !== "assistant") return null;
  const calls = last.toolCalls ?? [];
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    const r = c.result;
    if (!r?.task_id || (r.status && TERMINAL.has(r.status))) continue;
    const action = r.action || (c.args?.action as string | undefined);
    const binary = String((c.args?.binary as string | undefined) || "");
    if (action === "agent" || (action !== "shell" && binary)) return r.task_id;
  }
  return null;
}

/**
 * The next message once the reply ended: what this page still holds itself (queued, not kept by the
 * server) and what the server kept, in the order typed, one block each; the same text only once.
 */
export function nextMessage(local: readonly FollowUp[], held: readonly HeldFollowUp[]): { text: string; images: string[] } {
  const own = local.filter((f) => f.status === "queued" && !f.held);
  const items = [
    ...own.map((f) => ({ text: f.text.trim(), at: f.at })),
    ...held.map((h) => ({ text: String(h.text ?? "").trim(), at: (h.at ?? 0) * 1000 })),
  ].sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const { text } of items) {
    if (!text || seen.has(text)) continue;
    seen.add(text);
    texts.push(text);
  }
  return { text: texts.join("\n\n"), images: own.flatMap((f) => f.images ?? []) };
}

/**
 * After the agent reported a follow-up as late or unsupported: the earliest one already sent with that
 * text is queued again. The server kept it when the device reported it, so it's marked held.
 */
export function requeue(items: readonly FollowUp[], text: string): FollowUp[] {
  const i = items.findIndex((f) => f.status !== "queued" && f.text.trim() === text.trim());
  if (i < 0) return items as FollowUp[];
  return items.map((f, k) => (k === i ? { ...f, status: "queued", held: true } : f));
}
