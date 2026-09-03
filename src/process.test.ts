import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
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
  runSanitizedCommandAsync,
  TAIL_FILE_CHUNK_BYTES,
  tailFile,
  withPrivateAppendLogFds,
  writePidRecord,
} from "./process.js";

describe("process utilities", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-process-test-"));
  });

  afterEach(() => {
    mock.restoreAll();
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

    it("executes async helper children with the same sanitized environment", async () => {
      const output = await runSanitizedCommandAsync(
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
      assert.equal(
        await runSanitizedCommandAsync(
          process.execPath,
          ["-e", "process.stdout.write('discarded')"],
          { stdio: "ignore" },
        ),
        "",
      );
    });

    it("does not block the event loop while an async helper is running", async () => {
      let eventLoopAdvanced = false;
      const pending = runSanitizedCommandAsync(process.execPath, [
        "-e",
        "setTimeout(() => process.stdout.write('done'), 50)",
      ]);
      await new Promise<void>((resolve) => {
        setImmediate(() => {
          eventLoopAdvanced = true;
          resolve();
        });
      });

      assert.equal(eventLoopAdvanced, true);
      assert.equal(await pending, "done");
    });

    it("rejects non-zero exits, timeouts, and maxBuffer overflow", async () => {
      await assert.rejects(() =>
        runSanitizedCommandAsync(process.execPath, ["-e", "process.exit(7)"]),
      );
      await assert.rejects(() =>
        runSanitizedCommandAsync(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
          timeoutMs: 20,
        }),
      );
      await assert.rejects(() =>
        runSanitizedCommandAsync(
          process.execPath,
          ["-e", "process.stdout.write('x'.repeat(1024))"],
          {
            maxBuffer: 16,
          },
        ),
      );
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

  describe("private append log descriptors", () => {
    it("appends without truncating and restricts POSIX permissions", () => {
      const stdout = path.join(tmpDir, "stdout.log");
      const stderr = path.join(tmpDir, "stderr.log");
      fs.writeFileSync(stdout, "old stdout\n");
      fs.writeFileSync(stderr, "old stderr\n");
      if (process.platform !== "win32") {
        fs.chmodSync(stdout, 0o666);
        fs.chmodSync(stderr, 0o666);
      }

      const descriptors = withPrivateAppendLogFds(stdout, stderr, ({ stdoutFd, stderrFd }) => {
        fs.writeSync(stdoutFd, "new stdout\n");
        fs.writeSync(stderrFd, "new stderr\n");
        return [stdoutFd, stderrFd] as const;
      });

      assert.equal(fs.readFileSync(stdout, "utf8"), "old stdout\nnew stdout\n");
      assert.equal(fs.readFileSync(stderr, "utf8"), "old stderr\nnew stderr\n");
      for (const fd of descriptors) {
        assert.throws(
          () => fs.fstatSync(fd),
          (err: unknown) => (err as NodeJS.ErrnoException).code === "EBADF",
        );
      }
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(stdout).mode & 0o777, 0o600);
        assert.equal(fs.statSync(stderr).mode & 0o777, 0o600);
      }
    });

    it("rejects directories and symlinks as log paths", () => {
      const directory = path.join(tmpDir, "directory.log");
      const stderr = path.join(tmpDir, "stderr.log");
      fs.mkdirSync(directory);
      assert.throws(
        () => withPrivateAppendLogFds(directory, stderr, () => undefined),
        /non-regular log file/,
      );

      const target = path.join(tmpDir, "target.log");
      const link = path.join(tmpDir, "linked.log");
      fs.writeFileSync(target, "do not append here");
      try {
        fs.symlinkSync(target, link, "file");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") return;
        throw err;
      }
      assert.throws(
        () => withPrivateAppendLogFds(link, stderr, () => undefined),
        /non-regular log file/,
      );
      assert.equal(fs.readFileSync(target, "utf8"), "do not append here");
    });

    it("closes stdout when opening stderr fails", () => {
      const stdout = path.join(tmpDir, "stdout.log");
      const stderr = path.join(tmpDir, "stderr.log");
      fs.writeFileSync(stdout, "");
      fs.writeFileSync(stderr, "");
      const originalOpenSync = fs.openSync as unknown as (...args: unknown[]) => number;
      let calls = 0;
      let stdoutFd: number | undefined;
      mock.method(fs, "openSync", (...args: unknown[]): number => {
        calls++;
        if (calls === 1) {
          stdoutFd = originalOpenSync(...args);
          return stdoutFd;
        }
        throw Object.assign(new Error("synthetic stderr open failure"), { code: "EACCES" });
      });

      assert.throws(
        () => withPrivateAppendLogFds(stdout, stderr, () => undefined),
        /synthetic stderr open failure/,
      );
      assert.equal(calls, 2);
      assert.notEqual(stdoutFd, undefined);
      assert.throws(
        () => fs.fstatSync(stdoutFd as number),
        (err: unknown) => (err as NodeJS.ErrnoException).code === "EBADF",
      );
    });

    it("closes both descriptors without masking a callback failure", () => {
      const stdout = path.join(tmpDir, "stdout.log");
      const stderr = path.join(tmpDir, "stderr.log");
      const originalCloseSync = fs.closeSync;
      const closed: number[] = [];
      let descriptors: readonly [number, number] | undefined;
      let first = true;
      mock.method(fs, "closeSync", (fd: number): void => {
        closed.push(fd);
        originalCloseSync(fd);
        if (first) {
          first = false;
          throw new Error("synthetic first close failure");
        }
      });

      assert.throws(
        () =>
          withPrivateAppendLogFds(stdout, stderr, ({ stdoutFd, stderrFd }) => {
            descriptors = [stdoutFd, stderrFd];
            throw new Error("callback failed");
          }),
        /callback failed/,
      );
      assert.ok(descriptors);
      assert.deepEqual(closed, [...descriptors]);
      for (const fd of descriptors) {
        assert.throws(
          () => fs.fstatSync(fd),
          (err: unknown) => (err as NodeJS.ErrnoException).code === "EBADF",
        );
      }
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
