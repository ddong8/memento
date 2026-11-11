import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// On Android, react-native-webview passes props to the native (C++) props parser unconverted, so a
// string given to a prop the native spec types as a number or an array crashes the app as soon as the
// web view mounts (v1.0.107 and earlier: dataDetectorTypes="none" → SIGSEGV right after sign-in).
const require = createRequire(import.meta.url);
const specPath = join(dirname(require.resolve("react-native-webview/package.json")), "src/RNCWebViewNativeComponent.ts");
const spec = readFileSync(specPath, "utf8");
const shell = readFileSync(join(__dirname, "../src/app/index.tsx"), "utf8");

function nonStringProps(): string[] {
  const names = new Set<string>();
  const re = /^ {2}(\w+)\?: (?:WithDefault<\s*)?(Double|Float|Int32|ReadonlyArray)\b/gm;
  for (const m of spec.matchAll(re)) names.add(m[1]);
  return [...names];
}

describe("web view props", () => {
  it("the native spec still has number and array props to check", () => {
    expect(nonStringProps()).toEqual(expect.arrayContaining(["dataDetectorTypes", "decelerationRate", "textZoom"]));
  });

  it("no number or array prop is given a string literal", () => {
    const bad = nonStringProps().filter((name) => new RegExp(`\\b${name}=["']`).test(shell));
    expect(bad).toEqual([]);
  });
});
