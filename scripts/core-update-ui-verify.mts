import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-core-update-ui-"));
      const exe = path.join(dir, "candidate");
      fs.writeFileSync(exe, "fake-core");
      return { exe, dir, version: "v9.9.9", assetName: "mihomo-windows-amd64-v9.9.9.zip" };
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
  const started = uiLocale === "zh" ? "启动核心" : "Start Core";
  /** The right edge of one row of the header controls. */
  const rightEdge = async (selector: string) => {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) throw new Error(`missing ${selector}`);
    return Math.round(box.x + box.width);
  };
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
    await page.goto(`${base}#/overview`);
    const stop = ".page-head-actions .core-controls > .btn-danger-outline";
    const controlsRight = await rightEdge(stop);
    await page.locator(".page-head-actions").getByRole("button", { name: started, exact: true }).click();

    const progress = page.locator(".core-update-progress").first();
    await progress.waitFor();
    const expected =
      uiLocale === "zh"
        ? "正在下载核心 (v9.9.9): 5.0 / 10.0 MiB 取消下载"
        : "Downloading Core (v9.9.9): 5.0 / 10.0 MiB Cancel download";
    // The row is one flex line, so innerText separates its items by a newline.
    assert.equal((await progress.innerText()).replace(/\s+/g, " ").trim(), expected);
    await page.screenshot({ path: path.join(outDir, `${name}-${uiLocale}-core-update.png`) });

    // The progress row must not move the controls: both rows keep the right edge.
    assert.equal(await rightEdge(stop), controlsRight, "the controls stay where they were");
    assert.equal(
      await rightEdge(".page-head-actions .core-update-progress button"),
      controlsRight,
      "the cancel button lines up with the controls",
    );
    const controls = await page.locator(".page-head-actions .core-controls").boundingBox();
    const row = await page.locator(".page-head-actions .core-update-progress").boundingBox();
    assert.ok(controls && row && row.y > controls.y, "the progress row sits below the controls");
    await page.screenshot({ path: path.join(outDir, `${name}-${uiLocale}-core-update-header.png`) });

    release.resolve();
    await progress.waitFor({ state: "hidden", timeout: 15_000 });
    await page
      .getByRole("button", { name: uiLocale === "zh" ? "应用配置" : "Apply configuration", exact: true })
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
