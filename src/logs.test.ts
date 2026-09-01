import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { LOG_FOLLOW_CHUNK_BYTES, normalizeLines, readLogGrowth } from "./commands/logs.js";

describe("normalizeLines", () => {
  it("keeps positive integers", () => {
    assert.equal(normalizeLines(1), 1);
    assert.equal(normalizeLines(50), 50);
    assert.equal(normalizeLines(9999), 9999);
  });

  it("falls back for invalid input", () => {
    for (const bad of [Number.NaN, 0, -5, Infinity, -Infinity, 3.14, "100", null, undefined, {}]) {
      assert.equal(normalizeLines(bad), 50, JSON.stringify(bad));
    }
  });

  it("honours a custom fallback", () => {
    assert.equal(normalizeLines(Number.NaN, 10), 10);
    assert.equal(normalizeLines(5, 10), 5);
  });

  it("reads followed growth in capped chunks and resets after truncation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-logs-test-"));
    const file = path.join(root, "follow.log");
    try {
      fs.writeFileSync(file, "before\n");
      const offset = fs.statSync(file).size;
      const appended = "x".repeat(LOG_FOLLOW_CHUNK_BYTES * 2 + 1);
      fs.appendFileSync(file, appended);

      const chunks: Buffer[] = [];
      let growth = readLogGrowth(file, offset);
      while (growth.chunks.length > 0) {
        assert.ok(growth.chunks.every((chunk) => chunk.length <= LOG_FOLLOW_CHUNK_BYTES));
        chunks.push(...growth.chunks);
        growth = readLogGrowth(file, growth.offset);
      }
      assert.equal(Buffer.concat(chunks).toString("utf8"), appended);

      fs.writeFileSync(file, "rotated\n");
      const rotated = readLogGrowth(file, growth.offset);
      assert.equal(Buffer.concat(rotated.chunks).toString("utf8"), "rotated\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
