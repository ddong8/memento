import { expect, it } from "vitest";

import { launchdPlist, systemdUnit } from "../src/autostart.js";

it("service files run the daemon and escape what they must", () => {
  const plist = launchdPlist(["/usr/local/bin/node", "/opt/a&b/cli.js", "run"], "/tmp/daemon.log");
  expect(plist).toContain("<string>/opt/a&amp;b/cli.js</string>");
  expect(plist).toContain("<key>KeepAlive</key>");
  expect(systemdUnit(["/usr/bin/node", "/opt/my dir/cli.js", "run"])).toContain('ExecStart=/usr/bin/node "/opt/my dir/cli.js" run');
});

it("lingering is turned on for a Linux service that would stop at logout, with a hint when that's refused", async () => {
  const { ensureLinger } = await import("../src/autostart.js");
  if (process.platform !== "linux") {
    expect(await ensureLinger("u", { lingering: () => false, enable: async () => true })).toBeUndefined();
    return;
  }
  expect(await ensureLinger("u", { lingering: () => true, enable: async () => true })).toBeUndefined();
  let on = false;
  expect(await ensureLinger("u", { lingering: () => on, enable: async () => (on = true) })).toBeUndefined();
  expect(await ensureLinger("u", { lingering: () => false, enable: async () => false })).toContain("sudo loginctl enable-linger u");
});
