// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("@/lib/server-endpoint", () => ({
  getApiBase: () => "https://mem.example",
  authFetch: async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/api/preview/ports")) return Response.json({ ports: [{ port: 5173, process: "node" }] });
    if (url.endsWith("/api/preview/session")) return Response.json({ token: "tok", url: "/api/preview/t/tok/" });
    return new Response("{}", { status: 404 });
  },
}));

import { PreviewPanel } from "../src/components/ask/PreviewPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("preview panel", () => {
  it("lists the device's dev servers and opens one in a sandboxed frame through the relay", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<PreviewPanel deviceId="mini" isZh={true} />));
    expect(host.textContent).toContain("localhost:5173");
    const row = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("5173"))!;
    await act(async () => row.click());
    const frame = host.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("https://mem.example/api/preview/t/tok/");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(calls).toContain("POST https://mem.example/api/preview/session");
    act(() => root.unmount());
    host.remove();
  });
});
