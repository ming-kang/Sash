import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { testAutostartContext } from "../autostart/test-context.test.js";
import { runSanitizedCommandAsync } from "../process.js";
import { runAuto } from "./auto.js";

describe("sash auto", () => {
  it("does not inspect state before explicit off and keeps status read-only", async (t) => {
    t.mock.method(console, "log", () => {});
    const writes: boolean[] = [];
    const controller = {
      inspect: async () => ({ state: "off" as const, canEnable: true, reason: null }),
      set: async (enabled: boolean) => {
        writes.push(enabled);
        return { state: "off" as const, canEnable: true, reason: null };
      },
    };
    const inspect = t.mock.method(controller, "inspect");
    await runAuto("off", controller);
    assert.equal(inspect.mock.callCount(), 0);
    await runAuto("status", controller);
    assert.equal(inspect.mock.callCount(), 1);
    await runAuto(undefined, controller);
    assert.deepEqual(writes, [false]);
    assert.equal(inspect.mock.callCount(), 2);
  });

  it("renders command help without creating any autostart registration", async (t) => {
    const { ctx } = testAutostartContext(t, process.platform);
    const output = await runSanitizedCommandAsync(
      process.execPath,
      ["--import", "tsx", path.resolve("src/cli.ts"), "auto", "--help"],
      { timeoutMs: 15_000, sourceEnv: { ...process.env, SASH_HOME: ctx.dataDir } },
    );
    assert.match(output, /Usage: sash auto/);
    assert.match(output, /on.*off.*status/s);
    assert.equal(fs.existsSync(ctx.controlDir), false);
  });
});
