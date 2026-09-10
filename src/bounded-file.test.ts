import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { readBoundedFile, readBoundedJsonFile } from "./bounded-file.js";

it("bounds reads and reports unreadable files with their path", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-bounded-read-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "state.json");
  fs.writeFileSync(file, '{"value":42}');
  assert.deepEqual(readBoundedJsonFile(file, 32), { value: 42 });
  assert.throws(() => readBoundedFile(file, 4), /read limit/);
  assert.throws(() => readBoundedFile(path.join(root, "missing.json"), 32), /ENOENT/);
  fs.writeFileSync(file, "not json");
  assert.throws(() => readBoundedJsonFile(file, 32), /Invalid JSON file/);
  fs.unlinkSync(file);
});
