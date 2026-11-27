import { describe, expect, it } from "vitest";

import { localServerSummary, sameServer } from "@/components/server/LocalServerCard";

const st = (over: Partial<Parameters<typeof localServerSummary>[0] & object> = {}) => ({
  docker: "ready" as const,
  installed: true,
  running: true,
  url: "http://localhost:8770",
  dir: "/x",
  ...over,
});

describe("单机模式卡片", () => {
  it("says what to do next in each state", () => {
    expect(localServerSummary(st({ docker: "missing", installed: false, running: false }), "")).toContain("Docker Desktop");
    expect(localServerSummary(st({ installed: false, running: false }), "https://mem.example.com")).toContain("数据不出本机");
    expect(localServerSummary(st({ running: false }), "")).toContain("已停止");
    expect(localServerSummary(st(), "https://mem.example.com")).toContain("点切换");
    expect(localServerSummary(st(), "http://127.0.0.1:8770/")).toContain("正在使用");
  });

  it("localhost and 127.0.0.1 are the same server", () => {
    expect(sameServer("http://localhost:8770", "http://127.0.0.1:8770/")).toBe(true);
    expect(sameServer("http://localhost:8770", "https://mem.example.com")).toBe(false);
    expect(sameServer("", "")).toBe(false);
  });
});
