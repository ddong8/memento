import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(__dirname, "../src/app/index.tsx"), "utf8");

/** The document-start helper script, as the web view receives it. */
function helperScript(): string {
  const start = src.indexOf("const INJECTED_CLIENT_HELPERS = `") + "const INJECTED_CLIENT_HELPERS = `".length;
  const end = src.indexOf("true;`;", start) + "true;".length;
  return src.slice(start, end).replace(/\\`/g, "`").replace(/\\\$/g, "$");
}

describe("native shell helpers injected into the web view", () => {
  it("wait for <html> instead of throwing when Android runs them before it exists", () => {
    const html = {
      classes: new Set<string>(),
      classList: { add: (...c: string[]) => c.forEach((x) => html.classes.add(x)) },
      getAttribute: () => null,
      appendChild: () => undefined,
      style: { setProperty: () => undefined },
    };
    const doc: Record<string, unknown> = {
      documentElement: null,
      head: null,
      addEventListener: () => undefined,
      querySelector: () => null,
      createElement: () => ({ setAttribute: () => undefined, style: {} }),
    };
    const observers: Array<{ cb: (m: unknown[], o: unknown) => void; off?: boolean }> = [];
    class FakeObserver {
      cb: (m: unknown[], o: unknown) => void;
      off?: boolean;
      constructor(cb: (m: unknown[], o: unknown) => void) {
        this.cb = cb;
        observers.push(this);
      }
      observe() {}
      disconnect() {
        this.off = true;
      }
    }
    const win: Record<string, unknown> = {
      navigator: {},
      history: { pushState: () => undefined, replaceState: () => undefined },
      location: { pathname: "/ask", search: "" },
      addEventListener: () => undefined,
      matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
      ReactNativeWebView: { postMessage: () => undefined },
    };
    const run = new Function(
      "document", "window", "MutationObserver", "history", "location", "localStorage", "navigator", "setTimeout", "requestAnimationFrame",
      helperScript(),
    );
    expect(() =>
      run(doc, win, FakeObserver, win.history, win.location, { getItem: () => null, setItem: () => undefined }, {}, () => 0, () => 0),
    ).not.toThrow();
    expect(win.__memento_native_helpers_installed).toBeFalsy();

    doc.documentElement = html;
    doc.head = html;
    observers[0].cb([], observers[0]);
    expect([...html.classes].sort()).toEqual(["memento-glass-tabbar", "memento-native-shell"]);
    expect(win.__memento_native_helpers_installed).toBe(true);
    expect(observers[0].off).toBe(true);
  });

  it("re-mark <html> and publish the tab bar layout whenever it changes", () => {
    expect(src).toContain('h.classList.add("memento-native-shell","memento-glass-tabbar");h.classList.toggle("memento-tabbar-compact"');
    expect(src).toContain('h.style.setProperty("--memento-tabbar-side"');
    expect(src).toContain('h.style.setProperty("--memento-tabbar-bottom"');
    expect(src).toContain("window.__memento_tabbar_compact=");
    expect(src).not.toContain('document.documentElement.style.setProperty("--memento-tabbar-inset"');
  });

  it("shrink the tab bar while reading down and bring it back on the way up", () => {
    const listeners: Record<string, (e: { target: unknown }) => void> = {};
    const html: Record<string, unknown> = {
      nodeType: 1,
      classList: { add: () => undefined },
      getAttribute: () => null,
      appendChild: () => undefined,
      style: { setProperty: () => undefined },
    };
    const doc: Record<string, unknown> = {
      documentElement: html,
      head: html,
      addEventListener: (type: string, fn: (e: { target: unknown }) => void) => (listeners[type] = fn),
      querySelector: () => null,
      createElement: () => ({ setAttribute: () => undefined, style: {} }),
    };
    const posted: Array<{ type: string; compact?: boolean }> = [];
    const win: Record<string, unknown> = {
      innerHeight: 800,
      navigator: {},
      history: { pushState: () => undefined, replaceState: () => undefined },
      location: { pathname: "/ask", search: "" },
      addEventListener: () => undefined,
      matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
      ReactNativeWebView: { postMessage: (m: string) => posted.push(JSON.parse(m)) },
    };
    class NoopObserver {
      observe() {}
      disconnect() {}
    }
    let pageSupportsPill = "1";
    new Function(
      "document", "window", "MutationObserver", "history", "location", "localStorage", "navigator", "setTimeout", "requestAnimationFrame", "getComputedStyle",
      helperScript(),
    )(doc, win, NoopObserver, win.history, win.location, { getItem: () => null, setItem: () => undefined }, {}, () => 0, () => 0,
      () => ({ getPropertyValue: () => pageSupportsPill }));

    const list = { nodeType: 1, scrollTop: 0, scrollHeight: 4000, clientHeight: 700 };
    const scrollTo = (top: number) => {
      list.scrollTop = top;
      listeners.scroll({ target: list });
    };
    const tabBarStates = () => posted.filter((m) => m.type === "tabbar_compact").map((m) => m.compact);

    scrollTo(100);
    scrollTo(160); // down 60px
    expect(tabBarStates()).toEqual([true]);
    scrollTo(180);
    expect(tabBarStates()).toEqual([true]); // already shrunk: no repeat
    scrollTo(120); // up 60px
    expect(tabBarStates()).toEqual([true, false]);
    scrollTo(400);
    scrollTo(10); // back at the top
    expect(tabBarStates()).toEqual([true, false, true, false]);

    // A small scroller (the composer's textarea, a popover) never moves the tab bar
    const textarea = { nodeType: 1, scrollTop: 0, scrollHeight: 300, clientHeight: 80 };
    textarea.scrollTop = 50;
    listeners.scroll({ target: textarea });
    textarea.scrollTop = 200;
    listeners.scroll({ target: textarea });
    expect(tabBarStates()).toEqual([true, false, true, false]);

    // A page (stale cache, older server) whose CSS can't make room for the pill keeps the full tab bar
    pageSupportsPill = "";
    scrollTo(100);
    scrollTo(300);
    expect(tabBarStates()).toEqual([true, false, true, false]);
  });
});
