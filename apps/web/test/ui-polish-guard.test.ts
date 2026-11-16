// Guards the 11-16 UI cleanup: emoji used as icons in visible text read as cheap next to the line icon set,
// and the language / skin switchers belong in the avatar menu, not every page's top bar. Markers the agents
// write into their own output (⏳ [后台任务…] and the like) are matched by regexes and are not UI text.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../src");
const EMOJI = /(["`>]|^\s+)([\u{1F300}-\u{1FAFF}☀-➿⭐✅❌]️?)\s?(?=[\w一-鿿（(「#$[{])/u;
// An emoji alone as an element's content (<span>🎨</span>), or as a ternary's quoted result ("🔊" : "🔇")
const EMOJI_ALONE = /(>\s*[\u{1F300}-\u{1FAFF}☀-➿⭐✅❌]️?\s*<)|(\?\s*"[\u{1F300}-\u{1FAFF}☀-➿⭐]️?"\s*:)/u;
// Lines that match or strip markers in agent output, not text shown as a label
const SKIP = /\\s|\\\[|RegExp|\.test\(|\.match\(|\.replace\(|startsWith|includes\(/;
// Files that render agent output / markdown, where emoji come from the content itself; the video
// player's on-screen volume / brightness / lock flashes (a media HUD, like a TV's)
const ALLOW = new Set(["components/viewers/MarkdownViewer.tsx", "lib/ask/cache.ts", "lib/native-notify.ts", "components/landing/WorkbenchBlock.tsx", "components/viewers/MermaidBlock.tsx", "components/viewers/MediaPreview.tsx"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx|ts)$/.test(n) ? [p] : [];
  });
}

describe("UI polish guard", () => {
  it("visible text doesn't use emoji as icons", () => {
    const hits: string[] = [];
    for (const f of files(SRC)) {
      const rel = f.slice(SRC.length + 1);
      if (ALLOW.has(rel) || rel.startsWith("lib/i18n/en-US")) continue;
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*") || SKIP.test(line)) return;
        if (EMOJI.test(line) || EMOJI_ALONE.test(line)) hits.push(`${rel}:${i + 1}: ${t.slice(0, 90)}`);
      });
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("the top bar has no language or skin switcher", () => {
    const header = readFileSync(join(SRC, "components/layout/Header.tsx"), "utf8");
    expect(header).not.toMatch(/SkinPicker|setLocale/);
  });
});
