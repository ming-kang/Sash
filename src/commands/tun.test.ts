import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, onTestFinished } from "vitest";
import { runTunGuard } from "./tun.js";

function installedGuard(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-tun-command-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const scriptPath = path.join(root, "sash-tun-guard");
  fs.writeFileSync(scriptPath, "#!/bin/sh\n");
  return scriptPath;
}

describe("runTunGuard", () => {
  it("is macOS-only and requires the installed guard", async () => {
    await assert.rejects(runTunGuard("status", { platform: "linux" }), /only available on macOS/);
    await assert.rejects(
      runTunGuard("status", {
        platform: "darwin",
        scriptPath: path.join(os.tmpdir(), "sash-no-such-guard"),
      }),
      /not installed/,
    );
  });

  it("runs through passwordless sudo as an unprivileged user and propagates the exit code", async () => {
    const scriptPath = installedGuard();
    const calls: string[][] = [];
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runTunGuard("teardown", {
        platform: "darwin",
        asRoot: false,
        scriptPath,
        launch: async (cmd, args) => {
          calls.push([cmd, ...args]);
          return 7;
        },
      });
      assert.deepEqual(calls, [["/usr/bin/sudo", "-n", scriptPath, "teardown"]]);
      assert.equal(process.exitCode, 7);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("runs the guard directly as root", async () => {
    const scriptPath = installedGuard();
    const calls: string[][] = [];
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runTunGuard("status", {
        platform: "darwin",
        asRoot: true,
        scriptPath,
        launch: async (cmd, args) => {
          calls.push([cmd, ...args]);
          return 0;
        },
      });
      assert.deepEqual(calls, [[scriptPath, "status"]]);
      assert.equal(process.exitCode, undefined);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
