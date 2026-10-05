import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { runSanitizedCommandAsync } from "./process.js";

it("documents every command without starting Sash or initializing application state", async (t) => {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "sash-help-copy-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const commands = [
    [],
    ...[
      "start",
      "stop",
      "restart",
      "auto",
      "status",
      "doctor",
      "profile",
      "proxy",
      "mode",
      "logs",
      "update",
      "upgrade",
      "web",
      "version",
    ].map((command) => [command]),
    ...["list", "use", "add", "update", "rename", "remove"].map((command) => ["profile", command]),
  ];
  const outputs = new Map<string, string>();
  for (const command of commands) {
    const output = await runSanitizedCommandAsync(
      process.execPath,
      ["--import", "tsx", path.resolve("src/cli.ts"), ...command, "--help"],
      {
        timeoutMs: 15_000,
        sourceEnv: {
          ...process.env,
          SASH_HOME: path.join(root, "data"),
          LOCALAPPDATA: path.join(root, "local"),
        },
      },
    );
    outputs.set(command.join(" "), output);
    assert.match(output, /Usage: sash/);
    assert.ok(!output.includes("[sash]"));
  }
  assert.match(outputs.get("status") ?? "", /--verbose/);
  assert.match(outputs.get("restart") ?? "", /Reload Core when possible/);
  assert.match(outputs.get("profile") ?? "", /Changes to the selected profile are applied/);
  assert.match(outputs.get("web") ?? "", /without opening or authorizing/);
  assert.match(outputs.get("") ?? "", /-v, --version/);
  assert.ok(!(outputs.get("") ?? "").includes("SASH_DEBUG"));
  assert.deepEqual(fs.readdirSync(root), []);
});
