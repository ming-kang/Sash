import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { sashLayout } from "../paths.js";
import { runSanitizedCommandAsync } from "../process.js";
import { testAutostartContext } from "../testing/autostart-context.js";
import { startAtLogin } from "./start.js";

describe("login startup diagnostics", () => {
  it("records success and failure without replacing the original error", async (t) => {
    const { ctx } = testAutostartContext(t, process.platform);
    const layout = sashLayout(ctx.dataDir);
    await startAtLogin(layout, async () => ({ pid: 23456 }));
    const failure = new Error("first line\nsecond line");
    await assert.rejects(
      startAtLogin(layout, async () => {
        throw failure;
      }),
      (error) => error === failure,
    );
    const log = fs.readFileSync(layout.sashLogFile, "utf8");
    assert.match(log, /login start ok pid=23456/);
    assert.match(log, /login start failed: first line second line/);
    assert.equal(log.trim().split("\n").length, 4);
    if (process.platform !== "win32")
      assert.equal(fs.statSync(layout.sashLogFile).mode & 0o777, 0o600);
  });

  it("makes a settings parse failure visible through sash logs --startup", async (t) => {
    const { ctx } = testAutostartContext(t, process.platform);
    const layout = sashLayout(ctx.dataDir);
    fs.mkdirSync(layout.root, { recursive: true });
    fs.writeFileSync(layout.settingsFile, "{broken");
    await assert.rejects(startAtLogin(layout));
    const output = await runSanitizedCommandAsync(
      process.execPath,
      ["--import", "tsx", path.resolve("src/cli.ts"), "logs", "--startup"],
      { timeoutMs: 15_000, sourceEnv: { ...process.env, SASH_HOME: layout.root } },
    );
    assert.match(output, /login start failed:/);
    assert.match(output, /sash.json/);
  });

  it("rotates a large private log without leaving multiple generations", async (t) => {
    const { ctx } = testAutostartContext(t, process.platform);
    const layout = sashLayout(ctx.dataDir);
    fs.mkdirSync(layout.logsDir, { recursive: true });
    fs.writeFileSync(layout.sashLogFile, "x".repeat(1024 * 1024));
    await startAtLogin(layout, async () => ({ pid: 23456 }));
    assert.equal(fs.statSync(`${layout.sashLogFile}.1`).size, 1024 * 1024);
    assert.ok(fs.statSync(layout.sashLogFile).size < 1000);
  });
});
