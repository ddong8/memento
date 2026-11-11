import { describe, expect, it } from "vitest";
import type { PlanStep } from "@/lib/api-client";
import { duration, planProgress, planStages, workspaceNote } from "@/lib/plans/display";

const step = (id: string, depends_on: string[] = []): PlanStep =>
  ({ id, depends_on, kind: "work", title: id, status: "pending" }) as unknown as PlanStep;

describe("plan display", () => {
  it("groups steps into stages by their dependencies", () => {
    const stages = planStages([step("a"), step("b"), step("c", ["a"]), step("d", ["c", "b"]), step("review", ["a", "b", "c", "d"])]);
    expect(stages.map((s) => s.map((x) => x.id))).toEqual([["a", "b"], ["c"], ["d"], ["review"]]);
  });

  it("survives a cycle and unknown dependencies", () => {
    const stages = planStages([step("a", ["b"]), step("b", ["a"]), step("c", ["zzz"])]);
    expect(stages.flat().map((s) => s.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("counts finished steps", () => {
    expect(planProgress({ step_counts: { succeeded: 2, failed: 1, running: 1 }, step_total: 4 })).toEqual({ done: 3, total: 4, percent: 75 });
    expect(planProgress({ step_counts: {}, step_total: 0 }).percent).toBe(0);
  });

  it("describes where the changes went", () => {
    expect(workspaceNote({ status: "applied", files: 3 })).toContain("3 个文件");
    expect(workspaceNote({ status: "conflict", branch: "memento/ab12" })).toContain("memento/ab12");
    expect(workspaceNote(null)).toBe("");
  });

  it("formats durations", () => {
    expect(duration("2026-11-12T00:00:00Z", "2026-11-12T00:05:30Z")).toBe("5 分钟");
    expect(duration("2026-11-12T00:00:00Z", "2026-11-12T02:10:00Z")).toBe("2 小时 10 分");
    expect(duration(null, null)).toBe("");
  });
});
