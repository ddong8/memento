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

  it("re-mark <html> whenever the tab bar height is pushed to the page", () => {
    expect(src).toContain('h.classList.add("memento-native-shell","memento-glass-tabbar");h.style.setProperty("--memento-tabbar-inset"');
    expect(src).not.toContain('document.documentElement.style.setProperty("--memento-tabbar-inset"');
  });
});
