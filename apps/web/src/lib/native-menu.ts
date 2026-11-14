import { desktop } from "./desktop";

export type NativeMenuItem =
  | { type: "separator" }
  | { id: string; label: string; checked?: boolean; enabled?: boolean };

/** Whether this client shows action menus as the system's own menu (desktop app 1.0.128+). */
export function hasNativeMenu(): boolean {
  return typeof desktop()?.popupMenu === "function";
}

/**
 * Shows an action menu as the system's menu under (or, near the window's bottom, over) the anchor:
 * the chosen item's id, null when closed without a choice, undefined when this client has no system menus
 * (a browser, the mobile app, an older desktop app), so the caller opens its own menu instead.
 */
export async function popupNativeMenu(items: NativeMenuItem[], anchor?: Element | null): Promise<string | null | undefined> {
  const d = desktop();
  if (typeof d?.popupMenu !== "function") return undefined;
  const r = anchor?.getBoundingClientRect();
  const pos = r ? { x: Math.round(r.left), y: Math.round(r.bottom + 4) } : undefined;
  try {
    const id = await d.popupMenu(items, pos);
    return typeof id === "string" && id ? id : null;
  } catch {
    return undefined;
  }
}
