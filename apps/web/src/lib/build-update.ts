"use client";

/**
 * Long-open windows (the desktop app, the phone app) pick up a newly deployed web build by reloading.
 *
 * It compares this page's build id (the commit, inlined at build: next.config.ts) with what the server
 * runs now (/build-id). It used to look for the main-app-<hash>.js chunk in /auth/login, which Turbopack
 * builds don't have: the check quit on load and windows kept the old code until restarted (2026-10-29,
 * a desktop opened before a fix kept running without it).
 *
 * It doesn't reload over text the user is writing: then it waits for them to move to another page, or
 * for the next check with the box empty.
 */

const CHECK_EVERY_MS = 60_000;

let stale = false;

export function watchForNewBuild(current: string = process.env.MEMENTO_BUILD_ID ?? ""): () => void {
  if (typeof window === "undefined" || !current) return () => {}; // dev or a build without the commit
  const check = async () => {
    if (document.visibilityState === "hidden") return;
    if (!stale) {
      try {
        const res = await fetch(`/build-id?_bc=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const latest = (await res.text()).trim();
        stale = /^[\w.-]{1,64}$/.test(latest) && latest !== current;
      } catch {
        return;
      }
    }
    if (stale && !writing()) window.location.reload();
  };
  const timer = setInterval(check, CHECK_EVERY_MS);
  window.addEventListener("focus", check);
  return () => {
    clearInterval(timer);
    window.removeEventListener("focus", check);
  };
}

/** Called on moving to another page: a new build seen while the user was writing loads now. */
export function reloadIfNewBuild(): void {
  if (stale && !writing()) window.location.reload();
}

/** Text in a box the user may still send or save: the focused field, or any non-empty textarea. */
function writing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (el?.isContentEditable && el.textContent?.trim()) return true;
  if (el instanceof HTMLInputElement && !NOT_TYPED.has(el.type) && el.value.trim()) return true;
  return Array.from(document.querySelectorAll("textarea")).some((t) => t.value.trim() !== "");
}

const NOT_TYPED = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "hidden"]);
