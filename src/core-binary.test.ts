import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { assertCoreInstallationConsistent } from "./core.js";
import { assertCoreBinaryFile } from "./core-binary.js";
import { readInstallRecord } from "./core-install-record.js";
import { sashLayout } from "./paths.js";

it("accepts legacy Core builds without reading their contents or changing their records", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-core-legacy-"));
  const layout = sashLayout(root);
  fs.mkdirSync(layout.binDir);
  fs.mkdirSync(layout.stateDir);
  fs.writeFileSync(layout.coreExe, "a different official build than today's default");
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    assert.notEqual(String(args[0]), layout.coreExe, "runtime must not hash installed Core bytes");
    return read(...args);
  });
  try {
    for (const digest of [undefined, "old unrelated digest"]) {
      const record = {
        coreVersion: "v1.19.30",
        installedAt: "2026-01-01T00:00:00.000Z",
        ...(digest ? { sha256: digest } : {}),
      };
      const text = JSON.stringify(record);
      fs.writeFileSync(layout.installFile, text);
      assertCoreInstallationConsistent(layout);
      assertCoreBinaryFile(layout.coreExe);
      assert.equal(readInstallRecord(layout)?.coreVersion, record.coreVersion);
      assert.equal(fs.readFileSync(layout.installFile, "utf8"), text);
      assert.equal(fs.existsSync(layout.tempDir), false);
    }
    fs.writeFileSync(layout.coreExe, "");
    assert.throws(() => assertCoreBinaryFile(layout.coreExe), /nonempty/);
    assert.throws(() => assertCoreBinaryFile(layout.binDir), /regular file/);
  } finally {
    assert.equal(
      path.dirname(fs.realpathSync.native(root)).toLowerCase(),
      fs.realpathSync.native(os.tmpdir()).toLowerCase(),
    );
    fs.rmSync(root, { recursive: true, force: true });
  }
});
