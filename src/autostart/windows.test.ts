import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { testAutostartContext } from "../testing/autostart-context.js";
import {
  type FakeWindowsRegistration,
  fakeWindowsRegistryRun,
} from "../testing/windows-registry.js";
import { windowsAutostart, windowsLauncherContents } from "./windows.js";

describe("Windows login startup", () => {
  it("registers a hidden Unicode launcher, observes OS suppression, repairs, and removes it", async (t) => {
    const registration: FakeWindowsRegistration = { command: null, approval: null };
    const { ctx } = testAutostartContext(t, "win32", fakeWindowsRegistryRun(registration));
    const backend = windowsAutostart(ctx);
    assert.equal(await backend.inspect(), "off");
    await backend.set(true);
    const file = path.join(ctx.controlDir, "start.vbs");
    const text = fs.readFileSync(file).toString("utf16le");
    assert.ok(text.startsWith("\uFEFF"));
    assert.ok(text.includes(ctx.dataDir));
    assert.match(text, /, 0, False/);
    assert.equal(await backend.inspect(), "on");
    const bytes = Buffer.alloc(12);
    bytes[0] = 3;
    registration.approval = bytes;
    assert.equal(await backend.inspect(), "disabled");
    bytes[0] = 255;
    assert.equal(await backend.inspect(), "disabled");
    registration.approval = Buffer.alloc(0);
    assert.equal(await backend.inspect(), "disabled");
    fs.writeFileSync(file, "old launcher");
    assert.equal(await backend.inspect(), "stale");
    await backend.set(true);
    assert.equal(await backend.inspect(), "on");
    await backend.set(false);
    assert.equal(await backend.inspect(), "off");
    assert.equal(fs.existsSync(file), false);
    await backend.set(false);
  });

  it("preserves a previous launcher when the registry command fails to spawn", async (t) => {
    const { ctx } = testAutostartContext(t, "win32");
    const file = path.join(ctx.controlDir, "start.vbs");
    fs.mkdirSync(ctx.controlDir, { recursive: true });
    fs.writeFileSync(file, "previous bytes");
    await assert.rejects(windowsAutostart(ctx).set(true), /Unexpected OS command/);
    assert.equal(fs.readFileSync(file, "utf8"), "previous bytes");
  });

  it("rejects malformed registry output and control-character injection", async (t) => {
    const { ctx } = testAutostartContext(t, "win32", async () => ({
      code: 0,
      stdout: "not a registry query response",
      stderr: "",
    }));
    await assert.rejects(windowsAutostart(ctx).inspect(), /Invalid Windows/);
    for (const value of ["bad\npath", "bad\rpath", "bad\u0000path", 'bad"path']) {
      assert.throws(() => windowsLauncherContents(value, "entry", "data"));
    }
    const text = windowsLauncherContents(
      "C:\\%literal%\\node.exe",
      "C:\\a&b\\entry.js",
      "C:\\数据",
    ).toString("utf16le");
    assert.match(text, /%literal%/);
    assert.match(text, /SASH_AUTOSTART_NODE/);
  });
});
