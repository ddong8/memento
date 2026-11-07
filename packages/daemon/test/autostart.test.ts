import { expect, it } from "vitest";

import { launchdPlist, systemdUnit } from "../src/autostart.js";

it("service files run the daemon and escape what they must", () => {
  const plist = launchdPlist(["/usr/local/bin/node", "/opt/a&b/cli.js", "run"], "/tmp/daemon.log");
  expect(plist).toContain("<string>/opt/a&amp;b/cli.js</string>");
  expect(plist).toContain("<key>KeepAlive</key>");
  expect(systemdUnit(["/usr/bin/node", "/opt/my dir/cli.js", "run"])).toContain('ExecStart=/usr/bin/node "/opt/my dir/cli.js" run');
});
