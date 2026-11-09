import { describe, expect, it } from "vitest";
import {
  baseDeviceName,
  deviceOfCall,
  deviceRelayUrl,
  fileDevice,
  fileKey,
  foreignPathStyle,
  onThisDevice,
  rememberFileDevice,
  setLocalDeviceName,
} from "../src/lib/file-devices";

describe("file-devices", () => {
  it("treats the spellings of one file as one key", () => {
    expect(fileKey("C:\\Users\\me\\a.md")).toBe("C:/Users/me/a.md");
    expect(fileKey("file:///C:/Users/me/a.md")).toBe("C:/Users/me/a.md");
    expect(fileKey(" /Users/me/a.md ")).toBe("/Users/me/a.md");
  });

  it("remembers which device a path came from", () => {
    rememberFileDevice("C:\\work\\report.docx", { id: "dev-1", name: "PC (Windows)" });
    expect(fileDevice("C:/work/report.docx")).toEqual({ id: "dev-1", name: "PC (Windows)" });
    expect(fileDevice("/C:/work/report.docx")).toEqual({ id: "dev-1", name: "PC (Windows)" });
    rememberFileDevice("/tmp/x.png", {});
    expect(fileDevice("/tmp/x.png")).toBeUndefined();
  });

  it("knows whether the file's device is this computer", () => {
    setLocalDeviceName(null);
    expect(onThisDevice({ name: "Mac-mini" })).toBeNull();
    setLocalDeviceName("Mac-mini");
    expect(baseDeviceName("Mac-mini (Darwin)")).toBe("mac-mini");
    expect(onThisDevice({ name: "mac-mini (Darwin)" })).toBe(true);
    expect(onThisDevice({ name: "PC (Windows)" })).toBe(false);
    expect(onThisDevice({ id: "dev-1" })).toBeNull();
    expect(onThisDevice(undefined)).toBeNull();
    setLocalDeviceName(null);
  });

  it("spots paths that can't be on this computer", () => {
    expect(foreignPathStyle("C:\\a\\b.md", false)).toBe(true);
    expect(foreignPathStyle("C:/a/b.md", true)).toBe(false);
    expect(foreignPathStyle("/Users/me/a.md", true)).toBe(true);
    expect(foreignPathStyle("/c/Users/me/a.md", true)).toBe(false);
    expect(foreignPathStyle("/tmp/a.md", true)).toBe(false);
    expect(foreignPathStyle("/Users/me/a.md", false)).toBe(false);
  });

  it("builds the relay URL for the file's device", () => {
    const url = new URL(deviceRelayUrl("C:/My Docs/a#1.md", "a#1.md", { id: "dev 1", name: "PC" }, "tok&x"));
    expect(url.pathname).toBe("/api/devices/dev%201/files/stream/a%231.md");
    expect(url.searchParams.get("path")).toBe("C:/My Docs/a#1.md");
    expect(url.searchParams.get("token")).toBe("tok&x");
    expect(new URL(deviceRelayUrl("/a.md", "a.md", { name: "Mac" })).pathname).toBe("/api/devices/Mac/files/stream/a.md");
    const auto = new URL(deviceRelayUrl("/a.md", ""));
    expect(auto.pathname).toBe("/api/devices/auto/files/stream/file");
    expect(auto.searchParams.has("token")).toBe(false);
  });

  it("reads a task's device from its result, the call or its args", () => {
    expect(deviceOfCall({ result: { device_id: "d1", device_name: "PC" }, device_name: "Mac" })).toEqual({ id: "d1", name: "PC" });
    expect(deviceOfCall({ device_name: "Mac", args: { device_id: "d2" } })).toEqual({ id: undefined, name: "Mac" });
    expect(deviceOfCall({ args: { device_id: "auto" } })).toBeUndefined();
    expect(deviceOfCall({ args: { device_id: "d2" } })).toEqual({ id: "d2", name: undefined });
    expect(deviceOfCall(null)).toBeUndefined();
  });
});
