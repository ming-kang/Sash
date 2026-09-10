import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { buildSanitizedEnv, commandLineContains, readProcessCommandLine } from "./process.js";
import { commandLineContainsPath } from "./process-command-path.js";

it("proves aliased process arguments through the filesystem and rejects foreign programs", async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sash-command-path-")));
  const packageRoot = path.join(root, "actual package");
  const alias = path.join(root, process.platform === "win32" ? "aliased package" : "alias");
  const script = path.join(packageRoot, "dist", "daemon-entry.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "process.stdin.resume();\n");
  fs.symlinkSync(packageRoot, alias, process.platform === "win32" ? "junction" : "dir");
  const child = spawn(process.execPath, [path.join(alias, "dist", "daemon-entry.js")], {
    env: buildSanitizedEnv(),
    windowsHide: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  const closed = once(child, "close");
  try {
    await once(child, "spawn");
    assert.ok(child.pid);
    assert.equal(commandLineContains(child.pid, script), true);
    const commandLine = readProcessCommandLine(child.pid);
    assert.ok(commandLine);
    assert.equal(
      commandLineContainsPath(commandLine, path.join(alias, "dist", "daemon-entry.js")),
      true,
    );
    const other = path.join(root, "other", "daemon-entry.js");
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, "different program");
    assert.equal(commandLineContainsPath(`node "${other}"`, script), false);
    assert.equal(
      commandLineContainsPath(`node "${path.join(root, "missing", "daemon-entry.js")}"`, script),
      false,
    );
  } finally {
    child.stdin.end();
    await closed;
    assert.equal(
      path.dirname(root).toLowerCase(),
      fs.realpathSync.native(os.tmpdir()).toLowerCase(),
    );
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
