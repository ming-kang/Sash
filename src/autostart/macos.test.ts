import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { launchAgentContents, macAutostart } from "./macos.js";
import { testAutostartContext } from "./test-context.test.js";

describe("macOS login startup", () => {
  it("uses an enabled LaunchAgent without bootstrapping or stopping the running instance", async (t) => {
    let disabled = "false";
    const calls: string[][] = [];
    const { ctx } = testAutostartContext(t, "darwin", async (command, args) => {
      assert.equal(command, "/bin/launchctl");
      calls.push(args);
      if (args[0] === "enable") disabled = "false";
      return {
        code: 0,
        stdout: `disabled services = { "com.astralyn.sash" => ${disabled} }`,
        stderr: "",
      };
    });
    const backend = macAutostart(ctx);
    assert.equal(await backend.inspect(), "off");
    await backend.set(true);
    assert.equal(await backend.inspect(), "on");
    const file = path.join(ctx.homedir, "Library", "LaunchAgents", "com.astralyn.sash.plist");
    assert.ok(fs.readFileSync(file, "utf8").includes(ctx.dataDir));
    disabled = "true";
    assert.equal(await backend.inspect(), "disabled");
    disabled = "unexpected";
    assert.equal(await backend.inspect(), "disabled");
    await backend.set(true);
    assert.equal(await backend.inspect(), "on");
    fs.writeFileSync(file, "previous launcher");
    assert.equal(await backend.inspect(), "stale");
    await backend.set(false);
    assert.equal(await backend.inspect(), "off");
    assert.ok(calls.every(([action]) => ["enable", "print-disabled"].includes(action ?? "")));
  });

  it("preserves an old plist if launchctl cannot enable the replacement", async (t) => {
    const { ctx } = testAutostartContext(t, "darwin", async (_command, args) =>
      args[0] === "print-disabled"
        ? { code: 0, stdout: "disabled services = {}", stderr: "" }
        : { code: 1, stdout: "", stderr: "launchctl denied" },
    );
    const file = path.join(ctx.homedir, "Library", "LaunchAgents", "com.astralyn.sash.plist");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "old plist");
    await assert.rejects(macAutostart(ctx).set(true), /launchctl denied/);
    assert.equal(fs.readFileSync(file, "utf8"), "old plist");
  });

  it("escapes XML paths and rejects line injection", () => {
    const plist = launchAgentContents("/node&a", "/entry<path>.js", "/data & <space>");
    assert.match(plist, /node&amp;a/);
    assert.match(plist, /entry&lt;path&gt;/);
    assert.match(plist, /AbandonProcessGroup/);
    assert.throws(() => launchAgentContents("/node", "/entry", "/data\nbad"));
  });
});
