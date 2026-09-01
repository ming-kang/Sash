import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { atomicWriteFileSync, durableRemoveFileSync, durableRenameSync } from "./fs-atomic.js";

describe("fs-atomic", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-fs-atomic-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  describe("atomicWriteFileSync", () => {
    it("writes string data accurately to target file", () => {
      const target = path.join(tmpDir, "test.txt");
      const content = "Hello, Sash atomic write!";

      atomicWriteFileSync(target, content);

      assert.equal(fs.existsSync(target), true);
      assert.equal(fs.readFileSync(target, "utf8"), content);
    });

    it("writes Buffer data accurately to target file", () => {
      const target = path.join(tmpDir, "binary.dat");
      const buffer = Buffer.from([0x00, 0xff, 0xca, 0xfe, 0xba, 0xbe]);

      atomicWriteFileSync(target, buffer);

      assert.equal(fs.existsSync(target), true);
      assert.deepEqual(fs.readFileSync(target), buffer);
    });

    it("automatically creates non-existent parent directories", () => {
      const nestedTarget = path.join(
        tmpDir,
        "deep",
        "nested",
        "directory",
        "structure",
        "file.json",
      );
      const content = JSON.stringify({ key: "value" });

      assert.equal(fs.existsSync(path.dirname(nestedTarget)), false);

      atomicWriteFileSync(nestedTarget, content);

      assert.equal(fs.existsSync(nestedTarget), true);
      assert.equal(fs.readFileSync(nestedTarget, "utf8"), content);
    });

    it("successfully overwrites existing file on consecutive writes", () => {
      const target = path.join(tmpDir, "overwrite.txt");
      const firstContent = "Initial content";
      const secondContent = "Updated replacement content with extra data";

      atomicWriteFileSync(target, firstContent);
      assert.equal(fs.readFileSync(target, "utf8"), firstContent);

      atomicWriteFileSync(target, secondContent);
      assert.equal(fs.readFileSync(target, "utf8"), secondContent);
    });

    it("cleans up temporary files and leaves only the target file", () => {
      const target = path.join(tmpDir, "clean.txt");
      atomicWriteFileSync(target, "clean data");

      const files = fs.readdirSync(tmpDir);
      assert.equal(files.length, 1);
      assert.equal(files[0], "clean.txt");
    });
  });

  describe("durableRenameSync", () => {
    it("publishes a file under its destination name", () => {
      const source = path.join(tmpDir, "source.bin");
      const destination = path.join(tmpDir, "destination.bin");
      fs.writeFileSync(source, "binary");

      durableRenameSync(source, destination);

      assert.equal(fs.existsSync(source), false);
      assert.equal(fs.readFileSync(destination, "utf8"), "binary");
    });
  });

  describe("durableRemoveFileSync", () => {
    it("removes a file and tolerates an already absent target", () => {
      const target = path.join(tmpDir, "remove.txt");
      fs.writeFileSync(target, "data");

      durableRemoveFileSync(target);
      durableRemoveFileSync(target);

      assert.equal(fs.existsSync(target), false);
    });
  });
});
