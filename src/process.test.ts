import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  binaryUnlockProbePath,
  buildSanitizedEnv,
  clearPidRecord,
  findExecutableOnPath,
  isProcessAlive,
  killProcessGracefully,
  readPidRecord,
  recoverBinaryUnlockProbe,
  runSanitizedCommand,
  TAIL_FILE_CHUNK_BYTES,
  tailFile,
  writePidRecord,
} from "./process.js";

describe("process utilities", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-process-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  describe("isProcessAlive", () => {
    it("reports true for the current process", () => {
      assert.equal(isProcessAlive(process.pid), true);
    });

    it("reports false for non-positive or invalid pids", () => {
      assert.equal(isProcessAlive(0), false);
      assert.equal(isProcessAlive(-1), false);
      assert.equal(isProcessAlive(Number.NaN), false);
    });
  });

  describe("killProcessGracefully", () => {
    it("refuses to signal a process whose identity is not verified", async () => {
      const stopped = await killProcessGracefully(process.pid, {
        timeoutMs: 100,
        verify: () => "mismatch",
      });

      assert.equal(stopped, false);
      assert.equal(isProcessAlive(process.pid), true);
    });

    it("revalidates identity before escalating to a force signal", async () => {
      let identityChecks = 0;
      const signals: boolean[] = [];
      const stopped = await killProcessGracefully(1234, {
        timeoutMs: 2,
        verify: () => (++identityChecks === 1 ? "match" : "mismatch"),
        isAliveFn: () => true,
        signalFn: async (_pid, force) => {
          signals.push(force);
          return true;
        },
        sleepFn: async () => undefined,
      });

      assert.equal(stopped, false);
      assert.ok(identityChecks >= 2);
      assert.deepEqual(signals, [false]);
    });
  });

  describe("buildSanitizedEnv", () => {
    it("strips sensitive tokens and npm auth configuration", () => {
      const source: NodeJS.ProcessEnv = {
        PATH: "/usr/bin",
        GITHUB_TOKEN: "ghp_secret",
        GH_TOKEN: "ghp_secret2",
        npm_config__auth: "secret3",
        NPM_CONFIG_AUTHTOKEN: "secret4",
        npm_config_userconfig: "/tmp/credentialed-npmrc",
        NPM_CONFIG_PASSWORD: "secret5",
        SAFE_VAR: "keep",
      };
      const sanitized = buildSanitizedEnv(source);
      assert.equal(sanitized.PATH, "/usr/bin");
      assert.equal(sanitized.SAFE_VAR, "keep");
      assert.equal(sanitized.GITHUB_TOKEN, undefined);
      assert.equal(sanitized.GH_TOKEN, undefined);
      assert.equal(sanitized.npm_config__auth, undefined);
      assert.equal(sanitized.NPM_CONFIG_AUTHTOKEN, undefined);
      assert.equal(sanitized.npm_config_userconfig, undefined);
      assert.equal(sanitized.NPM_CONFIG_PASSWORD, undefined);
    });

    it("executes helper children with the sanitized environment", () => {
      const output = runSanitizedCommand(
        process.execPath,
        [
          "-e",
          "process.stdout.write(JSON.stringify({ github: process.env.GITHUB_TOKEN, npm: process.env.NPM_TOKEN, userconfig: process.env.npm_config_userconfig, safe: process.env.SAFE_VAR }))",
        ],
        {
          sourceEnv: {
            ...process.env,
            GITHUB_TOKEN: "github-secret",
            NPM_TOKEN: "npm-secret",
            npm_config_userconfig: "/tmp/private-npmrc",
            SAFE_VAR: "visible",
          },
        },
      );

      assert.deepEqual(JSON.parse(output), { safe: "visible" });
    });

    it("resolves helpers only from absolute PATH entries", () => {
      const executableName = process.platform === "win32" ? "sash-helper.exe" : "sash-helper";
      const executable = path.join(tmpDir, executableName);
      fs.writeFileSync(executable, "helper");
      fs.chmodSync(executable, 0o755);

      assert.equal(
        findExecutableOnPath(executableName, {
          PATH: `relative${path.delimiter}${tmpDir}`,
        }),
        executable,
      );
      assert.equal(findExecutableOnPath("missing-helper", { PATH: tmpDir }), undefined);
    });
  });

  describe("binary unlock probe recovery", () => {
    it("restores the only binary stranded under the probe name", () => {
      const target = path.join(tmpDir, "core.exe");
      const probe = binaryUnlockProbePath(target);
      fs.writeFileSync(probe, "core-bytes");

      recoverBinaryUnlockProbe(target);

      assert.equal(fs.readFileSync(target, "utf8"), "core-bytes");
      assert.equal(fs.existsSync(probe), false);
    });

    it("removes an identical duplicate probe", () => {
      const target = path.join(tmpDir, "core.exe");
      const probe = binaryUnlockProbePath(target);
      fs.writeFileSync(target, "same-core");
      fs.writeFileSync(probe, "same-core");

      recoverBinaryUnlockProbe(target);

      assert.equal(fs.readFileSync(target, "utf8"), "same-core");
      assert.equal(fs.existsSync(probe), false);
    });

    it("preserves and rejects conflicting target and probe files", () => {
      const target = path.join(tmpDir, "core.exe");
      const probe = binaryUnlockProbePath(target);
      fs.writeFileSync(target, "current-core");
      fs.writeFileSync(probe, "different-core");

      assert.throws(() => recoverBinaryUnlockProbe(target), /both exist with different content/);
      assert.equal(fs.readFileSync(target, "utf8"), "current-core");
      assert.equal(fs.readFileSync(probe, "utf8"), "different-core");
    });
  });

  describe("PID records", () => {
    it("writes and reads PID records accurately", () => {
      const pidFile = path.join(tmpDir, "test.pid");
      assert.equal(readPidRecord(pidFile), undefined);

      writePidRecord(pidFile, {
        pid: 12345,
        exe: "/bin/test",
        startedAt: "2026-08-31T00:00:00.000Z",
      });

      const read = readPidRecord(pidFile);
      assert.ok(read);
      assert.equal(read.pid, 12345);
      assert.equal(read.exe, "/bin/test");

      clearPidRecord(pidFile);
      assert.equal(readPidRecord(pidFile), undefined);
    });

    it("ignores malformed PID files without throwing", () => {
      const pidFile = path.join(tmpDir, "corrupt.pid");
      fs.writeFileSync(pidFile, "not json");
      assert.equal(readPidRecord(pidFile), undefined);
    });
  });

  describe("tailFile", () => {
    it("returns the last N non-empty lines", () => {
      const file = path.join(tmpDir, "sample.log");
      fs.writeFileSync(file, "line 1\nline 2\n\nline 3\nline 4\n");
      const tail = tailFile(file, 2);
      assert.equal(tail, "line 3\nline 4");
    });

    it("returns empty string when file does not exist", () => {
      assert.equal(tailFile(path.join(tmpDir, "missing.log")), "");
    });

    it("finds the end of a large log without requiring a whole-file buffer", () => {
      const file = path.join(tmpDir, "large.log");
      fs.writeFileSync(file, `${"discarded\n".repeat(TAIL_FILE_CHUNK_BYTES)}last line\n`);

      assert.equal(tailFile(file, 1), "last line");
    });
  });
});
