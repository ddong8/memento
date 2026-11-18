// macOS without a Developer ID: sign ad hoc, pinning the designated requirement
// to the bundle id so each update satisfies the running app's requirement
// (Squirrel.Mac checks it before swapping the app in).
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  // Signed with a Developer ID (and notarized) in CI: re-signing ad hoc would undo that
  if (process.env.MEMENTO_DEVELOPER_ID === "1") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const id = context.packager.appInfo.id;
  execFileSync("codesign", ["--force", "--deep", "-s", "-", `-r=designated => identifier "${id}"`, app], { stdio: "inherit" });
};
