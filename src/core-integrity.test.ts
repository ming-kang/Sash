import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { writeInstallRecord } from "./core-install-record.js";
import { assertCoreBinaryDigest, coreBinarySha256 } from "./core-integrity.js";
import { sashLayout } from "./paths.js";
import { CoreSupervisor } from "./supervisor.js";
import { testSettings } from "./test-state.test.js";

it("checks every binary chunk and detects changes at its final byte", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-binary-digest-test-"));
  const file = path.join(root, "core");
  try {
    const bytes = Buffer.alloc(2 * 64 * 1024 + 7, 42);
    bytes[bytes.length - 1] = 19;
    fs.writeFileSync(file, bytes);
    const expected = crypto.hash("sha256", bytes);
    assert.equal(coreBinarySha256(file), expected);
    assert.doesNotThrow(() => assertCoreBinaryDigest(file, expected));
    bytes[bytes.length - 1] = 20;
    fs.writeFileSync(file, bytes);
    assert.throws(() => assertCoreBinaryDigest(file, expected), /SHA-256 mismatch/);
    assert.throws(() => assertCoreBinaryDigest(file, undefined), /not been verified/);
    assert.throws(() => coreBinarySha256(root), /regular file/);
    fs.writeFileSync(file, "");
    assert.throws(() => coreBinarySha256(file), /nonempty/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("blocks the real spawn path when installed bytes no longer match their record", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-spawn-integrity-test-"));
  const layout = sashLayout(root);
  try {
    fs.mkdirSync(layout.binDir);
    fs.mkdirSync(path.dirname(layout.configFile));
    fs.writeFileSync(layout.coreExe, "tampered executable");
    fs.writeFileSync(layout.configFile, "tun: {enable: false}\n");
    writeInstallRecord(
      {
        coreVersion: "v1",
        installedAt: "2026-01-01T00:00:00.000Z",
        sha256: crypto.hash("sha256", "trusted executable"),
      },
      layout,
    );
    const supervisor = new CoreSupervisor({ layout, settings: testSettings });
    await assert.rejects(supervisor.start(), /SHA-256 mismatch/);
    assert.equal(supervisor.isRunning(), false);
    assert.equal(fs.existsSync(layout.pidFile), false);
    assert.equal(fs.existsSync(layout.logsDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
