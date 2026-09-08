import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { linuxAutostart, systemdUnitContents } from "./linux.js";
import { testAutostartContext } from "./test-context.test.js";

describe("systemd user startup", () => {
  it("enables the current data directory without starting or stopping a service", async (t) => {
    let state = "disabled";
    const calls: string[][] = [];
    const { ctx } = testAutostartContext(t, "linux", async (_command, args) => {
      assert.equal(args[0], "--user");
      calls.push(args);
      if (args[1] === "enable") state = "enabled";
      if (args[1] === "disable") state = "disabled";
      return {
        code: state === "enabled" || args[1] !== "is-enabled" ? 0 : 1,
        stdout: state,
        stderr: "",
      };
    });
    const backend = linuxAutostart(ctx);
    const file = path.join(ctx.configHome, "systemd", "user", "sash.service");
    assert.equal(await backend.inspect(), "off");
    await backend.set(true);
    assert.equal(await backend.inspect(), "on");
    assert.ok(fs.readFileSync(file, "utf8").includes(ctx.dataDir.replaceAll("\\", "\\\\")));
    for (const value of ["masked", "enabled-runtime", "disabled", "linked"]) {
      state = value;
      assert.equal(await backend.inspect(), "disabled");
    }
    state = "enabled";
    fs.writeFileSync(file, "old unit");
    assert.equal(await backend.inspect(), "stale");
    await backend.set(true);
    await backend.set(false);
    assert.equal(await backend.inspect(), "off");
    assert.equal(fs.existsSync(file), false);
    assert.ok(calls.every((args) => !args.some((arg) => ["start", "stop", "--now"].includes(arg))));
  });

  it("restores the previous unit and enablement when a repair fails", async (t) => {
    let enables = 0;
    const { ctx } = testAutostartContext(t, "linux", async (_command, args) => {
      if (args[1] === "enable" && ++enables === 1) {
        return { code: 1, stdout: "", stderr: "enable failed" };
      }
      return { code: 0, stdout: "enabled", stderr: "" };
    });
    const file = path.join(ctx.configHome, "systemd", "user", "sash.service");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "previous unit");
    await assert.rejects(linuxAutostart(ctx).set(true), /enable failed/);
    assert.equal(fs.readFileSync(file, "utf8"), "previous unit");
    assert.equal(enables, 2);
  });

  it("escapes systemd specifiers, variable expansion, quotes and backslashes", () => {
    const unit = systemdUnitContents('/a $X%f\\"/node', "/b/%u/$entry", '/home/a"$USER%h\\data');
    assert.ok(unit.includes('ExecStart="/a $$X%%f\\\\\\"/node" "/b/%%u/$$entry"'));
    assert.ok(unit.includes('Environment="SASH_HOME=/home/a\\"$USER%%h\\\\data"'));
    assert.match(unit, /RemainAfterExit=yes/);
    assert.match(unit, /KillMode=process/);
    assert.throws(() => systemdUnitContents("/node", "/entry\nExecStart=bad", "/home"));
  });
});
