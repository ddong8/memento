// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A menu switch that lands at once (kept view, prefetched route) draws no bar; only a switch still
// waiting after SHOW_AFTER_MS shows one (2026-11-17: the bar flashed on every click, like a browser).
let path = "/ask";
vi.mock("next/navigation", () => ({ usePathname: () => path }));

import TopProgressBar, { SHOW_AFTER_MS } from "../src/components/layout/TopProgressBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const bar = () => host.querySelector('[data-testid="top-progress"]');
const start = (href: string) => act(() => { window.dispatchEvent(new CustomEvent("memento:route-start", { detail: { href } })); });
const arrive = (p: string) => act(() => { path = p; root.render(<TopProgressBar />); });

beforeEach(() => {
  vi.useFakeTimers();
  path = "/ask";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<TopProgressBar />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("top progress bar", () => {
  it("stays hidden when the page switches at once", () => {
    start("/projects");
    act(() => { vi.advanceTimersByTime(30); });
    arrive("/projects");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(bar()).toBeNull();
  });

  it("shows while a slow switch waits and goes when it lands", () => {
    start("/projects");
    act(() => { vi.advanceTimersByTime(SHOW_AFTER_MS + 10); });
    expect(bar()).not.toBeNull();
    arrive("/projects");
    act(() => { vi.advanceTimersByTime(400); });
    expect(bar()).toBeNull();
  });
});
