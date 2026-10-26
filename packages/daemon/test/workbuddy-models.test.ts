import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { workbuddyProductModels } from "../src/workbuddy-models.js";

function home(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "wb-models-"));
  mkdirSync(join(dir, ".workbuddy", "cache"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, ".workbuddy", "cache", name), typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

const CONFIG = {
  agents: [
    { name: "cli", models: ["fast-model", "glm-5.3", "gone-model"] },
    { name: "compact", models: ["wb-lite"] },
  ],
  models: [
    { id: "glm-5.3", name: "GLM-5.3", descriptionZh: "旗舰模型", credits: "x0.69" },
    { id: "fast-model", name: "快速", descriptionZh: "优先响应速度", credits: "x0.21", isDefault: true },
    { id: "wb-lite", name: "wb-lite" },
  ],
};

describe("WorkBuddy's model list", () => {
  it("is the cli agent's models from the cached product config, in its order", async () => {
    const models = await workbuddyProductModels(home({ "acc-product-config-v3.json": CONFIG }));
    expect(models).toEqual([
      { id: "fast-model", name: "快速", desc: "优先响应速度 · 积分 ×0.21", credits: "x0.21", is_workbuddy_default: true },
      { id: "glm-5.3", name: "GLM-5.3", desc: "旗舰模型 · 积分 ×0.69", credits: "x0.69" },
    ]);
  });

  it("reads the newest config version there is", async () => {
    const older = { ...CONFIG, agents: [{ name: "cli", models: ["glm-5.3"] }] };
    const models = await workbuddyProductModels(home({ "acc-product-config-v2.json": older, "acc-product-config-v3.json": CONFIG }));
    expect(models?.map((m) => m.id)).toEqual(["fast-model", "glm-5.3"]);
  });

  it("is null without a usable cache, so the built-in list is used", async () => {
    expect(await workbuddyProductModels(join(tmpdir(), "no-such-home-wb"))).toBeNull();
    expect(await workbuddyProductModels(home({ "acc-product-config-v3.json": "{not json" }))).toBeNull();
    expect(await workbuddyProductModels(home({ "acc-product-config-v3.json": { models: [], agents: [] } }))).toBeNull();
  });
});
