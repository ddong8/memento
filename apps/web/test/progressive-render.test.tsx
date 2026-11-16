// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useProgressiveCount } from "../src/lib/use-progressive";

// Long conversation lists render a slice at a time (src/lib/use-progressive.ts). On 2026-11-17 the
// project conversations page mounted a page of five sessions at once, 8,800 messages and 115k DOM
// nodes, and a phone's main thread froze for about 4 s; expanding a 5,520-message session on the
// timeline did the same. Nothing may be dropped: the rest has to come as the reader scrolls.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Watcher = { cb: IntersectionObserverCallback; els: Set<Element> };
let watchers: Watcher[];

class FakeObserver {
  w: Watcher;
  constructor(cb: IntersectionObserverCallback) {
    this.w = { cb, els: new Set() };
    watchers.push(this.w);
  }
  observe(el: Element) { this.w.els.add(el); }
  unobserve(el: Element) { this.w.els.delete(el); }
  disconnect() { this.w.els.clear(); }
  takeRecords() { return []; }
}

/** The sentinel scrolls into range: every live observer watching it fires */
function scrollToEnd() {
  for (const w of [...watchers]) {
    for (const el of [...w.els]) {
      w.cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], w as unknown as IntersectionObserver);
    }
  }
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  watchers = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function List({ total }: { total: number }) {
  const { count, done, sentinelRef } = useProgressiveCount(total, 60, 120);
  const n = Math.min(count, total);
  return (
    <div>
      {Array.from({ length: n }, (_, i) => <p key={i} data-row />)}
      {!done && <div ref={sentinelRef} data-sentinel />}
    </div>
  );
}

function Collapsible({ total }: { total: number }) {
  const [open, setOpen] = useState(false);
  const { count, done, sentinelRef } = useProgressiveCount(total, 60, 120);
  return (
    <div>
      <button onClick={() => setOpen(true)}>open</button>
      {open && Array.from({ length: Math.min(count, total) }, (_, i) => <p key={i} data-row />)}
      {open && !done && <div ref={sentinelRef} data-sentinel />}
    </div>
  );
}

const rows = () => host.querySelectorAll("[data-row]").length;

describe("progressive rendering of long conversations", () => {
  it("mounts only the first slice of a 5,520-message session", () => {
    act(() => root.render(<List total={5520} />));
    expect(rows()).toBe(60);
    expect(host.querySelector("[data-sentinel]")).not.toBeNull();
  });

  it("keeps adding as the reader scrolls and ends with every message, none dropped", () => {
    act(() => root.render(<List total={500} />));
    for (let i = 0; i < 10 && host.querySelector("[data-sentinel]"); i++) act(() => scrollToEnd());
    expect(rows()).toBe(500);
    expect(host.querySelector("[data-sentinel]")).toBeNull();
  });

  it("a short list is shown whole with nothing left to load", () => {
    act(() => root.render(<List total={12} />));
    expect(rows()).toBe(12);
    expect(host.querySelector("[data-sentinel]")).toBeNull();
  });

  it("starts loading more once a collapsed session is expanded (the sentinel mounts late)", () => {
    act(() => root.render(<Collapsible total={1000} />));
    expect(rows()).toBe(0);
    act(() => host.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(rows()).toBe(60);
    act(() => scrollToEnd());
    expect(rows()).toBe(180);
  });
});
