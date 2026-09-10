import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import {
  type AutostartCommand,
  type AutostartOptions,
  autostartContext,
} from "../autostart/context.js";
import { sashLayout } from "../paths.js";

export function testAutostartContext(
  t: TestContext,
  platform: NodeJS.Platform,
  runCommand: AutostartCommand = async () => {
    throw new Error("Unexpected OS command");
  },
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-autostart-test-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("sash-autostart-test-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const options: AutostartOptions = {
    platform,
    homedir: path.join(root, "user"),
    layout: sashLayout(path.join(root, "data with 空间")),
    packageRoot: path.join(root, "package"),
    nodePath: process.execPath,
    env: {
      SystemRoot: path.join(root, "Windows"),
      LOCALAPPDATA: path.join(root, "local"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      GITHUB_TOKEN: "must-not-reach-helper",
      NPM_TOKEN: "must-not-reach-helper",
      npm_config_userconfig: "must-not-reach-helper",
    },
    runCommand,
  };
  const ctx = autostartContext(options);
  fs.mkdirSync(path.dirname(ctx.entryPath), { recursive: true });
  fs.writeFileSync(ctx.entryPath, "// test entry\n");
  return { root, options, ctx };
}
