/** Core install progress on the dashboard while the daemon stages a binary, both locales. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { BrowserType, Page } from "playwright";
import type { WebBootstrapInfo } from "../src/contracts.js";
import { DaemonTestHarness } from "../src/testing/daemon-harness.js";
import { FakeCoreSupervisor } from "../src/testing/state.js";
import {
  captureFailurePages,
  launchUiBrowser,
  uiArtifactDirectory,
  UI_ENGINES,
} from "./ui-harness.mjs";

const outDir = uiArtifactDirectory("sash-core-update-ui-");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function verify(engine: BrowserType, name: string, uiLocale: "zh" | "en") {
  const harness = new DaemonTestHarness();
  harness.setup();
  const core = new FakeCoreSupervisor(harness.layout, harness.settings);
  const entered = deferred();
  const release = deferred();
  await harness.startServer({
    installCore: false,
    supervisor: core,
    stageCore: async (options) => {
      options?.onStage?.("downloading", "v9.9.9");
      options?.onProgress?.(5 * 1048576, 10 * 1048576);
      entered.resolve();
      await release.promise;
      fs.mkdirSync(harness.layout.tempDir, { recursive: true });
      const exe = path.join(harness.layout.tempDir, "candidate");
      fs.writeFileSync(exe, "fake-core");
      return { exe, version: "v9.9.9", assetName: "mihomo-windows-amd64-v9.9.9.zip" };
    },
    validateConfig: () => undefined,
  });
  const base = `http://127.0.0.1:${harness.boundPort}/ui/`;
  const browser = await launchUiBrowser(engine);
  const errors: string[] = [];
  const page: Page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    locale: uiLocale === "zh" ? "zh-CN" : "en-US",
  });
  try {
    page.on("pageerror", (error) => errors.push(error.message));
    if (uiLocale === "en") {
      await page.addInitScript(() => window.localStorage.setItem("sash.locale", "en"));
    }
    await page.goto(base);
    await page
      .getByRole("heading", { name: uiLocale === "zh" ? "连接到 Sash" : "Connect to Sash", exact: true })
      .waitFor();
    const boot = ((await harness.apiRequest("/sash/web/bootstrap", { method: "POST" }))
      .data as WebBootstrapInfo).token;
    await page.goto(`${base}#boot=${boot}`);
    await page.locator(".runtime-banner.unauthorized").waitFor({ state: "hidden" });
    await page.goto(`${base}#/settings`);
    const startButton = page
      .getByRole("button", {
        name: uiLocale === "zh" ? "启动核心" : "Start Core",
        exact: true,
      })
      .first();
    await startButton.waitFor();
    await startButton.click();

    const progress = page.locator(".core-update-progress").first();
    await progress.waitFor();
    const expected =
      uiLocale === "zh"
        ? "正在下载核心 (v9.9.9): 5.0 / 10.0 MiB"
        : "Downloading Core (v9.9.9): 5.0 / 10.0 MiB";
    assert.equal((await progress.innerText()).trim(), expected);
    await page.screenshot({ path: path.join(outDir, `${name}-${uiLocale}-core-update.png`) });

    release.resolve();
    await progress.waitFor({ state: "hidden", timeout: 15_000 });
    await page
      .getByRole("button", { name: uiLocale === "zh" ? "应用更改" : "Apply configuration", exact: true })
      .first()
      .waitFor();
    assert.deepEqual(errors, []);
  } catch (error) {
    await captureFailurePages(browser, outDir, `${name}-${uiLocale}`);
    throw error;
  } finally {
    release.resolve();
    await browser.close();
    await harness.cleanup();
  }
}

for (const { engine, name } of UI_ENGINES) {
  for (const uiLocale of ["zh", "en"] as const) {
    await verify(engine, name, uiLocale);
  }
}
console.log(`core update UI verified: ${outDir}`);
