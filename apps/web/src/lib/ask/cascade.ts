/**
 * The device → project → session cascade above the input box. All of it comes from one conversation at
 * a time: a field that conversation doesn't set is empty, never left over from the one shown before.
 */
import type { DeviceSummary } from "@/lib/api-client";
import type { CachedConversationConfig } from "./cache";
import { isConcreteDevice } from "./devices";
import type { ExecutionMode } from "./turns";

/** The tool whose projects and sessions an execution mode works with (agent modes only). */
export const AGENT_TOOL_ID: Partial<Record<ExecutionMode, string>> = {
  codex: "codex",
  claude: "claude_code",
  antigravity: "antigravity",
  workbuddy: "workbuddy",
};

export interface Cascade {
  device: string;
  cwd: string;
  projectId: string;
  projectTitle: string;
  sessionId: string;
}

/** A cached conversation's whole cascade, empty fields included. */
export function cascadeOf(config: CachedConversationConfig | undefined): Cascade {
  const c = config || {};
  return {
    device: c.selectedDevice || "auto",
    cwd: c.cwd || "",
    projectId: c.selectedProjectId || "",
    projectTitle: c.selectedProjectTitle || "",
    sessionId: c.selectedSessionId || "",
  };
}

/**
 * The device to show and query lists with. One that isn't registered any more (merged, removed: old
 * conversations still name such ids) can't run anything and has no projects, so it is treated as auto
 * and the session's own device is picked instead. Until the device list has loaded, any id is kept.
 */
export function usableDevice(device: string, devices: DeviceSummary[]): string {
  if (!isConcreteDevice(device) || devices.length === 0) return device || "auto";
  return devices.some((d) => d.device_id === device) ? device : "auto";
}

/** Whether a saved conversation config says something about a key ("" included: the user cleared it). */
export function configHas(config: Record<string, unknown> | null | undefined, key: string): boolean {
  return !!config && Object.prototype.hasOwnProperty.call(config, key);
}
