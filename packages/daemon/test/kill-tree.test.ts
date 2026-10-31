import { describe, expect, it } from "vitest";
import { getWindowsDescendantPids, killProcessTree } from "../src/exec-env.js";

describe("process tree management", () => {
  it("safely handles invalid PIDs without throwing", async () => {
    expect(() => killProcessTree(undefined)).not.toThrow();
    expect(() => killProcessTree(-1)).not.toThrow();
    expect(() => killProcessTree(0)).not.toThrow();
    const descendants = await getWindowsDescendantPids(0);
    expect(descendants).toEqual([]);
    const negativeDescendants = await getWindowsDescendantPids(-999);
    expect(negativeDescendants).toEqual([]);
  });
});
