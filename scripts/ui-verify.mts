/**
 * Full-app visual verification for the WebUI optimization pass.
 *
 * Starts a real sash daemon server against an isolated data dir serving the
 * built UI (dist/ui), then screenshots all routes in Chromium and Firefox,
 * light and dark themes, plus the settings code editor dialog.
 *
 * Usage: npx tsx scripts/ui-verify.mts [outDir]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, firefox } from "playwright";
import { createDaemonServer } from "../src/daemon.js";
import { sashLayout } from "../src/paths.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

const outDir = process.argv[2] ?? path.join(os.tmpdir(), "sash-ui-verify");
fs.mkdirSync(outDir, { recursive: true });

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sash-ui-verify-home-"));
const layout = sashLayout(home);
fs.mkdirSync(layout.root, { recursive: true });
// Serve the real built UI: replace the (empty) ui dir with a link to dist/ui.
const distUi = path.resolve("dist/ui");
fs.rmSync(layout.uiDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(layout.uiDir), { recursive: true });
fs.symlinkSync(distUi, layout.uiDir, "junction");

const fakeSupervisor = {
  isRunning: () => false,
  ownedCoreSnapshot: () => undefined,
  ownsCore: () => false,
  status: async () => ({ running: false }),
  start: async () => ({ pid: 9999, version: "v1.0.0" }),
  stop: async () => {},
  restart: async () => ({ pid: 10000, version: "v1.0.0" }),
  cleanStaleCore: async () => {},
};

const fakeSystemProxy = {
  getState: async () => ({
    supported: true,
    enabled: false,
    server: "127.0.0.1:7890",
    bypass: "",
    effectiveEnabled: false,
    meetsPortExpectation: true,
    appliedKnown: true,
    stateKnown: true,
  }),
  isApplied: async () => true,
};

const instance = createDaemonServer({
  layout,
  settings: {
    ...DEFAULT_SETTINGS,
    daemonSecret: "ui-verify-secret-1234567890",
    controller: "127.0.0.1:19091",
    secret: "ui-verify-core-secret-123456",
  },
  supervisor: fakeSupervisor as never,
  systemProxy: fakeSystemProxy as never,
});

await new Promise<void>((resolve, reject) => {
  instance.server.listen(19998, "127.0.0.1", resolve);
  instance.server.once("error", reject);
});
const base = "http://127.0.0.1:19998/ui/";
console.log(`daemon up at ${base}`);

const routes = ["overview", "profiles", "connections", "rules", "logs", "settings"];

async function shoot(engine, engineName) {
  const browser = await engine.launch();
  for (const dark of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (err) => console.error(`[pageerror:${engineName}]`, err.message));
    if (dark) {
      await page.addInitScript(() => window.localStorage.setItem("sash.theme", "dark"));
    }
    const tag = dark ? "dark" : "light";
    for (const route of routes) {
      await page.goto(`${base}#/${route}`, { timeout: 15_000 });
      await page.waitForTimeout(1800);
      await page.screenshot({ path: path.join(outDir, `${engineName}-${route}-${tag}.png`) });
    }
    // Open the settings file editor (exercises the async CodeMirror chunk).
    await page.goto(`${base}#/settings`, { timeout: 15_000 });
    await page.waitForTimeout(1200);
    const editBtn = page
      .locator("button")
      .filter({ hasText: /edit|编辑/i })
      .first();
    if (await editBtn.count()) {
      await editBtn.click();
      await page.waitForTimeout(3000);
      await page.screenshot({ path: path.join(outDir, `${engineName}-editor-${tag}.png`) });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(800);
    } else {
      console.error(`[${engineName}] no edit button found on settings`);
    }
    await page.close();
  }
  await browser.close();
}

try {
  await shoot(chromium, "chromium");
  await shoot(firefox, "firefox");
} finally {
  instance.server.close();
  process.exit(0);
}
