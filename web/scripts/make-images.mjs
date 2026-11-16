// Generates the two bitmap images the site needs from the same logo mark and
// fonts the app uses:
//   public/og.png                 1200x630 preview shown when the link is shared
//   public/apple-touch-icon.png   180x180 home-screen icon
//
// Run from the web folder:  node scripts/make-images.mjs

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fontData = (pkg, file) =>
  readFileSync(require.resolve(`${pkg}/files/${file}`)).toString("base64");
const sora = fontData("@fontsource-variable/sora", "sora-latin-wght-normal.woff2");
const mono = fontData("@fontsource-variable/jetbrains-mono", "jetbrains-mono-latin-wght-normal.woff2");

const MARK = `
  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <rect width="24" height="24" rx="6" fill="#17171a"/>
    <g fill="none" stroke="#f3f2ee" stroke-width="2" stroke-linecap="round">
      <path d="M4.5 12h6"/><path d="M7 7.75h4.5M7 16.25h4.5" opacity=".55"/>
    </g>
    <circle cx="16.5" cy="12" r="3.25" fill="#f3f2ee"/>
  </svg>`;

const FONTS = `
  @font-face { font-family: Sora; font-weight: 100 800; src: url(data:font/woff2;base64,${sora}) format("woff2"); }
  @font-face { font-family: Mono; font-weight: 100 800; src: url(data:font/woff2;base64,${mono}) format("woff2"); }`;

const OG = `<!doctype html><style>${FONTS}
  body { margin: 0; width: 1200px; height: 630px; background: #f3f2ee; color: #17171a; font-family: Sora;
         display: flex; flex-direction: column; justify-content: space-between; padding: 84px; box-sizing: border-box; }
  .brand { display: flex; align-items: center; gap: 24px; font-size: 76px; font-weight: 700; letter-spacing: -0.03em; line-height: 1; }
  .brand svg { width: 108px; height: 108px; }
  .brand i:nth-of-type(1) { font-style: normal; opacity: .55; } .brand i:nth-of-type(2) { font-style: normal; opacity: .28; }
  h1 { margin: 0; font-size: 102px; font-weight: 700; letter-spacing: -0.035em; line-height: 1.08; }
  p { margin: 0; font: 500 38px/1 Mono; color: #74747a; letter-spacing: 0.04em; }
</style>
<div class="brand">${MARK}<span>Sher<i>r</i><i>r</i></span></div>
<h1>Send big files straight to another device.</h1>
<p>NO UPLOAD · NO ACCOUNT · DEVICE TO DEVICE</p>`;

// iOS rounds the corners itself, so the icon fills the whole square.
const ICON = `<!doctype html><style>body { margin: 0; width: 180px; height: 180px; background: #17171a; display: grid; place-items: center; }
  svg { width: 180px; height: 180px; }</style>${MARK.replace('rx="6"', 'rx="0"')}`;

const browser = await chromium.launch();
for (const [html, width, height, out] of [
  [OG, 1200, 630, "public/og.png"],
  [ICON, 180, 180, "public/apple-touch-icon.png"],
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out });
  await page.close();
  console.log(`wrote ${out}`);
}
await browser.close();
