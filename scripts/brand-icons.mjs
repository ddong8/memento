// Renders the app icons of the TypeScript and multi-platform clients from the Memento mark
// (squircle with Aurora gradient and sparkles mark).
//   node scripts/brand-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const defs = `
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#7C3AED"/>
      <stop offset="55%" stop-color="#EC4899"/>
      <stop offset="100%" stop-color="#06B6D4"/>
    </linearGradient>
  </defs>`;

const sparkles = (cx, cy, scale = 1.333333, strokeColor = "#ffffff") => `
  <g transform="translate(${cx - 12 * scale}, ${cy - 12 * scale}) scale(${scale})" fill="none" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/>
    <path d="M19 14l.7 2.3L22 17l-2.3.7L19 20l-.7-2.3L16 17l2.3-.7z"/>
  </g>`;

/** The mark on a rounded square inside a canvas with `pad` units of margin (64-unit grid). */
const rounded = (pad) => {
  const size = 64 - pad * 2;
  const rx = size * 0.28;
  const scale = (size / 60) * 1.333333;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${defs}<rect x="${pad}" y="${pad}" width="${size}" height="${size}" rx="${rx}" fill="url(#g)"/>${sparkles(32, 32, scale)}</svg>`;
};

/** Full-bleed square (iOS masks the corners itself). */
const square = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${defs}<rect width="64" height="64" fill="url(#g)"/>${sparkles(32, 32, 1.45)}</svg>`;

/** Android adaptive layers: gradient background, sparkles foreground inside the safe zone. */
const background = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${defs}<rect width="64" height="64" fill="url(#g)"/></svg>`;
const foreground = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${defs}${sparkles(32, 32, 1.2)}</svg>`;
const monochrome = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${sparkles(32, 32, 1.2, "#ffffff")}</svg>`;

// Native macOS Template icon (16x16 pt): monochrome double-sparkles glyph with transparent background
const s = 0.68;
const tx = (8 - 14 * s).toFixed(2);
const ty = (8 - 11.5 * s).toFixed(2);
const trayTemplateSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <g transform="translate(${tx}, ${ty}) scale(${s})" fill="#000000" stroke="#000000" stroke-width="0.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/>
    <path d="M19 14l.7 2.3L22 17l-2.3.7L19 20l-.7-2.3L16 17l2.3-.7z"/>
  </g>
</svg>`;

async function render(svg, size, out) {
  mkdirSync(dirname(out), { recursive: true });
  await sharp(Buffer.from(svg), { density: 1024 }).resize(size, size).png().toFile(out);
  console.log(out);
}

const desktop = join(root, "apps/desktop");
const mobileExpo = join(root, "apps/mobile/assets");
const webPublic = join(root, "apps/web/public");

// 1. Desktop app icons (macOS Big Sur 824/1024 grid margin: pad 6.25 of 64)
await render(rounded(6.25), 1024, join(desktop, "build/icon.png"));

// macOS native menu bar template icon (16x16 pt, rendered at 16x16 @1x and 32x32 @2x)
await render(trayTemplateSvg, 16, join(desktop, "static/trayTemplate.png"));
await render(trayTemplateSvg, 32, join(desktop, "static/trayTemplate@2x.png"));

// Standard tray icon (16x16 pt, rendered at 16x16 @1x and 32x32 @2x)
await render(rounded(2), 16, join(desktop, "static/tray.png"));
await render(rounded(2), 32, join(desktop, "static/tray@2x.png"));

// 2. Mobile Expo assets
await render(square, 1024, join(mobileExpo, "icon.png"));
await render(rounded(2), 1024, join(mobileExpo, "splash-icon.png"));
await render(background, 1024, join(mobileExpo, "android-icon-background.png"));
await render(foreground, 1024, join(mobileExpo, "android-icon-foreground.png"));
await render(monochrome, 1024, join(mobileExpo, "android-icon-monochrome.png"));
await render(rounded(2), 48, join(mobileExpo, "favicon.png"));

// 3. Web favicons
const faviconSvgContent = rounded(2);
writeFileSync(join(webPublic, "favicon.svg"), faviconSvgContent, "utf8");
writeFileSync(join(webPublic, "favicon-aurora.svg"), faviconSvgContent, "utf8");
await render(rounded(2), 512, join(webPublic, "favicon.png"));

console.log("All brand icons generated successfully!");
