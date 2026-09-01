import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { sashLayout } from "../paths.js";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../settings.js";
import { disableProxyOffline } from "./proxy.js";

describe("offline system proxy cleanup", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-proxy-command-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists desired=false before disabling the OS proxy", async () => {
    const layout = sashLayout(tmpDir);
    const settings = { ...DEFAULT_SETTINGS, systemProxy: true };
    saveSettings(settings, layout);
    let persistedBeforeDisable = false;

    await disableProxyOffline({ layout, settings }, async () => {
      persistedBeforeDisable = loadSettings(layout).systemProxy === false;
    });

    assert.equal(persistedBeforeDisable, true);
    assert.equal(loadSettings(layout).systemProxy, false);
  });
});
