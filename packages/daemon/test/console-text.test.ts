import { describe, expect, it } from "vitest";

import { codePageEncoding, LineDecoder } from "../src/console-text.js";

// "无法将“head”项识别为 cmdlet" as Windows PowerShell 5.1 writes it into a pipe on Chinese Windows (GBK)
const GBK_LINE = Buffer.from([0xce, 0xde, 0xb7, 0xa8, 0xbd, 0xab, 0x22, 0x68, 0x65, 0x61, 0x64, 0x22, 0x0d, 0x0a]);

describe("Windows console output", () => {
  it("maps Windows code pages to decoders", () => {
    expect(codePageEncoding(936)).toBe("gb18030");
    expect(codePageEncoding(65001)).toBeNull();
    expect(codePageEncoding(12345)).toBeNull();
  });

  it("reads GBK lines as GBK and UTF-8 lines as UTF-8 in the same stream", () => {
    const d = new LineDecoder("gb18030");
    const utf8 = Buffer.from("节点脚本的输出 ✅\n", "utf8");
    expect(d.push(Buffer.concat([GBK_LINE, utf8]))).toBe('无法将"head"\r\n节点脚本的输出 ✅\n');
  });

  it("keeps a character split across chunks whole", () => {
    const d = new LineDecoder("gb18030");
    expect(d.push(GBK_LINE.subarray(0, 3))).toBe("");
    expect(d.push(GBK_LINE.subarray(3))).toBe('无法将"head"\r\n');
  });

  it("passes on a last line without a newline when the stream ends", () => {
    const d = new LineDecoder("gb18030");
    expect(d.push(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe("");
    expect(d.flush()).toBe("中文");
  });

  it("without a known console encoding behaves like plain UTF-8", () => {
    const d = new LineDecoder(null);
    expect(d.push(Buffer.from("ok\n"))).toBe("ok\n");
    expect(d.push(GBK_LINE)).toContain("�");
  });
});
