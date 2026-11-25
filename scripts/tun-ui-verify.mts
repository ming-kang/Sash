// Run after `npm run build:ui`.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { DaemonTestHarness } from "../src/testing/daemon-harness.js";
import { type TunPrivilege, unsupportedTunPlatform } from "../src/tun-service.js";
import { captureFailurePages, launchUiBrowser, UI_ENGINES, uiArtifactDirectory } from "./ui-harness.mjs";

const output = uiArtifactDirectory("sash-tun-ui-");
const results: string[] = [];
const errors: string[] = [];
const h = new DaemonTestHarness();
h.setup();
h.settings.mixedPort = 27916;
h.settings.controller = "127.0.0.1:27917";
let privilege: TunPrivilege = { state: "missing" };
let installs = 0;
await h.startServer({
  tunPlatform: {
    ...unsupportedTunPlatform(),
    mechanism: "service",
    inspect: async () => privilege,
    install: async () => {
      installs += 1;
      privilege = { state: "ready" };
    },
  },
});
const origin = `http://127.0.0.1:${h.boundPort}`;
const STALE = "the TUN service serves another data folder (D:\\Other\\Sash)";

/** The event feed shares a cached inspection; a fresh API read refreshes it. */
async function setPrivilege(page: Page, next: TunPrivilege): Promise<void> {
  privilege = next;
  await h.apiRequest("/sash/tun");
  await page.reload();
  await page.locator(".network-toggle .toggle-link").waitFor();
}

async function openDialog(page: Page) {
  await page.locator(".network-toggle .toggle-link").click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await page.waitForTimeout(180);
  return dialog;
}

function tunSwitch(page: Page) {
  return page.locator(".network-toggle", { has: page.locator(".toggle-link") }).getByRole("switch");
}

async function resetTunState(): Promise<void> {
  await h.apiRequest("/sash/settings", {
    method: "PATCH",
    body: { tun: { enable: false, stack: "mixed", autoRoute: true, strictRoute: false } },
  });
  await h.apiRequest("/sash/core/restart", { method: "POST" });
}

async function capture(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(output, `${name}.png`), animations: "disabled" });
  results.push(name);
}

try {
  for (const { engine, name } of UI_ENGINES) {
    console.log(`Verifying ${name}`);
    await resetTunState();
    const browser = await launchUiBrowser(engine);
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() => {
        if (!localStorage.getItem("sash.locale")) localStorage.setItem("sash.locale", "zh");
      });
      await page.goto(`${origin}/ui/#/overview`);
      await setPrivilege(page, { state: "missing" });

      assert.equal(await tunSwitch(page).isDisabled(), true);
      let dialog = await openDialog(page);
      const link = dialog.locator(".tun-status-link");
      assert.equal((await link.innerText()).trim(), "点击安装 helper");
      await capture(page, `${name}-missing`);
      const before = installs;
      await link.click();
      await dialog.locator(".tun-info-status").filter({ hasText: "TUN helper 已就绪" }).waitFor();
      assert.equal(installs, before + 1);
      await capture(page, `${name}-ready`);
      await dialog.getByRole("button", { name: "关闭" }).click();
      assert.equal(await tunSwitch(page).isDisabled(), false);
      results.push(`${name}: installing from the dialog enables the switch`);

      await tunSwitch(page).click();
      const pendingDock = page.locator(".pending-config");
      await pendingDock.waitFor();
      const applyButton = pendingDock.getByRole("button", { name: "应用配置", exact: true });
      await applyButton.hover();
      const applyTooltip = page.locator(".sash-tooltip.visible");
      await applyTooltip.waitFor();
      const tunApplyCopy = await applyTooltip.innerText();
      assert.match(tunApplyCopy, /TUN 模式/);
      assert.match(tunApplyCopy, /重启核心/);
      assert.match(tunApplyCopy, /活动连接将中断/);
      await page.getByRole("button", { name: "重启并应用", exact: true }).waitFor();
      await capture(page, `${name}-apply-tun-tooltip`);
      await applyButton.click();
      await pendingDock.waitFor({ state: "hidden" });
      results.push(`${name}: enabling TUN explains the restart cost on Apply`);

      dialog = await openDialog(page);
      await dialog.getByRole("switch", { name: "Strict Route", exact: true }).click();
      await dialog.getByRole("button", { name: "保存", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      dialog = await openDialog(page);
      await dialog
        .locator(".tun-info-status")
        .filter({ hasText: "TUN 更改已保存，应用配置后生效" })
        .waitFor();
      await capture(page, `${name}-tun-settings-pending`);
      await dialog.getByRole("button", { name: "关闭" }).click();
      results.push(`${name}: editing active TUN settings reports a pending change`);

      await setPrivilege(page, { state: "stale", detail: STALE });
      dialog = await openDialog(page);
      const stale = dialog.locator(".tun-status-link");
      assert.equal((await stale.innerText()).trim(), "点击重新安装 helper");
      await stale.hover();
      const tooltip = page.locator(".sash-tooltip.visible");
      await tooltip.waitFor();
      assert.equal((await tooltip.innerText()).trim(), STALE);
      await capture(page, `${name}-stale-tooltip`);
      results.push(`${name}: a stale helper offers reinstall and explains why`);

      await page.evaluate(() => localStorage.setItem("sash.locale", "en"));
      await page.evaluate(() => localStorage.setItem("sash.theme", "dark"));
      await page.reload();
      dialog = await openDialog(page);
      assert.equal(
        (await dialog.locator(".tun-status-link").innerText()).trim(),
        "Click to reinstall the helper",
      );
      await capture(page, `${name}-stale-en-dark`);
      results.push(`${name}: English and dark theme render the same state`);
      await page.close();
    } catch (error) {
      await captureFailurePages(browser, output, name);
      throw error;
    } finally {
      await browser.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ output, checks: results.length, results }, null, 2));
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify({ results, errors }, null, 2));
  assert.ok(h.layout.root.startsWith(join(tmpdir(), "sash-daemon-test-")));
  await h.cleanup();
  console.log(`Artifacts: ${output}`);
}
