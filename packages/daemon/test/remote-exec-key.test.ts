import { describe, expect, it } from "vitest";

import { withRemoteExecKey, type CollectorConfig } from "../src/config.js";

const base: CollectorConfig = {
  serverUrl: "https://memento.example",
  token: "collector-token",
  deviceId: "device-1",
  deviceName: "PC",
  platform: "Windows",
  extraWatchDirs: [],
};

// The server hands out the key once remote execution is on, which can be long after the daemon started:
// every heartbeat's key is taken, not only the first one's (else the task socket stayed refused until a restart)
describe("withRemoteExecKey", () => {
  it("takes a key the daemon didn't have", () => {
    expect(withRemoteExecKey(base, "k1")).toEqual({ ...base, remoteExecKey: "k1" });
  });

  it("takes a key that replaced the one held", () => {
    expect(withRemoteExecKey({ ...base, remoteExecKey: "old" }, "new")?.remoteExecKey).toBe("new");
  });

  it("changes nothing for the key already held, or none", () => {
    expect(withRemoteExecKey({ ...base, remoteExecKey: "k1" }, "k1")).toBeNull();
    expect(withRemoteExecKey(base, undefined)).toBeNull();
    expect(withRemoteExecKey(base, "")).toBeNull();
  });

  it("leaves the config it was given alone", () => {
    const config = { ...base };
    withRemoteExecKey(config, "k1");
    expect(config.remoteExecKey).toBeUndefined();
  });
});
