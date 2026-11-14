import { describe, expect, it } from "vitest";
import { withoutGeneratedRegions } from "../src/components/projects/BusinessBlueprintCard";

describe("BusinessBlueprintCard", () => {
  it("shows what was written by hand, not the generated index and check", () => {
    const md = [
      "# Business Blueprint: demo",
      "",
      "<!-- memento:business-index:start (自动生成，勿手改) -->",
      "| 3. 业务规则 | L9-L12 |",
      "<!-- memento:business-index:end -->",
      "## 3. 业务规则",
      "### R-A 规则 A",
      "",
      "<!-- memento:business-check:start (自动生成，勿手改) -->",
      "## 自动核对 (Auto Check)",
      "<!-- memento:business-check:end -->",
      "",
    ].join("\n");
    expect(withoutGeneratedRegions(md)).toBe("# Business Blueprint: demo\n\n## 3. 业务规则\n### R-A 规则 A");
  });
});
