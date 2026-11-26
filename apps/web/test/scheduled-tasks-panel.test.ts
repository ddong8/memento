import { describe, expect, it } from "vitest";
import { buildSchedule, describeSchedule } from "../src/components/todos/ScheduledTasksPanel";

describe("scheduled tasks panel", () => {
  it("turns the form's choice into the server's schedule and back into words", () => {
    expect(buildSchedule("daily", "09:30", 0)).toBe("daily:9:30");
    expect(buildSchedule("weekly", "08:05", 4)).toBe("weekly:4:8:5");
    expect(buildSchedule("hourly", "00:15", 0)).toBe("hourly:15");
    expect(describeSchedule("daily:9:30")).toBe("每天 09:30");
    expect(describeSchedule("weekly:4:8:5")).toBe("每周五 08:05");
    expect(describeSchedule("hourly:15")).toBe("每小时第 15 分");
  });
});
