import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { runSanitizedCommandAsync } from "../process.js";
import { testAutostartContext } from "../testing/autostart-context.js";
import { type AutoController, runAuto } from "./auto.js";

describe("sash auto", () => {
  it("reports management startup before a failing write and keeps JSON output structured", async (t) => {
    const logs: string[] = [];
    t.mock.method(console, "log", (...args: unknown[]) => logs.push(args.map(String).join(" ")));
    const controller: AutoController = {
      inspect: async () => ({ state: "off", canEnable: true, reason: null }),
      set: async (_enabled, onStarted) => {
        onStarted?.();
        throw new Error("registration failed");
      },
    };
    await assert.rejects(runAuto("on", controller), /registration failed/);
    assert.ok(logs.some((line) => /Starting Sash to change the login startup entry/.test(line)));
    let output = "";
    t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    });
    logs.length = 0;
    await runAuto("status", controller, { json: true });
    assert.deepEqual(JSON.parse(output), { state: "off", canEnable: true, reason: null });
    assert.deepEqual(logs, []);
  });
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
