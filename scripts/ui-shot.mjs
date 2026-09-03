/**
 * One-off WebUI screenshot helper for design review.
 *
 * Requires the Vite dev server (default http://localhost:5173) backed by a
 * running sashd. Screenshots land in the OS temp dir by default.
 *
 * Usage:
 *   node scripts/ui-shot.mjs [route] [--out <file>] [--dark] [--mobile]
 *                            [--width <px>] [--height <px>] [--full]
 * Examples:
 *   node scripts/ui-shot.mjs overview
 *   node scripts/ui-shot.mjs settings --dark --mobile
 *   node scripts/ui-shot.mjs rules --full --out rules.png
 */
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const route = args.find((a) => !a.startsWith("--")) ?? "overview";

function flagValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const dark = args.includes("--dark");
const mobile = args.includes("--mobile");
const full = args.includes("--full");
const width = Number(flagValue("--width") ?? (mobile ? 390 : 1440));
const height = Number(flagValue("--height") ?? (mobile ? 844 : 900));
const out =
  flagValue("--out") ??
  path.join(os.tmpdir(), `sash-ui-${route}${dark ? "-dark" : ""}${mobile ? "-m" : ""}.png`);
const base = process.env.SASH_UI_BASE ?? "http://localhost:5173";

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width, height },
  ...(mobile ? { isMobile: true, hasTouch: true } : {}),
});
if (dark) {
  await page.addInitScript(() => window.localStorage.setItem("sash.theme", "dark"));
}
page.on("pageerror", (err) => console.error("[pageerror]", err.message));
await page.goto(`${base}/#/${route}`, { timeout: 10_000 });
await page.waitForTimeout(2000);
await page.screenshot({ path: out, fullPage: full });
await browser.close();
console.log(out);
