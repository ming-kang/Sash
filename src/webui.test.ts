import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { sashLayout } from "./paths.js";
import { resolveUiDir, uiInstalled } from "./webui.js";

describe("webui resolution", () => {
  it("resolves a non-empty built-in production UI without relying on workspace dist", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sash-bundled-ui-test-"));
    const layout = sashLayout(path.join(tempRoot, "data"));
    const runtimeDir = path.join(tempRoot, "package", "dist");
    const builtInUi = path.join(runtimeDir, "ui");
    try {
      fs.mkdirSync(path.join(builtInUi, "assets"), { recursive: true });
      fs.writeFileSync(path.join(builtInUi, "index.html"), "<html>built in</html>");
      fs.writeFileSync(path.join(builtInUi, "assets", "app.js"), "console.log('built in')");

      assert.equal(resolveUiDir(layout, runtimeDir), builtInUi);
      assert.equal(uiInstalled(layout, runtimeDir), true);
      assert.ok(fs.statSync(path.join(builtInUi, "index.html")).size > 0);
      assert.ok(fs.statSync(path.join(builtInUi, "assets", "app.js")).size > 0);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("recognizes custom UI override in layout.uiDir", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sash-ui-test-"));
    const layout = sashLayout(tempRoot);
    try {
      const customUi = layout.uiDir;
      fs.mkdirSync(customUi, { recursive: true });
      fs.writeFileSync(path.join(customUi, "index.html"), "<html>custom</html>");

      const resolved = resolveUiDir(layout);
      assert.equal(resolved, customUi);
      assert.equal(uiInstalled(layout), true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
