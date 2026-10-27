import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MarkdownViewer, { loadRehypeExtras } from "../src/components/viewers/MarkdownViewer";

const content = "按 <kbd>Ctrl</kbd> 运行\n\n```python\nprint(1)\n```";
const render = () => renderToString(createElement(MarkdownViewer, { content }));

describe("MarkdownViewer loads rehype-raw and highlighting after first paint", () => {
  it("hides inline HTML instead of showing its tags until they load", () => {
    const html = render();
    expect(html).not.toContain("&lt;kbd&gt;");
    expect(html).toContain("print(1)");
    expect(html).not.toContain("hljs");
  });

  it("renders inline HTML and highlights code once loaded", async () => {
    await loadRehypeExtras();
    const html = render();
    expect(html).toMatch(/<kbd[^>]*>Ctrl<\/kbd>/);
    expect(html).toContain("hljs-built_in");
  });
});
