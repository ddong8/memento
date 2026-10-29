// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// watchForNewBuild (src/lib/build-update.ts). The check it replaced looked for a main-app-<hash>.js
// chunk that Turbopack builds don't have, so windows open across a deploy never picked it up.

let served = "new1";
let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  served = "new1";
  reload = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(served, { status: 200 })));
  Object.defineProperty(window, "location", { value: { reload }, configurable: true });
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const minute = () => vi.advanceTimersByTimeAsync(60_000);

describe("watchForNewBuild", () => {
  it("reloads once the server runs another build", async () => {
    const { watchForNewBuild } = await import("../src/lib/build-update");
    served = "old0";
    const stop = watchForNewBuild("old0");
    await minute();
    expect(reload).not.toHaveBeenCalled();
    served = "new1";
    await minute();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toMatch(/^\/build-id\?_bc=\d+$/);
    stop();
  });

  it("waits while there is text being written, then reloads on moving to another page", async () => {
    const { watchForNewBuild, reloadIfNewBuild } = await import("../src/lib/build-update");
    document.body.innerHTML = "<textarea></textarea>";
    document.querySelector("textarea")!.value = "还没发出去的问题";
    const stop = watchForNewBuild("old0");
    await minute();
    expect(reload).not.toHaveBeenCalled();
    document.querySelector("textarea")!.value = "";
    reloadIfNewBuild();
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it("doesn't count a focused checkbox as writing", async () => {
    const { watchForNewBuild } = await import("../src/lib/build-update");
    document.body.innerHTML = '<input type="checkbox" checked>';
    document.querySelector("input")!.focus();
    const stop = watchForNewBuild("old0");
    await minute();
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does nothing without a build id, or on an answer that isn't one", async () => {
    const { watchForNewBuild } = await import("../src/lib/build-update");
    watchForNewBuild("")();
    served = "<!DOCTYPE html><html>bad gateway</html>";
    const stop = watchForNewBuild("old0");
    await minute();
    expect(reload).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    stop();
  });
});
