// @vitest-environment happy-dom
import { act, useContext, useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LayoutRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { usePathname, useSearchParams } from "next/navigation";
import RouteKeepAlive, { useRouteShown } from "../src/components/layout/RouteKeepAlive";

// Kept menu views (src/components/layout/RouteKeepAlive.tsx). The `children` a layout gets is Next's
// slot, which renders the route the router is on now, read from context (OuterLayoutRouter in
// next/dist/client/components/layout-router.js: the active segment of the context's tree, keyed by
// it). Kept as is, every kept view rendered the current page: on 2026-10-28 the ask page ran in up to
// 4 copies on the phone and 6 on the desktop, each following the answer and polling on its own.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let created: Record<string, number>;
let running: Record<string, number>;
let shown: number;

function usePage(name: string) {
  useState(() => (created[name] = (created[name] ?? 0) + 1));
  useEffect(() => {
    running[name] = (running[name] ?? 0) + 1;
    return () => {
      running[name] -= 1;
    };
  }, [name]);
}

function AskPage() {
  usePage("ask");
  const pathname = usePathname();
  const id = useSearchParams()?.get("id");
  useRouteShown(() => (shown += 1));
  return <p data-page="ask">{`${pathname} ${id}`}</p>;
}

function AppPage() {
  usePage("app");
  const [clicks, setClicks] = useState(0);
  return (
    <button data-page="app" onClick={() => setClicks((n) => n + 1)}>
      {`clicks ${clicks}`}
    </button>
  );
}

function ProfilePage() {
  usePage("profile");
  return <p data-page="profile">profile</p>;
}

function ProjectPage() {
  usePage("projects");
  return <p data-page="projects">project</p>;
}

const pages: Record<string, () => React.JSX.Element> = { ask: AskPage, app: AppPage, profile: ProfilePage, projects: ProjectPage };

// Next's slot, as it renders: the page of the route in context, keyed by its segment
function Slot() {
  const { segment } = useContext(LayoutRouterContext) as unknown as { segment: string };
  const Page = pages[segment];
  return <Page key={segment} />;
}

function Router({ url }: { url: string }) {
  const parsed = useMemo(() => new URL(url, "https://mem.test"), [url]);
  const layout = useMemo(() => ({ segment: parsed.pathname.split("/")[1] }), [parsed]);
  return (
    <LayoutRouterContext.Provider value={layout as never}>
      <PathnameContext.Provider value={parsed.pathname}>
        <SearchParamsContext.Provider value={parsed.searchParams}>
          <RouteKeepAlive>
            <Slot />
          </RouteKeepAlive>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </LayoutRouterContext.Provider>
  );
}

let host: HTMLDivElement;
let root: Root;

function go(url: string) {
  act(() => root.render(<Router url={url} />));
}

const all = (page: string) => [...host.querySelectorAll(`[data-page="${page}"]`)];

beforeEach(() => {
  created = {};
  running = {};
  shown = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("kept menu views", () => {
  it("render each page once, not the current page in every kept view", () => {
    go("/ask?id=c1");
    go("/app");
    go("/profile");
    go("/ask?id=c1");
    expect(all("ask")).toHaveLength(1);
    expect(all("app")).toHaveLength(1);
    expect(all("profile")).toHaveLength(1);
    expect(created).toEqual({ ask: 1, app: 1, profile: 1 });
    expect(running.ask).toBe(1);

    // A page outside the kept menus renders once too
    go("/projects/p1");
    expect(all("projects")).toHaveLength(1);
    expect(all("ask")).toHaveLength(1);
  });

  it("keep a hidden page on the route it was left at, and tell it when it's back", () => {
    go("/ask?id=c1");
    go("/app");
    expect(all("ask").map((el) => el.textContent)).toEqual(["/ask c1"]);
    // The ask page goes on (it keeps following a running answer) while hidden
    expect(running.ask).toBe(1);
    expect(shown).toBe(0);

    go("/ask?id=c2");
    expect(all("ask").map((el) => el.textContent)).toEqual(["/ask c2"]);
    expect(created.ask).toBe(1);
    expect(shown).toBe(1);

    // Another conversation on the same page isn't coming back
    go("/ask?id=c3");
    expect(shown).toBe(1);
  });

  it("pause hidden pages other than the ask page, keeping their state", () => {
    go("/app");
    act(() => (all("app")[0] as HTMLButtonElement).click());
    go("/ask");
    expect(running.app).toBe(0);
    expect(all("app").map((el) => el.textContent)).toEqual(["clicks 1"]);

    go("/app");
    expect(running.app).toBe(1);
    expect(all("app").map((el) => el.textContent)).toEqual(["clicks 1"]);
    expect(created.app).toBe(1);
  });
});
