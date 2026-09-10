import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { windowsSystemExecutable } from "../process.js";
import { testAutostartContext } from "../testing/autostart-context.js";
import { requireCommandSuccess, runAutostartCommand } from "./command.js";
import { windowsLauncherContents } from "./windows.js";

it("runs the real Windows hidden launcher with Unicode, spaces and literal percent paths", {
  skip: process.platform !== "win32",
}, async (t) => {
  const { root, ctx } = testAutostartContext(t, "win32");
  const directory = path.join(root, "中文 & %SASH_EXPAND_ME%");
  fs.mkdirSync(directory);
  const entry = path.join(directory, "probe.mjs");
  const output = path.join(root, "probe-result.json");
  fs.writeFileSync(
    entry,
    [
      'import fs from "node:fs";',
      `fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({`,
      "home: process.env.SASH_HOME, github: process.env.GITHUB_TOKEN, npm: process.env.NPM_TOKEN",
      "}));",
    ].join("\n"),
  );
  const vbs = path.join(root, "probe.vbs");
  fs.writeFileSync(vbs, windowsLauncherContents(process.execPath, entry, ctx.dataDir));
  requireCommandSuccess(
    await runAutostartCommand(windowsSystemExecutable("cscript.exe"), ["//B", "//Nologo", vbs], {
      ...process.env,
      SASH_HOME: root,
      SASH_EXPAND_ME: "wrong-path",
      GITHUB_TOKEN: "test-secret",
      NPM_TOKEN: "test-secret",
    }),
  );
  const deadline = Date.now() + 8000;
  while (!fs.existsSync(output) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(fs.existsSync(output), "The hidden launcher must run the exact probe entry");
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), { home: ctx.dataDir });
});
