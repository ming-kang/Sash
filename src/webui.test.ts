import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { resolveUiDir, uiInstalled } from "./webui.js";

describe("webui resolution", () => {
  it("resolves a non-empty built-in production UI without relying on workspace dist", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sash-bundled-ui-test-"));
    const runtimeDir = path.join(tempRoot, "package", "dist");
    const builtInUi = path.join(runtimeDir, "ui");
    try {
      fs.mkdirSync(path.join(builtInUi, "assets"), { recursive: true });
      fs.writeFileSync(path.join(builtInUi, "index.html"), "<html>built in</html>");
      fs.writeFileSync(path.join(builtInUi, "assets", "app.js"), "console.log('built in')");

      assert.equal(resolveUiDir(runtimeDir), builtInUi);
      assert.equal(uiInstalled(runtimeDir), true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("falls back to dist/ui when running from a source checkout", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sash-source-ui-test-"));
    const runtimeDir = path.join(tempRoot, "src");
    const distUi = path.join(tempRoot, "dist", "ui");
    try {
      fs.mkdirSync(runtimeDir, { recursive: true });
      assert.equal(resolveUiDir(runtimeDir), null);
      assert.equal(uiInstalled(runtimeDir), false);

      fs.mkdirSync(distUi, { recursive: true });
      fs.writeFileSync(path.join(distUi, "index.html"), "<html>source</html>");
      assert.equal(resolveUiDir(runtimeDir), distUi);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
