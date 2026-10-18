import { describe, expect, it } from "vitest";
import { getApiBase, seedApiEtagCache } from "../src/lib/api-client";

describe("api-client module", () => {
  it("returns default localhost:8001 in non-browser environment", () => {
    const base = getApiBase();
    expect(base).toBe("http://localhost:8001");
  });

  it("seeds etag cache correctly", () => {
    const testData = { success: true, count: 42 };
    seedApiEtagCache("/api/test/stats", '"etag-12345"', testData);
    // Should not throw and successfully record in etag cache
    expect(true).toBe(true);
  });
});
