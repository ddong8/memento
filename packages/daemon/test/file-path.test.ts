import { describe, expect, it } from "vitest";

import { deviceFilePath } from "../src/file-path.js";

describe("device file paths", () => {
  it("Windows reads the paths Git Bash, Cygwin, WSL and file:// URLs write", () => {
    expect(deviceFilePath("/c/Users/me/a.md", "win32")).toBe("C:/Users/me/a.md");
    expect(deviceFilePath("/d", "win32")).toBe("D:/");
    expect(deviceFilePath("/mnt/c/Users/me/a.md", "win32")).toBe("C:/Users/me/a.md");
    expect(deviceFilePath("/cygdrive/e/x/y.png", "win32")).toBe("E:/x/y.png");
    expect(deviceFilePath("/C:/Users/me/a.md", "win32")).toBe("C:/Users/me/a.md");
    expect(deviceFilePath("file:///C:/Users/me/a%20b.md", "win32")).toBe("C:/Users/me/a b.md");
    expect(deviceFilePath("C:\\Users\\me\\a.md", "win32")).toBe("C:\\Users\\me\\a.md");
    // a real folder name that only starts with a letter stays as it is
    expect(deviceFilePath("/cache/a.md", "win32")).toBe("/cache/a.md");
  });

  it("other platforms keep POSIX paths, only dropping file:// and expanding ~", () => {
    expect(deviceFilePath("/c/Users/me/a.md", "darwin")).toBe("/c/Users/me/a.md");
    expect(deviceFilePath("/mnt/c/x.md", "linux")).toBe("/mnt/c/x.md");
    expect(deviceFilePath("file:///Users/me/a%20b.md", "darwin")).toBe("/Users/me/a b.md");
    expect(deviceFilePath("file://localhost/Users/me/a.md", "darwin")).toBe("/Users/me/a.md");
    expect(deviceFilePath("file:///Users/me/100%.md", "darwin")).toBe("/Users/me/100%.md");
    expect(deviceFilePath("  ~/notes/a.md ", "darwin", "/Users/me")).toBe("/Users/me/notes/a.md");
    expect(deviceFilePath("~\\a.md", "win32", "C:\\Users\\me")).toBe("C:\\Users\\me\\a.md");
  });
});
