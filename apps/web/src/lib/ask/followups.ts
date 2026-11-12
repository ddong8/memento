import type { Turn } from "./turns";

/**
 * A message the user sent while a reply was still running. "sent": the running agent took it and reads it
 * at its next step; "queued": nothing running could take it (no agent task yet, an agent that doesn't read
 * input mid-run, or it came too late), so it goes out as the next message once this reply ends.
 */
export interface FollowUp {
  id: string;
  text: string;
  /** Pasted with it: never steered (the agents take text mid-run), so it waits for the next message. */
  images?: string[];
  status: "sending" | "sent" | "queued";
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

/** The queued follow-ups as one message, in the order they were typed. */
export function queuedMessage(items: readonly FollowUp[]): string {
  return items
    .filter((f) => f.status === "queued")
    .map((f) => f.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * After the agent reported a follow-up as late or unsupported: the earliest one already sent with that
 * text goes back into the queue, so it still reaches the agent as the next message.
 */
export function requeue(items: readonly FollowUp[], text: string): FollowUp[] {
  const i = items.findIndex((f) => f.status !== "queued" && f.text.trim() === text.trim());
  if (i < 0) return items as FollowUp[];
  return items.map((f, k) => (k === i ? { ...f, status: "queued" } : f));
}
