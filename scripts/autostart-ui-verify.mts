// Run after npm run build. Uses a temporary daemon and a fake OS startup controller.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { AutostartStatus } from "../src/autostart-contract.js";
import { parseWebBootstrapInfo } from "../src/contracts.js";
import { DaemonTestHarness } from "../src/testing/daemon-harness.js";
import { captureFailurePages, launchUiBrowser, uiArtifactDirectory, UI_ENGINES } from "./ui-harness.mjs";

const output = uiArtifactDirectory("sash-autostart-ui-");
const results: string[] = [];
const errors: string[] = [];
const h = new DaemonTestHarness();
h.setup();
h.settings.mixedPort = 27896;
h.settings.controller = "127.0.0.1:27897";
h.settings.daemonPort = 29198;
let state: AutostartStatus = { state: "off", canEnable: true, reason: null };
let failWrite = false;
let pending: Promise<void> | undefined;
let entered: (() => void) | undefined;
let writes = 0;
await h.startServer({
  autostart: {
    inspect: async () => ({ ...state }),
    set: async (enabled) => {
      writes += 1;
      entered?.();
      await pending;
      if (failWrite) throw new Error("Simulated startup registration failure");
      state = { state: enabled ? "on" : "off", canEnable: true, reason: null };
      return { ...state };
    },
  },
});
assert.ok(![7890, 9090, 19090].includes(h.boundPort));
const origin = "http://127.0.0.1:" + h.boundPort;
const settingsBefore = await readFile(h.layout.settingsFile, "utf8");

async function idle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector(".autostart-row")?.getAttribute("aria-busy") === "false",
  );
}

async function capture(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(output, name + ".png"), fullPage: true, animations: "disabled" });
  results.push(name);
}

try {
  for (const { engine, name } of UI_ENGINES) {
    console.log(`Verifying ${name}`);
    state = { state: "off", canEnable: true, reason: null };
    const browser = await launchUiBrowser(engine);
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() => {
        if (!localStorage.getItem("sash.locale")) localStorage.setItem("sash.locale", "zh");
      });
      const bootstrap = parseWebBootstrapInfo(
        (await h.apiRequest("/sash/web/bootstrap", { method: "POST" })).data,
      );
      await page.goto(origin + "/ui/#boot=" + bootstrap.token);
      await page.waitForFunction(() => sessionStorage.getItem("sash.control-token") !== null);
      await page.goto(origin + "/ui/#/settings");
      const card = page.locator(".autostart-card");
      await card.waitFor();
      await idle(page);
      const toggle = card.getByRole("switch");
      assert.equal(await toggle.getAttribute("aria-checked"), "false");

      let release!: () => void;
      let started!: () => void;
      pending = new Promise((resolve) => { release = resolve; });
      const start = new Promise<void>((resolve) => { started = resolve; });
      entered = started;
      const response = page.waitForResponse((res) =>
        res.url().endsWith("/sash/autostart") && res.request().method() === "PUT",
      );
      void response.catch(() => undefined);
      await toggle.click();
      await start;
      assert.equal(await toggle.getAttribute("aria-checked"), "false");
      assert.equal(await toggle.isDisabled(), true);
      release();
      assert.equal((await response).status(), 200);
      pending = undefined;
      entered = undefined;
      await idle(page);
      assert.equal(await toggle.getAttribute("aria-checked"), "true");
      results.push(name + ": only confirmed writes change the switch");

      failWrite = true;
      const failed = page.waitForResponse((res) =>
        res.url().endsWith("/sash/autostart") && res.request().method() === "PUT",
      );
      void failed.catch(() => undefined);
      await toggle.click();
      assert.equal((await failed).status(), 500);
      await idle(page);
      assert.equal(await toggle.getAttribute("aria-checked"), "true");
      failWrite = false;
      results.push(name + ": failed write re-reads the committed OS state");

      state = { state: "disabled", canEnable: true, reason: null };
      await card.getByRole("button", { name: "刷新状态" }).click();
      await idle(page);
      assert.equal(await toggle.getAttribute("aria-checked"), "false");
      assert.match(await card.innerText(), /已被操作系统禁用/);
      await toggle.click();
      await idle(page);
      assert.equal(await toggle.getAttribute("aria-checked"), "true");
      results.push(name + ": OS-disabled entries can be repaired");

      state = { state: "unknown", canEnable: false, reason: "Simulated inspection failure" };
      await card.getByRole("button", { name: "刷新状态" }).click();
      await idle(page);
      assert.equal(await toggle.isDisabled(), true);
      await card.getByRole("button", { name: "移除启动项" }).click();
      await idle(page);
      assert.equal(await toggle.getAttribute("aria-checked"), "false");
      results.push(name + ": explicit removal remains available after inspection failure");

      state = { state: "off", canEnable: false, reason: "Autostart requires a direct global installation. Install with npm install -g @astralyn/sash." };
      const beforeBlocked = writes;
      await card.getByRole("button", { name: "刷新状态" }).click();
      await idle(page);
      assert.equal(await toggle.isDisabled(), true);
      assert.equal(writes, beforeBlocked);
      results.push(name + ": source installs show a reason and cannot enable startup");

      for (const locale of ["zh", "en"]) {
        await page.evaluate((value) => localStorage.setItem("sash.locale", value), locale);
        await page.reload();
        await idle(page);
        for (const width of [1440, 820, 390]) {
          await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
          for (const theme of ["light", "dark"]) {
            await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
            await capture(page, name + "-settings-" + locale + "-" + width + "-" + theme);
          }
        }
      }
      await page.close();
    } catch (error) {
      await captureFailurePages(browser, output, name);
      throw error;
    } finally {
      await browser.close();
    }
  }
  assert.equal(await readFile(h.layout.settingsFile, "utf8"), settingsBefore);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ output, checks: results.length, results }, null, 2));
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify({ results, errors }, null, 2));
  assert.ok(h.layout.root.startsWith(join(tmpdir(), "sash-daemon-test-")));
  await h.cleanup();
  console.log("Artifacts: " + output);
}
