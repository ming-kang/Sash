import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { sashLayout } from "./paths.js";
import { resolveUiDir, uiInstalled } from "./webui.js";

describe("webui resolution", () => {
  it("resolves built-in UI directory if dist/ui exists", () => {
    const dir = resolveUiDir();
    // In build/test environment dist/ui should be found
    if (dir) {
      assert.equal(fs.existsSync(path.join(dir, "index.html")), true);
      assert.equal(uiInstalled(), true);
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
