import { describe, expect, it } from "vitest";
import { parseDownloadProgress } from "@/lib/publish-progress";

describe("parseDownloadProgress", () => {
  it("取最近一条拉取进度", () => {
    const p = parseDownloadProgress([
      "[08:16:26] 拉取成片 10%（24/243 MB，0.2 MB/s，约剩 17 分 53 秒）",
      "[08:17:28] 拉取成片 20%（49/243 MB，0.3 MB/s，约剩 12 分 5 秒）",
      "[08:17:30] 经家里局域网直连拉取",
    ]);
    expect(p).toEqual({ percent: 20, doneMb: 49, totalMb: 243, speed: 0.3, leftSec: 725 });
  });
  it("还没有进度时返回 null", () => {
    expect(parseDownloadProgress(["[08:14:25] 正在从演播台拉取成片至本机缓存…"])).toBeNull();
  });
});
