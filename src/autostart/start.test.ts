import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { sashLayout } from "../paths.js";
import { runSanitizedCommandAsync } from "../process.js";
import { testAutostartContext } from "../testing/autostart-context.js";
import { readLoginStartRecord } from "./login-record.js";
import { startAtLogin } from "./start.js";

const noSleep = async () => undefined;

describe("login startup diagnostics", () => {
  it("records success and failure without replacing the original error", async (t) => {
    const { ctx } = testAutostartContext(t, process.platform);
    const layout = sashLayout(ctx.dataDir);
    await startAtLogin(layout, async () => ({ pid: 23456 }), noSleep);
    const failure = new Error("first line\nsecond line");
    let attempts = 0;
    await assert.rejects(
      startAtLogin(
        layout,
        async () => {
          attempts += 1;
          throw failure;
        },
        noSleep,
      ),
      (error) => error === failure,
    );
    assert.equal(attempts, 4, "initial attempt plus three backoff retries");
    const log = fs.readFileSync(layout.sashLogFile, "utf8");
    assert.match(log, /login start ok pid=23456/);
    assert.match(log, /login start failed \(first line second line\); retrying in 10s/);
    assert.match(log, /login start failed: first line second line/);
    assert.equal(log.trim().split("\n").length, 7);
    if (process.platform !== "win32")
      assert.equal(fs.statSync(layout.sashLogFile).mode & 0o777, 0o600);

    const record = readLoginStartRecord(layout);
    assert.equal(record?.ok, false);
    assert.equal(record?.attempts, 4);
    assert.equal(record?.error, "first line\nsecond line");
  });

  it("retries an early boot failure and records the eventual success", async (t) => {
    const { ctx } = testAutostartContext(t, process.platform);
    const layout = sashLayout(ctx.dataDir);
    const delays: number[] = [];
    let attempts = 0;
    const result = await startAtLogin(
      layout,
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("network is not ready");
        return { pid: 23456 };
      },
      async (ms) => {
        delays.push(ms);
      },
    );
    assert.equal(result.pid, 23456);
    assert.deepEqual(delays, [10_000, 20_000]);
    const record = readLoginStartRecord(layout);
    assert.equal(record?.ok, true);
    assert.equal(record?.attempts, 3);
  });

  it("reads a missing or damaged login start record as absent", async (t) => {
    const { ctx } = testAutostartContext(t, process.platform);
    const layout = sashLayout(ctx.dataDir);
    assert.equal(readLoginStartRecord(layout), undefined);
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(layout.loginStartFile, "{broken");
    assert.equal(readLoginStartRecord(layout), undefined);
    fs.writeFileSync(layout.loginStartFile, JSON.stringify({ at: 1, ok: "yes" }));
    assert.equal(readLoginStartRecord(layout), undefined);
  });

  it("makes a settings parse failure visible through sash logs --startup", async (t) => {
    const { ctx } = testAutostartContext(t, process.platform);
    const layout = sashLayout(ctx.dataDir);
    fs.mkdirSync(layout.root, { recursive: true });
    fs.writeFileSync(layout.settingsFile, "{broken");
    await assert.rejects(startAtLogin(layout, undefined, noSleep));
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
    await startAtLogin(layout, async () => ({ pid: 23456 }), noSleep);
    assert.equal(fs.statSync(`${layout.sashLogFile}.1`).size, 1024 * 1024);
    assert.ok(fs.statSync(layout.sashLogFile).size < 1000);
  });
});
