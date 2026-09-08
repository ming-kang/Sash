import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readInstallRecord } from "./core-install-record.js";
import { ensureCoreIntegrityRecords } from "./core-install-verification.js";
import { recoverCoreUpdateTransaction } from "./core-update.js";
import { type SashLayout, sashLayout } from "./paths.js";

describe("existing Core integrity records", () => {
  let layout: SashLayout;
  let requests: string[];
  const legacy = (coreVersion: string) => ({
    coreVersion,
    installedAt: "2026-01-01T00:00:00.000Z",
  });
  beforeEach(() => {
    layout = sashLayout(fs.mkdtempSync(path.join(os.tmpdir(), "sash-core-integrity-test-")));
    fs.mkdirSync(layout.binDir);
    fs.mkdirSync(layout.stateDir);
    fs.mkdirSync(layout.tempDir);
    fs.writeFileSync(layout.coreExe, "v1-core");
    fs.writeFileSync(layout.installFile, JSON.stringify(legacy("v1")));
    requests = [];
  });
  afterEach(() => fs.rmSync(layout.root, { recursive: true, force: true }));
  async function stage(version: string) {
    requests.push(version);
    const directory = fs.mkdtempSync(path.join(layout.tempDir, "official-"));
    const exe = path.join(directory, "candidate");
    const content = `${version}-core`;
    fs.writeFileSync(exe, content);
    return { exe, version, sha256: crypto.hash("sha256", content) };
  }

  it("authenticates an existing executable once and preserves its version and timestamp", async () => {
    await ensureCoreIntegrityRecords(layout, stage);
    assert.deepEqual(readInstallRecord(layout), {
      ...legacy("v1"),
      sha256: crypto.hash("sha256", "v1-core"),
    });
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
    await ensureCoreIntegrityRecords(layout, stage);
    assert.deepEqual(requests, ["v1"]);
    assert.deepEqual(fs.readdirSync(layout.tempDir), []);
  });

  it("never blesses local bytes which differ from the official artifact", async () => {
    fs.writeFileSync(layout.coreExe, "v1-core altered locally");
    const before = fs.readFileSync(layout.installFile, "utf8");
    await assert.rejects(ensureCoreIntegrityRecords(layout, stage), /SHA-256 mismatch/);
    assert.equal(fs.readFileSync(layout.installFile, "utf8"), before);
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core altered locally");
    assert.deepEqual(fs.readdirSync(layout.tempDir), []);
  });

  it("leaves existing metadata unchanged when the official lookup fails or is cancelled", async () => {
    const before = fs.readFileSync(layout.installFile, "utf8");
    await assert.rejects(
      ensureCoreIntegrityRecords(layout, async () => {
        throw new Error("offline");
      }),
      /offline/,
    );
    const controller = new AbortController();
    const reason = new Error("cancel integrity verification");
    await assert.rejects(
      ensureCoreIntegrityRecords(
        layout,
        async (version) => {
          const candidate = await stage(version);
          controller.abort(reason);
          return candidate;
        },
        controller.signal,
      ),
      (error) => error === reason,
    );
    assert.equal(fs.readFileSync(layout.installFile, "utf8"), before);
    assert.deepEqual(fs.readdirSync(layout.tempDir), []);
  });

  it("does not overwrite metadata changed during an official lookup", async () => {
    const changed = JSON.stringify(legacy("v3"));
    await assert.rejects(
      ensureCoreIntegrityRecords(layout, async (version) => {
        const candidate = await stage(version);
        fs.writeFileSync(layout.installFile, changed);
        return candidate;
      }),
      /metadata changed/,
    );
    assert.equal(fs.readFileSync(layout.installFile, "utf8"), changed);
  });

  it("authenticates both records before recovering an existing interrupted update", async () => {
    fs.renameSync(layout.coreExe, `${layout.coreExe}.bak`);
    fs.writeFileSync(layout.coreExe, "v2-core");
    fs.writeFileSync(layout.installFile, JSON.stringify(legacy("v2")));
    fs.writeFileSync(
      layout.coreUpdateTransactionFile,
      JSON.stringify({
        version: 1,
        phase: "swapped",
        previous: legacy("v1"),
        target: legacy("v2"),
      }),
    );
    await ensureCoreIntegrityRecords(layout, stage);
    recoverCoreUpdateTransaction(layout);
    assert.deepEqual(requests.sort(), ["v1", "v2"]);
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
    assert.equal(readInstallRecord(layout)?.sha256, crypto.hash("sha256", "v1-core"));
    assert.equal(fs.existsSync(layout.coreUpdateTransactionFile), false);
  });
});
