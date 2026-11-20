import { describe, expect, it } from "vitest";
import { sanitizeMermaidSvg } from "@/components/viewers/MermaidBlock";

describe("sanitizeMermaidSvg", () => {
  it("strips script tags, inline event handlers, and javascript URIs", () => {
    const dirty = [
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">',
      "<script>window.__xss = 1</script>",
      '<a xlink:href="javascript:alert(2)" href="javascript:alert(3)">',
      '<g onclick="steal()" onerror=bad()><rect width="10" height="10"/></g>',
      "</a>",
      '<iframe src="https://evil.example"></iframe>',
      "</svg>",
    ].join("");

    const clean = sanitizeMermaidSvg(dirty);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/<iframe/i);
    expect(clean).not.toMatch(/on(?:load|click|error)=/i);
    expect(clean).not.toMatch(/javascript:/i);
    expect(clean).toContain('<rect width="10" height="10"/>');
  });

  it("preserves normal diagram SVG structure", () => {
    const normal = '<svg viewBox="0 0 100 100"><g class="node"><rect width="80" height="30"/><text>Hello</text></g></svg>';
    expect(sanitizeMermaidSvg(normal)).toBe(normal);
  });
});
