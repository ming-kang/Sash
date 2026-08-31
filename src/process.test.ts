import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  buildSanitizedEnv,
  clearPidRecord,
  isProcessAlive,
  readPidRecord,
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

  describe("buildSanitizedEnv", () => {
    it("strips sensitive tokens and npm auth configuration", () => {
      const source: NodeJS.ProcessEnv = {
        PATH: "/usr/bin",
        GITHUB_TOKEN: "ghp_secret",
        GH_TOKEN: "ghp_secret2",
        npm_config__auth: "secret3",
        NPM_CONFIG_AUTHTOKEN: "secret4",
        SAFE_VAR: "keep",
      };
      const sanitized = buildSanitizedEnv(source);
      assert.equal(sanitized.PATH, "/usr/bin");
      assert.equal(sanitized.SAFE_VAR, "keep");
      assert.equal(sanitized.GITHUB_TOKEN, undefined);
      assert.equal(sanitized.GH_TOKEN, undefined);
      assert.equal(sanitized.npm_config__auth, undefined);
      assert.equal(sanitized.NPM_CONFIG_AUTHTOKEN, undefined);
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
  });
});
