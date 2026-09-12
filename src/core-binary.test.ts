import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { assertCoreBinaryFile } from "./core.js";

it("requires a nonempty regular Core file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-core-file-"));
  const file = path.join(root, "core");
  try {
    fs.writeFileSync(file, "Core executable");
    assertCoreBinaryFile(file);
    fs.writeFileSync(file, "");
    assert.throws(() => assertCoreBinaryFile(file), /nonempty/);
    assert.throws(() => assertCoreBinaryFile(root), /regular file/);
  } finally {
    assert.equal(
      path.dirname(fs.realpathSync.native(root)).toLowerCase(),
      fs.realpathSync.native(os.tmpdir()).toLowerCase(),
    );
    fs.rmSync(root, { recursive: true, force: true });
  }
});
