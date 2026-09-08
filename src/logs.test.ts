import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runLogs } from "./commands/logs.js";
import {
  followLogFile,
  LOG_FOLLOW_CHUNK_BYTES,
  logCursorAtEnd,
  normalizeLines,
  parseLogLineCount,
  readLogGrowth,
} from "./log-follow.js";
import { sashLayout } from "./paths.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("timed out waiting for log follower output");
}

describe("log line counts", () => {
  it("reads all diagnostic logs while settings are corrupt without modifying state", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-logs-corrupt-test-"));
    const previousHome = process.env.SASH_HOME;
    process.env.SASH_HOME = root;
    const layout = sashLayout();
    const chunks: string[] = [];
    const output = t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      fs.writeFileSync(layout.settingsFile, "{ broken");
      fs.mkdirSync(layout.logsDir);
      const cases = [
        { file: layout.coreLogFile, options: {} },
        { file: layout.coreErrLogFile, options: { errors: true } },
        { file: layout.daemonLogFile, options: { daemon: true } },
        { file: layout.daemonErrLogFile, options: { daemon: true, errors: true } },
        { file: layout.sashLogFile, options: { startup: true } },
      ];
      for (const { file, options } of cases) {
        const message = `diagnostic ${path.basename(file)}`;
        fs.writeFileSync(file, `${message}\n`);
        await runLogs(options);
        assert.equal(chunks.at(-1), `${message}\n`);
      }
      assert.equal(fs.readFileSync(layout.settingsFile, "utf8"), "{ broken");
    } finally {
      output.mock.restore();
      if (previousHome === undefined) delete process.env.SASH_HOME;
      else process.env.SASH_HOME = previousHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps positive safe integers", () => {
    assert.equal(normalizeLines(1), 1);
    assert.equal(normalizeLines(50), 50);
    assert.equal(normalizeLines(9999), 9999);
    assert.equal(normalizeLines(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  });

  it("falls back for invalid normalized input", () => {
    for (const bad of [
      Number.NaN,
      0,
      -5,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      3.14,
      "100",
      null,
      undefined,
      {},
    ]) {
      assert.equal(normalizeLines(bad), 50, JSON.stringify(bad));
    }
  });

  it("honours a custom fallback", () => {
    assert.equal(normalizeLines(Number.NaN, 10), 10);
    assert.equal(normalizeLines(5, 10), 5);
  });

  it("strictly parses only canonical positive integer CLI arguments", () => {
    assert.equal(parseLogLineCount("1"), 1);
    assert.equal(parseLogLineCount("50"), 50);
    assert.equal(parseLogLineCount(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
    for (const bad of [
      "",
      "0",
      "01",
      "-1",
      "+1",
      "1.0",
      "1e2",
      "1x",
      " 1",
      "1 ",
      "Infinity",
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      assert.throws(() => parseLogLineCount(bad), /positive/);
    }
  });
});

describe("log file growth", () => {
  it("reads bounded chunks and resets on truncation and identity replacement", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-logs-growth-test-"));
    const file = path.join(root, "follow.log");
    try {
      fs.writeFileSync(file, "before\n");
      let cursor = logCursorAtEnd(file);
      const originalIdentity = cursor.identity;
      const appended = "x".repeat(LOG_FOLLOW_CHUNK_BYTES * 2 + 1);
      fs.appendFileSync(file, appended);

      const chunks: Buffer[] = [];
      let growth = readLogGrowth(file, cursor);
      while (growth.chunks.length > 0) {
        assert.ok(growth.chunks.every((chunk) => chunk.length <= LOG_FOLLOW_CHUNK_BYTES));
        chunks.push(...growth.chunks);
        cursor = growth.cursor;
        growth = readLogGrowth(file, cursor);
      }
      assert.equal(Buffer.concat(chunks).toString("utf8"), appended);

      fs.writeFileSync(file, "truncated\n");
      const truncated = readLogGrowth(file, cursor);
      assert.equal(Buffer.concat(truncated.chunks).toString("utf8"), "truncated\n");
      assert.equal(truncated.cursor.identity, originalIdentity);

      const rotatedPath = path.join(root, "follow.log.1");
      fs.renameSync(file, rotatedPath);
      fs.writeFileSync(file, "replacement\n");
      const replacement = readLogGrowth(file, truncated.cursor);
      assert.equal(Buffer.concat(replacement.chunks).toString("utf8"), "replacement\n");
      assert.notEqual(replacement.cursor.identity, originalIdentity);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("followLogFile", () => {
  it("watches the native canonical directory when following an aliased path", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-logs-alias-test-"));
    const directory = path.join(root, "logs");
    const alias = path.join(root, "alias");
    const controller = new AbortController();
    let following: Promise<void> | undefined;
    try {
      fs.mkdirSync(directory);
      fs.symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
      const watch = t.mock.method(fs, "watch");
      let output = "";
      following = followLogFile(path.join(alias, "follow.log"), {
        signal: controller.signal,
        onChunk: (chunk) => {
          output += chunk.toString("utf8");
        },
      });
      assert.equal(watch.mock.callCount(), 1);
      assert.equal(watch.mock.calls[0]?.arguments[0], fs.realpathSync.native(directory));
      fs.writeFileSync(path.join(directory, "follow.log"), "created through alias\n");
      await waitFor(() => output === "created through alias\n");
    } finally {
      controller.abort();
      await following;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits for creation, follows append/truncate/rotation, and stops cleanly", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-logs-follow-test-"));
    const file = path.join(root, "logs", "follow.log");
    const controller = new AbortController();
    let output = "";
    const following = followLogFile(file, {
      signal: controller.signal,
      pollMs: 10,
      onChunk: (chunk) => {
        output += chunk.toString("utf8");
      },
    });

    try {
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, "created\n");
      await waitFor(() => output.includes("created\n"));

      const appendStart = output.length;
      fs.appendFileSync(file, "appended\n");
      await waitFor(() => output.slice(appendStart).includes("appended\n"));

      const truncateStart = output.length;
      fs.writeFileSync(file, "truncated\n");
      await waitFor(() => output.slice(truncateStart).includes("truncated\n"));

      const rotationStart = output.length;
      fs.renameSync(file, path.join(root, "follow.log.1"));
      fs.writeFileSync(file, "replacement\n");
      await waitFor(() => output.slice(rotationStart).includes("replacement\n"));

      controller.abort();
      await following;
      const stoppedAt = output.length;
      fs.appendFileSync(file, "after-stop\n");
      await delay(50);
      assert.equal(output.length, stoppedAt);
    } finally {
      controller.abort();
      await following;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`removes signal listeners after ${signal} cancellation`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-logs-signals-test-"));
      const previousHome = process.env.SASH_HOME;
      const before = process.listeners(signal);
      process.env.SASH_HOME = root;
      try {
        const following = runLogs({ follow: true });
        await waitFor(() => process.listenerCount(signal) === before.length + 1);
        // Invoke the registered handler directly instead of emitting a process-wide
        // signal: an emitted signal with no matching listener terminates the test
        // process, which is not a risk worth taking inside a shared test runner.
        const registered = process.listeners(signal).find((listener) => !before.includes(listener));
        assert.ok(registered);
        registered.call(process, signal);
        await following;
        assert.equal(process.listenerCount(signal), before.length);
      } finally {
        if (previousHome === undefined) delete process.env.SASH_HOME;
        else process.env.SASH_HOME = previousHome;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
