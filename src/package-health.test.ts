import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { packageRuntimeHealth } from "./package-health.js";
import { upgradeFixture } from "./upgrade-test-fixture.test.js";

it("requires the recovery worker and every lazily referenced dashboard asset before activation", () => {
  const f = upgradeFixture();
  const dist = path.join(f.installation.packageRoot, "dist");
  const ui = path.join(dist, "ui");
  try {
    for (const file of ["daemon-entry.js", "upgrade-probe-entry.js", "upgrade-worker.LICENSE.md"])
      fs.writeFileSync(path.join(dist, file), "fixture");
    fs.mkdirSync(path.join(ui, "assets"), { recursive: true });
    fs.mkdirSync(path.join(ui, "assets", "branding"));
    fs.writeFileSync(path.join(ui, "assets", "branding", "icon.png"), "fixture");
    fs.mkdirSync(path.join(ui, ".vite"));
    const html =
      '<script src="./assets/app.js"></script><link href="./assets/app.css"><link rel="icon" href="./assets/branding/icon.png">';
    fs.writeFileSync(path.join(ui, "index.html"), html);
    for (const file of ["app.js", "app.css", "settings.js"])
      fs.writeFileSync(path.join(ui, "assets", file), "fixture");
    fs.writeFileSync(
      path.join(ui, ".vite", "manifest.json"),
      JSON.stringify({
        "index.html": {
          file: "assets/app.js",
          css: ["assets/app.css"],
          dynamicImports: ["settings"],
        },
        settings: { file: "assets/settings.js" },
      }),
    );
    assert.equal(packageRuntimeHealth(f.installation.packageRoot).ui, true);
    fs.writeFileSync(
      path.join(ui, "index.html"),
      html.replace("branding/icon.png", "../outside.png"),
    );
    assert.throws(
      () => packageRuntimeHealth(f.installation.packageRoot),
      /Invalid Sash dashboard asset/,
    );
    fs.writeFileSync(path.join(ui, "index.html"), html);
    fs.unlinkSync(path.join(ui, "assets", "settings.js"));
    assert.throws(() => packageRuntimeHealth(f.installation.packageRoot), /settings\.js/);
    fs.writeFileSync(path.join(ui, "assets", "settings.js"), "fixture");
    fs.unlinkSync(path.join(dist, "upgrade-worker.mjs"));
    assert.throws(() => packageRuntimeHealth(f.installation.packageRoot), /upgrade-worker\.mjs/);
  } finally {
    f.cleanup();
  }
});
