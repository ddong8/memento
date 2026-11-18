import { describe, expect, it } from "vitest";
import { AUDIT_ACTION_LABELS, auditSummary } from "../src/lib/audit-labels";

describe("audit log display", () => {
  it("names the actions an admin reads in the list", () => {
    expect(AUDIT_ACTION_LABELS["admin.user.update"]).toBe("修改角色或状态");
    expect(AUDIT_ACTION_LABELS["device_task.dispatch"]).toBe("向设备派发命令");
    expect(AUDIT_ACTION_LABELS["scim.user.deactivate"]).toBe("身份平台停用账号");
  });

  it("sums an entry up: whom, what changed, what ran", () => {
    expect(auditSummary({ email: "a@corp.com", before: { role: "viewer", status: "active" }, after: { role: "admin", status: "active" } }))
      .toBe("a@corp.com · viewer → admin");
    expect(auditSummary({ device: "mac-mini", preview: "ls -la", other_users_device: true }))
      .toBe("设备 mac-mini · ls -la · 他人的设备");
    expect(auditSummary(undefined)).toBe("");
  });
});
