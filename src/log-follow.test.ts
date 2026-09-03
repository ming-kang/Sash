import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { boundedLogTailSince, logTailCursor } from "./log-follow.js";

describe("bounded startup log diagnostics", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-log-tail-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports only non-empty lines appended after the cursor", () => {
    const file = path.join(root, "startup.err.log");
    fs.writeFileSync(file, "old failure\n\n");
    const cursor = logTailCursor(file);

    fs.appendFileSync(file, "new failure one\n\nnew failure two\n");

    assert.equal(boundedLogTailSince(file, cursor), "new failure one\nnew failure two");
  });

  it("reads a newly created file from byte zero when the initial path was missing", () => {
    const file = path.join(root, "created.err.log");
    const cursor = logTailCursor(file);
    fs.writeFileSync(file, "first startup failure\n");

    assert.equal(boundedLogTailSince(file, cursor), "first startup failure");
  });

  it("fails soft after replacement, truncation, or disappearance", () => {
    const file = path.join(root, "rotated.err.log");
    fs.writeFileSync(file, "old startup error\n");
    const replacementCursor = logTailCursor(file);
    fs.renameSync(file, `${file}.old`);
    fs.writeFileSync(file, "unrelated replacement error\n");
    assert.equal(boundedLogTailSince(file, replacementCursor), "");

    fs.writeFileSync(file, "a longer prior startup error\n");
    const truncateCursor = logTailCursor(file);
    fs.truncateSync(file, 1);
    assert.equal(boundedLogTailSince(file, truncateCursor), "");

    fs.rmSync(file);
    assert.equal(boundedLogTailSince(file, truncateCursor), "");
  });

  it("bounds an unterminated line and starts at a valid UTF-8 boundary", () => {
    const file = path.join(root, "bounded.err.log");
    fs.writeFileSync(file, "");
    const cursor = logTailCursor(file);
    const appended = "éé\nlast\n";
    fs.appendFileSync(file, appended);

    const utf8Tail = boundedLogTailSince(file, cursor, {
      maxBytes: Buffer.byteLength(appended) - 1,
      maxLines: 2,
    });
    assert.equal(utf8Tail, "é\nlast");
    assert.doesNotMatch(utf8Tail, /�/);

    fs.writeFileSync(file, "");
    const longLineCursor = logTailCursor(file);
    fs.appendFileSync(file, "x".repeat(200_000));
    const bounded = boundedLogTailSince(file, longLineCursor, { maxBytes: 1024 });
    assert.equal(Buffer.byteLength(bounded), 1024);
    assert.equal(bounded, "x".repeat(1024));
  });
});
